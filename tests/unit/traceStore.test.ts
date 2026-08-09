/**
 * 单元测试: TraceStore L4 trace 持久化与失败模式聚类
 * 验证：record/查询往返、聚类（count >= minCount 命中）、迁移幂等、失败静默
 * 注意：Windows 上 sqlite 句柄不释放会导致 rm EBUSY，所有用例必须 finally close
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { rmSync } from 'fs'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { EvidenceResult } from '../../src/agent/EvidenceGate'
import { type LoopTraceRecord, TraceStore } from '../../src/memory/TraceStore'

/** Windows 上 WAL 模式 close 后文件短暂锁定，删除失败不阻塞测试（与 memoryStore.test 同模式） */
function safeRm(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    // EBUSY：WAL 句柄延迟释放，忽略
  }
}

function makeTrace(overrides: Partial<LoopTraceRecord> = {}): LoopTraceRecord {
  return {
    loopName: 'main',
    kind: 'exec',
    round: 1,
    iterations: 5,
    evidencePassed: true,
    evidence: [],
    verifyPass: true,
    verifyFailures: 0,
    cost: 0.01,
    createdAt: Date.now(),
    ...overrides,
  }
}

function failEvidence(gate: 'lint' | 'typecheck' | 'test'): EvidenceResult[] {
  return [
    {
      gate,
      command: `bun run ${gate}`,
      exitCode: 1,
      passed: false,
      skipped: false,
      output: 'FAIL',
    },
  ]
}

/** 确保 store 在断言后（无论成败）关闭，释放 sqlite 句柄 */
function withStore<T>(tempDir: string, fn: (store: TraceStore) => T): T {
  const store = new TraceStore(tempDir)
  try {
    return fn(store)
  } finally {
    store.close()
  }
}

describe('TraceStore 持久化', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'nexus-tracestore-'))
  })

  afterEach(async () => {
    safeRm(tempDir)
  })

  it('record 后 recentTraces 往返一致', () => {
    withStore(tempDir, (store) => {
      const evidence = failEvidence('test')
      store.record(
        makeTrace({
          loopName: 'ci-triage',
          kind: 'loop',
          round: 3,
          iterations: 12,
          evidencePassed: false,
          evidence,
          verifyPass: null,
          verifyFailures: 0,
          cost: 0.05,
        }),
      )
      const traces = store.recentTraces()
      expect(traces).toHaveLength(1)
      const t = traces[0]
      expect(t.loopName).toBe('ci-triage')
      expect(t.kind).toBe('loop')
      expect(t.round).toBe(3)
      expect(t.iterations).toBe(12)
      expect(t.evidencePassed).toBe(false)
      expect(t.evidence).toEqual(evidence)
      expect(t.verifyPass).toBeNull()
      expect(t.cost).toBeCloseTo(0.05)
    })
  })

  it('迁移幂等：重复构造不报错、表结构稳定', () => {
    const store1 = new TraceStore(tempDir)
    store1.record(makeTrace())
    store1.close()
    withStore(tempDir, (store2) => {
      store2.record(makeTrace({ round: 2 }))
      expect(store2.recentTraces()).toHaveLength(2)
    })
  })

  it('空库：recentTraces 返回 []，failurePatterns 返回 []', () => {
    withStore(tempDir, (store) => {
      expect(store.recentTraces()).toEqual([])
      expect(store.failurePatterns()).toEqual([])
    })
  })
})

describe('TraceStore 失败模式聚类', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'nexus-tracepattern-'))
  })

  afterEach(async () => {
    safeRm(tempDir)
  })

  it('同 loop 同失败类型 3 次 → count=3 命中', () => {
    withStore(tempDir, (store) => {
      for (let i = 0; i < 3; i++) {
        store.record(
          makeTrace({
            loopName: 'ci-triage',
            evidencePassed: false,
            evidence: failEvidence('test'),
            verifyPass: false,
            verifyFailures: 1,
          }),
        )
      }
      const patterns = store.failurePatterns()
      expect(patterns).toHaveLength(1)
      expect(patterns[0].loopName).toBe('ci-triage')
      expect(patterns[0].pattern).toBe('evidence: test 失败')
      expect(patterns[0].count).toBe(3)
    })
  })

  it('count < minCount 不返回（防偶发噪音）', () => {
    withStore(tempDir, (store) => {
      for (let i = 0; i < 2; i++) {
        store.record(makeTrace({ evidencePassed: false, evidence: failEvidence('lint') }))
      }
      expect(store.failurePatterns()).toEqual([])
      // minCount=2 时命中
      expect(store.failurePatterns(2)).toHaveLength(1)
    })
  })

  it('验证失败模式（无证据失败时）→ "验证 N 项未完成"', () => {
    withStore(tempDir, (store) => {
      for (let i = 0; i < 3; i++) {
        store.record(
          makeTrace({
            evidencePassed: true,
            evidence: [],
            verifyPass: false,
            verifyFailures: 2,
          }),
        )
      }
      const patterns = store.failurePatterns()
      expect(patterns[0].pattern).toBe('验证 2 项未完成')
    })
  })

  it('不同 loop 的失败模式独立聚类', () => {
    withStore(tempDir, (store) => {
      for (let i = 0; i < 3; i++) {
        store.record(
          makeTrace({ loopName: 'a', evidencePassed: false, evidence: failEvidence('test') }),
        )
        store.record(
          makeTrace({ loopName: 'b', evidencePassed: false, evidence: failEvidence('lint') }),
        )
      }
      const patterns = store.failurePatterns()
      expect(patterns).toHaveLength(2)
      expect(patterns.map((p) => `${p.loopName}:${p.pattern}`).sort()).toEqual([
        'a:evidence: test 失败',
        'b:evidence: lint 失败',
      ])
    })
  })
})

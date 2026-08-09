/**
 * 单元测试: LearningManager L4 trace 消费（失败模式 → 模板化教训）
 * 验证：高频失败模式生成教训、等价教训去重、零 LLM 成本（不调 Reflector）
 * 注意：Windows 上 sqlite 句柄不释放会导致 rm EBUSY，所有用例必须 finally close
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { rmSync } from 'fs'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { EvidenceResult } from '../../src/agent/EvidenceGate'
import { LearningManager } from '../../src/agent/LearningManager'
import { type LoopTraceRecord, TraceStore } from '../../src/memory/TraceStore'

/** Windows 上 WAL 模式 close 后文件短暂锁定，删除失败不阻塞测试（与 memoryStore.test 同模式） */
function safeRm(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    // EBUSY：WAL 句柄延迟释放，忽略
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

function trace(
  loopName: string,
  gate: 'lint' | 'typecheck' | 'test',
  round: number,
): LoopTraceRecord {
  return {
    loopName,
    kind: 'loop',
    round,
    iterations: 0,
    evidencePassed: false,
    evidence: failEvidence(gate),
    verifyPass: null,
    verifyFailures: 0,
    cost: 0.01,
    createdAt: Date.now(),
  }
}

/** 确保 lm 在断言后（无论成败）关闭，释放 sqlite 句柄 */
function withLearningManager<T>(tempDir: string, fn: (lm: LearningManager) => T): T {
  const lm = new LearningManager()
  lm.init(tempDir)
  try {
    return fn(lm)
  } finally {
    lm.close()
  }
}

describe('LearningManager.consumeLoopTraces', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'nexus-learn-trace-'))
  })

  afterEach(async () => {
    safeRm(tempDir)
  })

  it('高频失败模式（count>=3）→ 生成一条模板化教训', () => {
    withLearningManager(tempDir, (lm) => {
      const store = new TraceStore(tempDir)
      try {
        for (let i = 0; i < 3; i++) store.record(trace('ci-triage', 'test', i + 1))
        const result = lm.consumeLoopTraces()
        expect(result.patterns).toHaveLength(1)
        expect(result.newLessons).toBe(1)
        expect(lm.listMemory()).toContain('[循环] ci-triage: evidence: test 失败')
      } finally {
        store.close()
      }
    })
  })

  it('等价教训去重：二次 consume 不再生成', () => {
    withLearningManager(tempDir, (lm) => {
      const store = new TraceStore(tempDir)
      try {
        for (let i = 0; i < 3; i++) store.record(trace('ci-triage', 'lint', i + 1))
        expect(lm.consumeLoopTraces().newLessons).toBe(1)
        expect(lm.consumeLoopTraces().newLessons).toBe(0) // 已有等价教训
      } finally {
        store.close()
      }
    })
  })

  it('count < 3 不生成（防偶发噪音）', () => {
    withLearningManager(tempDir, (lm) => {
      const store = new TraceStore(tempDir)
      try {
        for (let i = 0; i < 2; i++) store.record(trace('ci-triage', 'test', i + 1))
        const result = lm.consumeLoopTraces()
        expect(result.patterns).toEqual([])
        expect(result.newLessons).toBe(0)
      } finally {
        store.close()
      }
    })
  })

  it('学习系统不可用（未 init）时静默返回空', () => {
    const lm = new LearningManager()
    const result = lm.consumeLoopTraces()
    expect(result).toEqual({ patterns: [], newLessons: 0 })
  })
})

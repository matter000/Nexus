/**
 * TraceStore —— L4 trace 驱动自改进存储层（loop_traces 表，2026-08）
 *
 * 持久化循环执行轨迹（exec/goal/loop/automations 每轮一行），
 * 支持失败模式聚类（按 loop_name + 失败类型聚合，供教训提炼消费）。
 *
 * 沿用 MemoryStore 模式：独立打开 .nexus/nexus.db（WAL 支持多连接），
 * 构造时运行迁移确保 loop_traces 表存在；所有失败静默（学习系统旁路原则）。
 */

import { Database } from 'bun:sqlite'
import { mkdirSync } from 'fs'
import { join } from 'path'
import type { EvidenceResult } from '../agent/EvidenceGate'
import { runMigrations } from '../storage/migrations'

/** 单轮循环执行轨迹（写入 loop_traces 表） */
export interface LoopTraceRecord {
  loopName: string
  /** exec = 单次 execute 循环；goal = /goal 目标驱动轮；loop = /loop 节拍轮 */
  kind: 'exec' | 'goal' | 'loop'
  round: number
  iterations: number
  evidencePassed: boolean | null
  evidence: EvidenceResult[]
  verifyPass: boolean | null
  verifyFailures: number
  cost: number
  createdAt: number
}

/** 失败模式聚类结果 */
export interface FailurePattern {
  loopName: string
  pattern: string
  count: number
}

interface TraceRow {
  loop_name: string
  kind: string
  round: number
  iterations: number
  evidence_passed: number | null
  evidence: string | null
  verify_pass: number | null
  verify_failures: number
  cost: number
  created_at: number
}

/** 从证据明细推导失败类型（"evidence: test 失败" 等） */
function deriveFailurePattern(
  evidencePassed: boolean | null,
  evidence: EvidenceResult[],
  verifyPass: boolean | null,
  verifyFailures: number,
): string | null {
  const failedGates = evidence.filter((r) => !r.skipped && !r.passed).map((r) => r.gate)
  if (failedGates.length > 0) {
    return `evidence: ${failedGates.join(',')} 失败`
  }
  if (verifyPass === false) {
    return `验证 ${verifyFailures} 项未完成`
  }
  if (evidencePassed === false) {
    return 'evidence: 门禁未通过'
  }
  return null
}

export class TraceStore {
  private db: Database
  private dbPath: string

  constructor(projectRoot: string) {
    const nexusDir = join(projectRoot, '.nexus')
    mkdirSync(nexusDir, { recursive: true })
    this.dbPath = join(nexusDir, 'nexus.db')
    this.db = new Database(this.dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    runMigrations(this.db)
  }

  /** 写入一轮 trace（失败静默，不阻塞主流程） */
  record(trace: LoopTraceRecord): void {
    try {
      this.db
        .prepare(
          `INSERT INTO loop_traces
            (loop_name, kind, round, iterations, evidence_passed, evidence, verify_pass, verify_failures, cost, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          trace.loopName,
          trace.kind,
          trace.round,
          trace.iterations,
          trace.evidencePassed === null ? null : trace.evidencePassed ? 1 : 0,
          trace.evidence.length > 0 ? JSON.stringify(trace.evidence) : null,
          trace.verifyPass === null ? null : trace.verifyPass ? 1 : 0,
          trace.verifyFailures,
          trace.cost,
          trace.createdAt,
        )
    } catch (err) {
      console.warn('[TraceStore] 记录 loop trace 失败:', err)
    }
  }

  /**
   * 失败模式聚类：按 loop_name + 失败类型聚合，
   * count >= minCount 才返回（防单次偶发噪音）。
   */
  failurePatterns(minCount = 3, limit = 10): FailurePattern[] {
    try {
      const rows = this.db
        .prepare(
          `SELECT loop_name, kind, evidence_passed, evidence, verify_pass, verify_failures
           FROM loop_traces ORDER BY created_at DESC LIMIT 500`,
        )
        .all() as Array<{
        loop_name: string
        kind: string
        evidence_passed: number | null
        evidence: string | null
        verify_pass: number | null
        verify_failures: number
      }>

      const counts = new Map<string, { loopName: string; pattern: string; count: number }>()
      for (const row of rows) {
        let evidence: EvidenceResult[] = []
        if (row.evidence) {
          try {
            evidence = JSON.parse(row.evidence) as EvidenceResult[]
          } catch {
            evidence = []
          }
        }
        const pattern = deriveFailurePattern(
          row.evidence_passed === null ? null : row.evidence_passed === 1,
          evidence,
          row.verify_pass === null ? null : row.verify_pass === 1,
          row.verify_failures,
        )
        if (!pattern) continue
        const key = `${row.loop_name}|${pattern}`
        const existing = counts.get(key)
        if (existing) {
          existing.count++
        } else {
          counts.set(key, { loopName: row.loop_name, pattern, count: 1 })
        }
      }

      return [...counts.values()]
        .filter((c) => c.count >= minCount)
        .sort((a, b) => b.count - a.count)
        .slice(0, limit)
    } catch (err) {
      console.warn('[TraceStore] 失败模式聚类失败:', err)
      return []
    }
  }

  /** 最近 N 条 trace（观测/调试用） */
  recentTraces(limit = 20): LoopTraceRecord[] {
    try {
      const rows = this.db
        .prepare(
          `SELECT loop_name, kind, round, iterations, evidence_passed, evidence, verify_pass, verify_failures, cost, created_at
           FROM loop_traces ORDER BY created_at DESC LIMIT ?`,
        )
        .all(limit) as unknown as TraceRow[]
      return rows.map((r) => ({
        loopName: r.loop_name,
        kind: r.kind as LoopTraceRecord['kind'],
        round: r.round,
        iterations: r.iterations,
        evidencePassed: r.evidence_passed === null ? null : r.evidence_passed === 1,
        evidence: r.evidence ? (JSON.parse(r.evidence) as EvidenceResult[]) : [],
        verifyPass: r.verify_pass === null ? null : r.verify_pass === 1,
        verifyFailures: r.verify_failures,
        cost: r.cost,
        createdAt: r.created_at,
      }))
    } catch (err) {
      console.warn('[TraceStore] 读取 trace 失败:', err)
      return []
    }
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      // 关闭失败静默
    }
  }
}

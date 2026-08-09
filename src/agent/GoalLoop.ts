/**
 * GoalLoop —— L3 事件驱动循环：/goal 目标驱动（2026-08 深度适配）
 *
 * 对应 Claude Code /goal 原语（2026-03 产品化）：给定可验证条件，
 * Agent 反复执行直到满足，独立模型每轮判定。
 *
 * 与 Orchestrator 自动修复（单次 execute 内闭环，maxAutoRetries）的差异：
 * /goal 是多次 execute 之间的循环——验收未过时整个任务重跑（携带上一轮
 * 失败摘要作为上下文），适合"目标整体未达成"场景。
 *
 * 验收判定（用户决策：门禁优先 + verifier 兜底）：
 * 1. acceptance 命中确定性映射（"测试"→test gate 等）且该 gate 非 skipped
 *    → 以该门禁全绿为准（证据优先）
 * 2. 未命中映射或无证据命令 → 任一确定性失败（非 skipped）即拦截未达成，
 *    verifier 语义判定兜底（延续"证据优先"铁律：写代码的 Agent 不能自判完成）
 *
 * 护栏：maxRounds（默认 5）+ maxCost（默认 $2，与 max_session_cost 取小）
 *       + abortSignal（Ctrl+C 立即退出）
 */

import type { EvidenceResult } from './EvidenceGate'
import type { NexusEvent } from './types'

/** 最近一次执行的关键信号（Orchestrator.getLastExecutionSignals 返回） */
export interface ExecutionSignals {
  /** 证据门禁是否通过（全部 skipped 视为通过；未运行时为 null） */
  evidencePassed: boolean | null
  /** 证据门禁摘要（人类可读，如 "lint: 通过 / test: 失败"） */
  evidenceSummary: string
  /** 证据门禁明细（供门禁映射判定） */
  evidence: EvidenceResult[]
  /** 验证结论（未运行验证时为 null） */
  verifyPass: boolean | null
  /** 执行错误（null = 无错误） */
  executionError: string | null
}

export interface GoalLoopConfig {
  /** 目标描述（用户自然语言） */
  goal: string
  /** 验收条件文本（默认同 goal）；用于门禁映射 */
  acceptance?: string
  /** 最大轮次（默认 5）；每轮 = 1 次完整 submit */
  maxRounds?: number
  /** 轮次成本上限（默认 $2）；与 sessionMaxCost 取小 */
  maxCost?: number
  /** 会话成本上限（config.limits.maxSessionCost） */
  sessionMaxCost: number
  /** 执行一轮（Orchestrator.submit） */
  submit: (input: string) => Promise<string>
  /** 当前累计成本 */
  getTotalCost: () => number
  /** 上一轮执行信号（Orchestrator.getLastExecutionSignals） */
  getLastSignals: () => ExecutionSignals
  abortSignal?: AbortSignal
  onEvent: (event: NexusEvent) => void
}

/** 单轮循环摘要（供循环报告与观测） */
export interface GoalLoopRoundSummary {
  round: number
  evidencePassed: boolean | null
  verifyPass: boolean | null
  cost: number
}

export interface GoalLoopResult {
  achieved: boolean
  rounds: number
  roundSummaries: GoalLoopRoundSummary[]
}

/**
 * 验收条件 → 证据门禁映射（门禁优先判定入口）。
 * 命中规则按常见度排序：测试 > 类型检查 > lint。
 */
export function mapAcceptanceToGate(acceptance: string): 'lint' | 'typecheck' | 'test' | null {
  const text = acceptance.toLowerCase()
  if (/(测试|test)/.test(text)) return 'test'
  if (/(类型|typecheck|type-check|tsc)/.test(text)) return 'typecheck'
  if (/(lint|eslint)/.test(text)) return 'lint'
  return null
}

export class GoalLoop {
  private readonly config: GoalLoopConfig

  constructor(config: GoalLoopConfig) {
    this.config = config
  }

  /** 运行目标驱动循环，直到验收通过或预算/轮次耗尽 */
  async run(): Promise<GoalLoopResult> {
    const maxRounds = Math.max(1, this.config.maxRounds ?? 5)
    const maxCost = Math.min(
      this.config.maxCost ?? 2,
      this.config.sessionMaxCost > 0 ? this.config.sessionMaxCost : 2,
    )
    const gate = mapAcceptanceToGate(this.config.acceptance ?? this.config.goal)
    const roundSummaries: GoalLoopRoundSummary[] = []
    let achieved = false

    for (let round = 1; round <= maxRounds; round++) {
      if (this.config.abortSignal?.aborted) {
        this.config.onEvent({ type: 'system_info', message: '/goal 已中断' })
        break
      }
      if (this.config.getTotalCost() >= maxCost) {
        this.config.onEvent({
          type: 'system_info',
          message: `/goal 成本已达上限 ($${maxCost.toFixed(2)})，停止`,
        })
        break
      }

      const costBefore = this.config.getTotalCost()
      this.config.onEvent({
        type: 'system_info',
        message: `/goal 第 ${round}/${maxRounds} 轮开始${gate ? `（验收门禁: ${gate}）` : '（验收: verifier 判定）'}...`,
      })

      let roundFailed = false
      try {
        await this.config.submit(this.buildRoundPrompt(round))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this.config.onEvent({
          type: 'error',
          message: `/goal 第 ${round} 轮执行失败: ${msg}`,
          recoverable: true,
        })
        roundFailed = true
      }
      const costAfter = this.config.getTotalCost()
      const signals = this.config.getLastSignals()

      roundSummaries.push({
        round,
        evidencePassed: signals.evidencePassed,
        verifyPass: signals.verifyPass,
        cost: costAfter - costBefore,
      })

      if (roundFailed) break
      if (this.evaluate(signals, gate)) {
        achieved = true
        this.config.onEvent({ type: 'system_info', message: `/goal 验收通过（第 ${round} 轮）` })
        break
      }
      this.config.onEvent({
        type: 'system_info',
        message: `/goal 第 ${round} 轮未达验收条件，${
          round < maxRounds ? '进入下一轮' : '已耗尽轮次预算'
        }`,
      })
    }

    return { achieved, rounds: roundSummaries.length, roundSummaries }
  }

  /** 组装每轮提交文本：首轮纯目标，后续携带上一轮信号摘要（紧凑可操作的反馈） */
  private buildRoundPrompt(round: number): string {
    if (round === 1) return this.config.goal
    const prev = this.config.getLastSignals()
    const feedback = [
      `[上一轮结果（第 ${round - 1} 轮）]`,
      `证据门禁: ${prev.evidenceSummary || '（未运行）'}`,
      `验证结论: ${prev.verifyPass === null ? '未运行' : prev.verifyPass ? '通过' : '未通过'}`,
      prev.executionError ? `执行错误: ${prev.executionError.slice(0, 300)}` : '',
    ]
      .filter((l) => l.length > 0)
      .join('\n')
    return `${this.config.goal}\n\n${feedback}\n\n请继续完成目标；上一轮已完成的成果可复用，不要重复无用功。`
  }

  /**
   * 验收判定（门禁优先 + verifier 兜底）：
   * 1. 映射命中的门禁非 skipped → 以该门禁确定性结果为准
   * 2. 无映射/门禁不可用 → 任一确定性失败即未达成，verifier 语义判定兜底
   */
  private evaluate(signals: ExecutionSignals, gate: 'lint' | 'typecheck' | 'test' | null): boolean {
    if (gate) {
      const target = signals.evidence.find((r) => r.gate === gate)
      if (target && !target.skipped) {
        return target.passed && signals.executionError === null
      }
    }
    // 确定性失败（证据优先铁律：任何非 skipped 失败 = 未完成）
    if (signals.evidence.some((r) => !r.skipped && !r.passed)) return false
    if (signals.verifyPass === false) return false
    if (signals.executionError !== null) return false
    return true
  }
}

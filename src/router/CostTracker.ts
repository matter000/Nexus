/**
 * 成本追踪器
 * 每次调用记录 token 数和估算成本,会话结束显示总花费
 */

import type { CostRecord, ModelRole, ProviderName } from '../agent/types'

export class CostTracker {
  private records: CostRecord[] = []
  private totalInputTokens = 0
  private totalOutputTokens = 0
  private totalCost = 0

  /** 记录一次 LLM 调用 */
  record(params: {
    role: ModelRole
    provider: ProviderName
    model: string
    inputTokens: number
    outputTokens: number
    costPer1kInput: number
    costPer1kOutput: number
  }): void {
    const cost =
      (params.inputTokens / 1000) * params.costPer1kInput +
      (params.outputTokens / 1000) * params.costPer1kOutput

    const record: CostRecord = {
      timestamp: Date.now(),
      role: params.role,
      provider: params.provider,
      model: params.model,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      cost,
    }

    this.records.push(record)
    this.totalInputTokens += params.inputTokens
    this.totalOutputTokens += params.outputTokens
    this.totalCost += cost
  }

  /** 获取总花费 */
  getTotalCost(): number {
    return this.totalCost
  }

  /** 获取总 token 数 */
  getTotalTokens(): { input: number; output: number; total: number } {
    return {
      input: this.totalInputTokens,
      output: this.totalOutputTokens,
      total: this.totalInputTokens + this.totalOutputTokens,
    }
  }

  /** 获取摘要信息 */
  getSummary(): string {
    const tokens = this.getTotalTokens()
    return `$${this.totalCost.toFixed(4)} (${tokens.input} in / ${tokens.output} out)`
  }

  /** 按角色分组统计 */
  getByRole(): Record<string, { calls: number; cost: number; tokens: number }> {
    const grouped: Record<string, { calls: number; cost: number; tokens: number }> = {}
    for (const record of this.records) {
      if (!grouped[record.role]) {
        grouped[record.role] = { calls: 0, cost: 0, tokens: 0 }
      }
      grouped[record.role].calls++
      grouped[record.role].cost += record.cost
      grouped[record.role].tokens += record.inputTokens + record.outputTokens
    }
    return grouped
  }

  /** 检查是否超过会话成本上限 */
  isOverBudget(maxCost: number): boolean {
    return this.totalCost >= maxCost
  }

  /** 获取所有记录 */
  getRecords(): CostRecord[] {
    return [...this.records]
  }

  /** 重置 */
  reset(): void {
    this.records = []
    this.totalInputTokens = 0
    this.totalOutputTokens = 0
    this.totalCost = 0
  }
}

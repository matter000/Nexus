/**
 * 成本追踪器
 * 每次调用记录 token 数和估算成本,会话结束显示总花费
 */

import type { CostRecord, ModelRole } from '../agent/types'

/**
 * DeepSeek 峰谷计价配置（官方 2026-08 预告：北京时间 9-12 / 14-18 点为 2 倍，以本地时区近似）。
 * 可经 env 覆盖：NEXUS_DEEPSEEK_PEAK_MULTIPLIER（默认 2）、NEXUS_DEEPSEEK_PEAK_HOURS（默认 "9-12,14-18"）。
 * 导出为可变对象供测试注入（multiplier=1 或 hours=[] 时退化为原行为）。
 */
export const deepSeekPeakConfig = {
  multiplier: Number.parseFloat(process.env.NEXUS_DEEPSEEK_PEAK_MULTIPLIER ?? '2') || 2,
  hours: (() => {
    const raw = process.env.NEXUS_DEEPSEEK_PEAK_HOURS ?? '9-12,14-18'
    const windows: Array<[number, number]> = []
    for (const part of raw.split(',')) {
      const [s, e] = part.split('-').map((v) => Number.parseInt(v, 10))
      if (Number.isInteger(s) && Number.isInteger(e)) windows.push([s, e])
    }
    return windows
  })(),
}

/** DeepSeek 记录判定（provider 名或模型名前缀） */
function isDeepSeekRecord(provider: string, model: string): boolean {
  return provider === 'deepseek' || model.startsWith('deepseek-')
}

/** 当前本地小时是否落在峰窗内 */
function inPeakWindow(hour: number): boolean {
  return deepSeekPeakConfig.hours.some(([s, e]) => hour >= s && hour < e)
}

export class CostTracker {
  private records: CostRecord[] = []
  private totalInputTokens = 0
  private totalOutputTokens = 0
  private totalCost = 0
  private totalCacheHitTokens = 0
  private totalCacheMissTokens = 0
  private totalReasoningTokens = 0
  /** 缓存命中累计节省的成本（按未命中价 - 命中价的差额估算） */
  private totalCacheSavedCost = 0
  /** 本次会话是否命中过峰谷计价（getSummary 附注用） */
  private peakPricingActive = false

  /** 记录一次 LLM 调用 */
  record(params: {
    role: ModelRole
    provider: string
    model: string
    inputTokens: number
    outputTokens: number
    costPer1kInput: number
    costPer1kOutput: number
    /** 缓存命中输入单价（每 1k）。提供时对缓存命中部分按低价计费（DeepSeek 深度适配） */
    costPer1kInputCached?: number
    /** 缓存命中的 prompt token 数（DeepSeek API 返回） */
    cacheHitTokens?: number
    /** 缓存未命中的 prompt token 数（DeepSeek API 返回） */
    cacheMissTokens?: number
    /** 推理 token 数（DeepSeek 思考模式下产生） */
    reasoningTokens?: number
  }): void {
    // 峰谷计价：DeepSeek 请求落在峰窗内时，输入/输出/缓存命中单价统一乘倍率
    const peak =
      isDeepSeekRecord(params.provider, params.model) &&
      inPeakWindow(new Date().getHours()) &&
      deepSeekPeakConfig.multiplier !== 1 &&
      deepSeekPeakConfig.hours.length > 0
    const inputPrice = params.costPer1kInput * (peak ? deepSeekPeakConfig.multiplier : 1)
    const outputPrice = params.costPer1kOutput * (peak ? deepSeekPeakConfig.multiplier : 1)
    const cachedPriceRaw = params.costPer1kInputCached
    const cachedPrice =
      cachedPriceRaw !== undefined
        ? cachedPriceRaw * (peak ? deepSeekPeakConfig.multiplier : 1)
        : undefined
    if (peak) this.peakPricingActive = true

    // 分级计费：缓存命中部分按命中价，其余输入按未命中价
    // DeepSeek 缓存命中输入价约为未命中价的 1/50~1/120，统一按未命中价会严重高估成本
    const cachedTokens = Math.min(params.cacheHitTokens ?? 0, params.inputTokens)
    const nonCachedInput = params.inputTokens - cachedTokens
    const cost =
      (nonCachedInput / 1000) * inputPrice +
      (cachedTokens / 1000) * (cachedPrice ?? inputPrice) +
      (params.outputTokens / 1000) * outputPrice
    // 缓存节省额：命中部分按未命中价与命中价的差额累计（未提供命中价时为 0）
    const savedCost =
      cachedPrice !== undefined ? (cachedTokens / 1000) * (inputPrice - cachedPrice) : 0

    const record: CostRecord = {
      timestamp: Date.now(),
      role: params.role,
      provider: params.provider,
      model: params.model,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      cost,
      cacheHitTokens: params.cacheHitTokens,
      cacheMissTokens: params.cacheMissTokens,
      reasoningTokens: params.reasoningTokens,
    }

    this.records.push(record)
    this.totalInputTokens += params.inputTokens
    this.totalOutputTokens += params.outputTokens
    this.totalCost += cost
    if (params.cacheHitTokens) this.totalCacheHitTokens += params.cacheHitTokens
    if (params.cacheMissTokens) this.totalCacheMissTokens += params.cacheMissTokens
    if (params.reasoningTokens) this.totalReasoningTokens += params.reasoningTokens
    if (savedCost > 0) this.totalCacheSavedCost += savedCost
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

  /** 获取缓存命中统计 */
  getCacheStats(): { hit: number; miss: number; total: number; hitRate: number } {
    const total = this.totalCacheHitTokens + this.totalCacheMissTokens
    return {
      hit: this.totalCacheHitTokens,
      miss: this.totalCacheMissTokens,
      total,
      hitRate: total > 0 ? this.totalCacheHitTokens / total : 0,
    }
  }

  /** 获取推理 token 统计 */
  getReasoningStats(): { total: number; percentage: number } {
    const totalOutput = this.totalOutputTokens
    return {
      total: this.totalReasoningTokens,
      percentage: totalOutput > 0 ? (this.totalReasoningTokens / totalOutput) * 100 : 0,
    }
  }

  /** 获取缓存节省的成本估算 */
  getCacheSavedCost(): number {
    return this.totalCacheSavedCost
  }

  /** 获取摘要信息 */
  getSummary(): string {
    const tokens = this.getTotalTokens()
    const cache = this.getCacheStats()
    let summary = `$${this.totalCost.toFixed(4)} (${tokens.input} in / ${tokens.output} out)`
    if (cache.total > 0) {
      summary += ` | 缓存命中: ${(cache.hitRate * 100).toFixed(1)}%`
    }
    if (this.totalCacheSavedCost > 0) {
      summary += ` | 缓存节省: $${this.totalCacheSavedCost.toFixed(4)}`
    }
    if (this.totalReasoningTokens > 0) {
      summary += ` | 推理: ${this.totalReasoningTokens} tokens`
    }
    if (this.peakPricingActive) {
      summary += '（峰谷计价已生效）'
    }
    return summary
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
    this.totalCacheHitTokens = 0
    this.totalCacheMissTokens = 0
    this.totalReasoningTokens = 0
    this.totalCacheSavedCost = 0
    this.peakPricingActive = false
  }
}

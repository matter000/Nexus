/**
 * 客户端限流器（DeepSeek 深度适配）
 * 按模型维度的令牌桶，防止并发请求（尤其是 dispatch_subagents 并行子 Agent）
 * 触发 DeepSeek API 的 429 速率限制。
 *
 * - RPM/TPM 数据来自 deepseekErrors.getDeepSeekRateLimit
 * - 模块级单例：所有 Executor/Planner/SubAgent 共享同一配额
 * - 保守策略：预留 20% 余量，避免与服务端统计口径的边界竞争
 */

import { getDeepSeekRateLimit } from './providers/deepseekErrors'

/** 速率限制余量系数：只使用配额的 80%，留出安全边际 */
const SAFETY_FACTOR = 0.8

/** 单个请求的最大等待时间（ms），超过后放行避免死锁 */
const MAX_WAIT_MS = 30_000

interface Bucket {
  /** 桶内剩余令牌数（请求数维度） */
  requestTokens: number
  /** 桶内剩余 token 配额（token 数维度） */
  tokenTokens: number
  /** 上次补充时间戳 */
  lastRefill: number
  /** 每分钟补充的请求数 */
  rpm: number
  /** 每分钟补充的 token 数 */
  tpm: number
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>()
  /** 串行化等待队列，避免并发 acquire 时的计算竞态 */
  private queue: Promise<unknown> = Promise.resolve()
  /** 限流数据源（默认 DeepSeek 官方限额；可注入以便测试） */
  private getLimit: (model: string) => { rpm: number; tpm: number }

  constructor(getLimit?: (model: string) => { rpm: number; tpm: number }) {
    this.getLimit = getLimit ?? getDeepSeekRateLimit
  }

  /**
   * 获取配额。若当前配额不足，等待令牌补充后再返回。
   * @param model 模型名（桶按模型隔离）
   * @param estimatedTokens 本次请求预估消耗的 token 数（输入+输出估算）
   */
  async acquire(model: string, estimatedTokens = 1000): Promise<void> {
    // 串行入队，保证多个并发调用方（含子 Agent）按序计算等待时间
    const task = this.queue.then(() => this.acquireInternal(model, estimatedTokens))
    // 队列不因单个失败阻塞后续请求
    this.queue = task.catch(() => {})
    await task
  }

  private async acquireInternal(model: string, estimatedTokens: number): Promise<void> {
    const bucket = this.getBucket(model)
    const start = Date.now()

    // 循环等待直到两个维度都有足够令牌
    while (true) {
      this.refill(bucket)
      if (bucket.requestTokens >= 1 && bucket.tokenTokens >= estimatedTokens) {
        bucket.requestTokens -= 1
        bucket.tokenTokens -= estimatedTokens
        return
      }
      if (Date.now() - start >= MAX_WAIT_MS) {
        // 超时保护：放行请求，由服务端 429 + 重试兜底
        return
      }
      // 计算最早可补充出足够令牌的等待时间
      const waitRequest =
        bucket.requestTokens < 1 ? ((1 - bucket.requestTokens) / bucket.rpm) * 60_000 : 0
      const waitTokens =
        bucket.tokenTokens < estimatedTokens
          ? ((estimatedTokens - bucket.tokenTokens) / bucket.tpm) * 60_000
          : 0
      const waitMs = Math.min(Math.max(Math.ceil(Math.max(waitRequest, waitTokens)), 50), 5000)
      await new Promise((resolve) => setTimeout(resolve, waitMs))
    }
  }

  private getBucket(model: string): Bucket {
    let bucket = this.buckets.get(model)
    if (!bucket) {
      const limit = this.getLimit(model)
      bucket = {
        requestTokens: limit.rpm * SAFETY_FACTOR,
        tokenTokens: limit.tpm * SAFETY_FACTOR,
        lastRefill: Date.now(),
        rpm: limit.rpm * SAFETY_FACTOR,
        tpm: limit.tpm * SAFETY_FACTOR,
      }
      this.buckets.set(model, bucket)
    }
    return bucket
  }

  /** 按经过时间线性补充令牌（不超过桶容量） */
  private refill(bucket: Bucket): void {
    const now = Date.now()
    const elapsedMin = (now - bucket.lastRefill) / 60_000
    if (elapsedMin <= 0) return
    bucket.lastRefill = now
    const capacityRpm = getCapacity(bucket.rpm)
    const capacityTpm = getCapacity(bucket.tpm)
    bucket.requestTokens = Math.min(capacityRpm, bucket.requestTokens + bucket.rpm * elapsedMin)
    bucket.tokenTokens = Math.min(capacityTpm, bucket.tokenTokens + bucket.tpm * elapsedMin)
  }

  /** 测试辅助：重置所有桶 */
  reset(): void {
    this.buckets.clear()
    this.queue = Promise.resolve()
  }
}

/** 桶容量 = 一分钟的补充量（与 SAFETY_FACTOR 一致，已在初始化时乘入） */
function getCapacity(perMinuteRate: number): number {
  return perMinuteRate
}

/** 模块级单例：所有调用方（含并行子 Agent）共享配额 */
export const globalRateLimiter = new RateLimiter()

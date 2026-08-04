/**
 * 单元测试: RateLimiter 客户端令牌桶限流（DeepSeek 深度适配）
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { globalRateLimiter, RateLimiter } from '../../src/router/RateLimiter'

describe('RateLimiter', () => {
  afterEach(() => {
    globalRateLimiter.reset()
  })

  it('配额充足时 acquire 立即返回', async () => {
    const limiter = new RateLimiter(() => ({ rpm: 1000, tpm: 1_000_000 }))
    const start = Date.now()
    await limiter.acquire('deepseek-v4-flash', 1000)
    expect(Date.now() - start).toBeLessThan(200)
  })

  it('不同模型的桶相互隔离', async () => {
    const limiter = new RateLimiter(() => ({ rpm: 1000, tpm: 1_000_000 }))
    await limiter.acquire('deepseek-v4-flash', 1000)
    const start = Date.now()
    await limiter.acquire('deepseek-v4-pro', 1000)
    expect(Date.now() - start).toBeLessThan(200)
  })

  it('RPM 配额耗尽后等待令牌补充（按注入的小限额验证）', async () => {
    // rpm=60 → 安全系数 0.8 后桶容量 48 个请求，补充速率 48 个/分钟
    const limiter = new RateLimiter(() => ({ rpm: 60, tpm: 100_000_000 }))

    const start = Date.now()
    // 耗尽初始桶容量（48 个请求令牌）
    for (let i = 0; i < 48; i++) {
      await limiter.acquire('deepseek-v4-flash', 1)
    }
    expect(Date.now() - start).toBeLessThan(1000)

    // 第 49 个请求需要等待约 1/48 分钟 ≈ 1250ms 的令牌补充
    const waitStart = Date.now()
    await limiter.acquire('deepseek-v4-flash', 1)
    const elapsed = Date.now() - waitStart
    expect(elapsed).toBeGreaterThanOrEqual(900) // 容忍调度误差
    expect(elapsed).toBeLessThan(10_000)
  })

  it('reset 后桶恢复初始容量', async () => {
    const limiter = new RateLimiter(() => ({ rpm: 60, tpm: 100_000_000 }))
    for (let i = 0; i < 48; i++) {
      await limiter.acquire('deepseek-v4-flash', 1)
    }
    limiter.reset()
    const start = Date.now()
    await limiter.acquire('deepseek-v4-flash', 1)
    expect(Date.now() - start).toBeLessThan(200)
  })

  it('globalRateLimiter 为模块级单例且默认可用', () => {
    expect(globalRateLimiter instanceof RateLimiter).toBe(true)
  })

  it('并发 acquire 串行排队，不超发', async () => {
    // rpm=60 → 桶容量 48；并发 50 个请求时至少 2 个需等待补充
    const limiter = new RateLimiter(() => ({ rpm: 60, tpm: 100_000_000 }))
    const start = Date.now()
    await Promise.all(Array.from({ length: 50 }, () => limiter.acquire('deepseek-v4-flash', 1)))
    const elapsed = Date.now() - start
    // 50 个请求 > 48 容量，整体必然等待过令牌补充
    expect(elapsed).toBeGreaterThanOrEqual(900)
  })
})

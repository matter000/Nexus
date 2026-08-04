/**
 * 单元测试: CostTracker 成本追踪
 */

import { describe, expect, it } from 'bun:test'
import { CostTracker } from '../../src/router/CostTracker'

describe('CostTracker', () => {
  it('初始状态为零', () => {
    const tracker = new CostTracker()
    expect(tracker.getTotalCost()).toBe(0)
    expect(tracker.getTotalTokens().total).toBe(0)
  })

  it('正确记录单次调用', () => {
    const tracker = new CostTracker()
    tracker.record({
      role: 'executor',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      inputTokens: 1000,
      outputTokens: 500,
      costPer1kInput: 0.003,
      costPer1kOutput: 0.015,
    })

    // cost = (1000/1000)*0.003 + (500/1000)*0.015 = 0.003 + 0.0075 = 0.0105
    expect(tracker.getTotalCost()).toBeCloseTo(0.0105)
    expect(tracker.getTotalTokens().input).toBe(1000)
    expect(tracker.getTotalTokens().output).toBe(500)
  })

  it('正确累加多次调用', () => {
    const tracker = new CostTracker()
    tracker.record({
      role: 'planner',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      inputTokens: 2000,
      outputTokens: 1000,
      costPer1kInput: 0.003,
      costPer1kOutput: 0.015,
    })
    tracker.record({
      role: 'executor',
      provider: 'openai',
      model: 'gpt-4o',
      inputTokens: 1000,
      outputTokens: 500,
      costPer1kInput: 0.0025,
      costPer1kOutput: 0.01,
    })

    const tokens = tracker.getTotalTokens()
    expect(tokens.input).toBe(3000)
    expect(tokens.output).toBe(1500)
    expect(tokens.total).toBe(4500)
    expect(tracker.getTotalCost()).toBeGreaterThan(0)
  })

  it('正确判断超预算', () => {
    const tracker = new CostTracker()
    tracker.record({
      role: 'executor',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      inputTokens: 100000,
      outputTokens: 50000,
      costPer1kInput: 0.003,
      costPer1kOutput: 0.015,
    })

    // cost = 100*0.003 + 50*0.015 = 0.3 + 0.75 = 1.05
    expect(tracker.isOverBudget(1.0)).toBe(true)
    expect(tracker.isOverBudget(2.0)).toBe(false)
  })

  it('按角色分组统计', () => {
    const tracker = new CostTracker()
    tracker.record({
      role: 'planner',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      inputTokens: 1000,
      outputTokens: 500,
      costPer1kInput: 0.003,
      costPer1kOutput: 0.015,
    })
    tracker.record({
      role: 'planner',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      inputTokens: 2000,
      outputTokens: 1000,
      costPer1kInput: 0.003,
      costPer1kOutput: 0.015,
    })

    const byRole = tracker.getByRole()
    expect(byRole.planner.calls).toBe(2)
    expect(byRole.planner.tokens).toBe(4500)
  })

  it('重置后归零', () => {
    const tracker = new CostTracker()
    tracker.record({
      role: 'executor',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      inputTokens: 1000,
      outputTokens: 500,
      costPer1kInput: 0.003,
      costPer1kOutput: 0.015,
    })
    tracker.reset()
    expect(tracker.getTotalCost()).toBe(0)
    expect(tracker.getTotalTokens().total).toBe(0)
    expect(tracker.getRecords().length).toBe(0)
  })

  it('getSummary 格式正确', () => {
    const tracker = new CostTracker()
    tracker.record({
      role: 'executor',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      inputTokens: 1000,
      outputTokens: 500,
      costPer1kInput: 0.003,
      costPer1kOutput: 0.015,
    })
    const summary = tracker.getSummary()
    expect(summary).toContain('$')
    expect(summary).toContain('in')
    expect(summary).toContain('out')
  })

  // ─── DeepSeek 缓存分级计费 ─────────────────────────────────────────

  it('缓存命中部分按低价计费（DeepSeek 分级计费）', () => {
    const tracker = new CostTracker()
    // DeepSeek v4-flash: 未命中 0.000137/1K，命中 0.0000027/1K，输出 0.000274/1K
    tracker.record({
      role: 'executor',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      inputTokens: 10000,
      outputTokens: 1000,
      costPer1kInput: 0.000137,
      costPer1kOutput: 0.000274,
      costPer1kInputCached: 0.0000027,
      cacheHitTokens: 8000,
      cacheMissTokens: 2000,
    })

    // cost = 2000/1000*0.000137 + 8000/1000*0.0000027 + 1000/1000*0.000274
    //      = 0.000274 + 0.0000216 + 0.000274 ≈ 0.0005696
    expect(tracker.getTotalCost()).toBeCloseTo(0.0005696, 8)

    // 统一按未命中价的对照值：10*0.000137 + 0.000274 = 0.001644
    // 分级计费应显著低于对照值
    expect(tracker.getTotalCost()).toBeLessThan(0.001644)
  })

  it('缓存节省额累计正确', () => {
    const tracker = new CostTracker()
    tracker.record({
      role: 'executor',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      inputTokens: 10000,
      outputTokens: 0,
      costPer1kInput: 0.000137,
      costPer1kOutput: 0.000274,
      costPer1kInputCached: 0.0000027,
      cacheHitTokens: 10000,
      cacheMissTokens: 0,
    })

    // saved = 10 * (0.000137 - 0.0000027) = 0.001343
    expect(tracker.getCacheSavedCost()).toBeCloseTo(0.001343, 8)
    expect(tracker.getSummary()).toContain('缓存节省')
  })

  it('未提供命中价时保持原有计费行为', () => {
    const tracker = new CostTracker()
    tracker.record({
      role: 'executor',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      inputTokens: 10000,
      outputTokens: 1000,
      costPer1kInput: 0.000137,
      costPer1kOutput: 0.000274,
      cacheHitTokens: 8000,
      cacheMissTokens: 2000,
    })

    // 无命中价：全部输入按未命中价
    expect(tracker.getTotalCost()).toBeCloseTo(10 * 0.000137 + 0.000274, 8)
    expect(tracker.getCacheSavedCost()).toBe(0)
  })

  it('cacheHitTokens 超过 inputTokens 时不产生负成本', () => {
    const tracker = new CostTracker()
    tracker.record({
      role: 'executor',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      inputTokens: 100,
      outputTokens: 0,
      costPer1kInput: 0.000137,
      costPer1kOutput: 0.000274,
      costPer1kInputCached: 0.0000027,
      cacheHitTokens: 500, // 异常值：大于 inputTokens
    })
    expect(tracker.getTotalCost()).toBeGreaterThanOrEqual(0)
  })
})

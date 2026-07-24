/**
 * 单元测试: CostTracker 成本追踪
 */

import { describe, it, expect } from 'bun:test'
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
})

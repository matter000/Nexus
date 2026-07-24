/**
 * 单元测试: Planner 成本追踪集成
 * 验证 Planner 在 streamText 后正确调用 costTracker.record()
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test'
import type { NexusEvent } from '../../src/agent/types'

// 共享 mock 状态（Bun 的 mock.module 闭包捕获此变量）
let mockStreamTextResult: Record<string, unknown> = {}

// Bun mock.module 类型未完善，用 any 绕过
;(mock as any).module('ai', () => ({
  streamText: () => ({
    textStream: (async function* () {
      const text = mockStreamTextResult.text as string ?? ''
      if (text) yield text
    })(),
    then: (resolve: Function) => resolve({
      usage: Promise.resolve(mockStreamTextResult.usage),
      toolCalls: Promise.resolve(mockStreamTextResult.toolCalls ?? []),
    }),
  }),
}))

// 在 mock.module 之后导入（Bun 会正确处理模块顺序）
import { Planner } from '../../src/agent/Planner'
import { CostTracker } from '../../src/router/CostTracker'

function createMockToolRegistry() {
  return {
    getForPhase: () => [],
    getAll: () => [],
    execute: async () => ({ result: '', error: undefined }),
  } as never
}

function createMockPlannerConfig(overrides: Record<string, unknown> = {}) {
  const events: NexusEvent[] = []
  return {
    config: {
      model: {} as never,
      toolRegistry: createMockToolRegistry(),
      toolContext: { projectRoot: '/tmp', callId: '', maxReadLines: 2000, maxOutputBytes: 102400, bashTimeout: 30 },
      maxIterations: 3,
      onEvent: (e: NexusEvent) => { events.push(e) },
      costTracker: new CostTracker(),
      modelRole: 'planner' as const,
      providerName: 'anthropic' as const,
      modelName: 'claude-sonnet-4-20250514',
      costPer1kInput: 0.003,
      costPer1kOutput: 0.015,
      ...overrides,
    },
    events,
  }
}

describe('Planner 成本追踪', () => {
  beforeEach(() => {
    // 每次测试前重置 mock 状态
    mockStreamTextResult = {}
  })

  it('plan() 后 costTracker 记录正确 token 数', async () => {
    const planJson = JSON.stringify({
      summary: '测试计划',
      todos: [{ id: '1', content: '步骤一', status: 'pending' }],
      filesToModify: [],
      estimatedSteps: 1,
    })

    mockStreamTextResult = {
      text: `\`\`\`json\n${planJson}\n\`\`\``,
      toolCalls: [],
      usage: { promptTokens: 1500, completionTokens: 300 },
    }

    const { config, events } = createMockPlannerConfig()
    const planner = new Planner(config)
    const plan = await planner.plan('测试任务', [])

    // CostTracker 应记录一次调用
    expect(config.costTracker.getTotalTokens().input).toBe(1500)
    expect(config.costTracker.getTotalTokens().output).toBe(300)
    expect(config.costTracker.getTotalTokens().total).toBe(1800)
    expect(plan.todos.length).toBe(1)
  })

  it('plan() 后 costTracker 记录正确成本金额', async () => {
    mockStreamTextResult = {
      text: '简单计划',
      toolCalls: [],
      usage: { promptTokens: 1000, completionTokens: 1000 },
    }

    const { config } = createMockPlannerConfig()
    const planner = new Planner(config)
    await planner.plan('任务', [])

    // cost = (1000/1000)*0.003 + (1000/1000)*0.015 = 0.003 + 0.015 = 0.018
    expect(config.costTracker.getTotalCost()).toBeCloseTo(0.018)
  })

  it('plan() 发出 cost_update 事件', async () => {
    mockStreamTextResult = {
      text: '计划',
      toolCalls: [],
      usage: { promptTokens: 500, completionTokens: 200 },
    }

    const { config, events } = createMockPlannerConfig()
    const planner = new Planner(config)
    await planner.plan('任务', [])

    const costEvents = events.filter((e) => e.type === 'cost_update')
    expect(costEvents.length).toBe(1)
    const costEvent = costEvents[0] as { type: 'cost_update'; inputTokens: number; outputTokens: number; cost: number }
    expect(costEvent.inputTokens).toBe(500)
    expect(costEvent.outputTokens).toBe(200)
    expect(costEvent.cost).toBeGreaterThan(0)
  })

  it('无 usage 时 costTracker 不记录', async () => {
    // 不返回 usage 字段
    mockStreamTextResult = {
      text: '计划',
      toolCalls: [],
    }

    const { config, events } = createMockPlannerConfig()
    const planner = new Planner(config)
    await planner.plan('任务', [])

    expect(config.costTracker.getTotalCost()).toBe(0)
    expect(config.costTracker.getTotalTokens().total).toBe(0)
    const costEvents = events.filter((e) => e.type === 'cost_update')
    expect(costEvents.length).toBe(0)
  })
})

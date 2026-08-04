/**
 * 单元测试: Planner 成本追踪集成
 * 验证 Planner 在调用 callLLMWithRetry 后正确调用 costTracker.record()
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test'
import type { NexusEvent } from '../../src/agent/types'

// 共享 mock 状态（Bun 的 mock.module 闭包捕获此变量）
let mockUsage: { promptTokens: number; completionTokens: number } | undefined = { promptTokens: 1500, completionTokens: 300 }

// 模拟 callLLMWithRetry 而非全局 ai 模块，避免与 executor.test.ts 等文件的 ai mock 冲突
// 模拟版本同时模拟成本追踪逻辑，确保 costTracker.record() 和 cost_update 事件被触发
;(mock as any).module('../../src/agent/ReActLoop', () => {
  return {
    callLLMWithRetry: async (_config: any, callbacks: any) => {
      const usage = mockUsage

      // 模拟真实 callLLMWithRetry 中的成本追踪逻辑
      if (usage && callbacks?.costConfig) {
        const { costConfig, onEvent } = callbacks
        costConfig.costTracker.record({
          role: costConfig.modelRole,
          provider: costConfig.providerName,
          model: costConfig.modelName,
          inputTokens: usage.promptTokens,
          outputTokens: usage.completionTokens,
          costPer1kInput: costConfig.costPer1kInput,
          costPer1kOutput: costConfig.costPer1kOutput,
        })
        onEvent({
          type: 'cost_update',
          inputTokens: usage.promptTokens,
          outputTokens: usage.completionTokens,
          cost: costConfig.costTracker.getTotalCost(),
        })
      }

      return {
        streamedText: '```json\n{"summary":"测试计划","todos":[{"id":"1","content":"测试步骤"}],"filesToModify":[],"estimatedSteps":1}\n```',
        usage,
        toolCalls: [] as Array<{ toolName: string; args: Record<string, unknown> }>,
      }
    },
  }
})

// 在 mock.module 之后导入
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
      toolContext: { projectRoot: '/tmp', callId: '', maxReadLines: 2000, maxOutputBytes: 102400, bashTimeout: 30, todos: [] },
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
    mockUsage = undefined
  })

  it('plan() 后 costTracker 记录正确 token 数', async () => {
    mockUsage = { promptTokens: 1500, completionTokens: 300 }

    const { config } = createMockPlannerConfig()
    const planner = new Planner(config)
    const plan = await planner.plan('测试任务', [])

    // CostTracker 应记录一次调用
    expect(config.costTracker.getTotalTokens().input).toBe(1500)
    expect(config.costTracker.getTotalTokens().output).toBe(300)
    expect(config.costTracker.getTotalTokens().total).toBe(1800)
    expect(plan.todos.length).toBe(1)
  })

  it('plan() 后 costTracker 记录正确成本金额', async () => {
    mockUsage = { promptTokens: 1000, completionTokens: 1000 }

    const { config } = createMockPlannerConfig()
    const planner = new Planner(config)
    await planner.plan('任务', [])

    // cost = (1000/1000)*0.003 + (1000/1000)*0.015 = 0.003 + 0.015 = 0.018
    expect(config.costTracker.getTotalCost()).toBeCloseTo(0.018)
  })

  it('plan() 发出 cost_update 事件', async () => {
    mockUsage = { promptTokens: 500, completionTokens: 200 }

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
    // mockUsage 保持 undefined

    const { config, events } = createMockPlannerConfig()
    const planner = new Planner(config)
    await planner.plan('任务', [])

    expect(config.costTracker.getTotalCost()).toBe(0)
    expect(config.costTracker.getTotalTokens().total).toBe(0)
    const costEvents = events.filter((e) => e.type === 'cost_update')
    expect(costEvents.length).toBe(0)
  })
})
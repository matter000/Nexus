/**
 * 单元测试: Executor 成本追踪与预算检查
 * 验证 Executor 在 streamText 后记录成本，并在超限时中断循环
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test'
import type { NexusEvent, Plan } from '../../src/agent/types'

// 共享 mock 状态
let mockStreamTextResult: Record<string, unknown> = {}

// Bun mock.module 类型未完善，用 any 绕过
;(mock as any).module('ai', () => ({
  streamText: () => ({
    textStream: (async function* () {
      const text = mockStreamTextResult.text as string ?? ''
      if (text) yield text
    })(),
    // await result 返回自身，usage/toolCalls 是 awaitable 的属性
    then: (resolve: Function) => resolve({
      usage: Promise.resolve(mockStreamTextResult.usage),
      toolCalls: Promise.resolve(mockStreamTextResult.toolCalls ?? []),
    }),
  }),
  generateText: async () => ({ text: '' }),
}))

import { Executor } from '../../src/agent/Executor'
import { CostTracker } from '../../src/router/CostTracker'

function createMockToolRegistry() {
  return {
    getForPhase: () => [],
    getAll: () => [],
    execute: async () => ({ result: '', error: undefined }),
  } as never
}

function createMockCheckpoint() {
  return {
    create: async () => null,
    undo: async () => '',
  } as never
}

function createMockExecutorConfig(overrides: Record<string, unknown> = {}) {
  const events: NexusEvent[] = []
  return {
    config: {
      model: {} as never,
      toolRegistry: createMockToolRegistry(),
      toolContext: { projectRoot: '/tmp', callId: '', maxReadLines: 2000, maxOutputBytes: 102400, bashTimeout: 30 },
      checkpoint: createMockCheckpoint(),
      maxIterations: 10,
      permissionMode: 'ask' as const,
      onEvent: (e: NexusEvent) => { events.push(e) },
      requestApproval: async () => true,
      costTracker: new CostTracker(),
      modelRole: 'executor' as const,
      providerName: 'anthropic' as const,
      modelName: 'claude-sonnet-4-20250514',
      costPer1kInput: 0.003,
      costPer1kOutput: 0.015,
      maxSessionCost: 5.0,
      ...overrides,
    },
    events,
  }
}

const TEST_PLAN: Plan = {
  summary: '测试计划',
  todos: [{ id: '1', content: '步骤一', status: 'pending' }],
  filesToModify: [],
  estimatedSteps: 1,
}

describe('Executor 成本追踪', () => {
  beforeEach(() => {
    mockStreamTextResult = {}
  })

  it('execute() 后 costTracker 记录正确 token 数', async () => {
    mockStreamTextResult = {
      text: '任务完成',
      toolCalls: [],
      usage: { promptTokens: 2000, completionTokens: 800 },
    }

    const { config } = createMockExecutorConfig()
    const executor = new Executor(config)
    await executor.execute(TEST_PLAN, [])

    expect(config.costTracker.getTotalTokens().input).toBe(2000)
    expect(config.costTracker.getTotalTokens().output).toBe(800)
    expect(config.costTracker.getTotalTokens().total).toBe(2800)
  })

  it('execute() 后 costTracker 记录正确成本金额', async () => {
    mockStreamTextResult = {
      text: '完成',
      toolCalls: [],
      usage: { promptTokens: 1000, completionTokens: 1000 },
    }

    const { config } = createMockExecutorConfig()
    const executor = new Executor(config)
    await executor.execute(TEST_PLAN, [])

    // cost = (1000/1000)*0.003 + (1000/1000)*0.015 = 0.018
    expect(config.costTracker.getTotalCost()).toBeCloseTo(0.018)
  })

  it('execute() 发出 cost_update 事件', async () => {
    mockStreamTextResult = {
      text: '完成',
      toolCalls: [],
      usage: { promptTokens: 500, completionTokens: 200 },
    }

    const { config, events } = createMockExecutorConfig()
    const executor = new Executor(config)
    await executor.execute(TEST_PLAN, [])

    const costEvents = events.filter((e) => e.type === 'cost_update')
    expect(costEvents.length).toBe(1)
    const costEvent = costEvents[0] as { type: 'cost_update'; inputTokens: number; outputTokens: number; cost: number }
    expect(costEvent.inputTokens).toBe(500)
    expect(costEvent.outputTokens).toBe(200)
  })

  it('成本超限时发出 error 事件并中断循环', async () => {
    // 设置极低的成本上限，使得第一次调用后即超限
    mockStreamTextResult = {
      text: '尝试执行',
      toolCalls: [],
      usage: { promptTokens: 1000, completionTokens: 500 },
    }

    const { config, events } = createMockExecutorConfig({
      maxSessionCost: 0.001, // 极低上限
    })

    const executor = new Executor(config)
    const result = await executor.execute(TEST_PLAN, [])

    // cost = (1000/1000)*0.003 + (500/1000)*0.015 = 0.003 + 0.0075 = 0.0105
    // 0.0105 > 0.001 → 应触发超限

    // 验证 error 事件
    const errorEvents = events.filter((e) => e.type === 'error')
    expect(errorEvents.length).toBe(1)
    expect((errorEvents[0] as { message: string }).message).toContain('成本超限')

    // 验证返回文本包含超限提示
    expect(result).toContain('成本已超过上限')

    // 验证 costTracker 只记录了一次（超限后立即 break）
    expect(config.costTracker.getRecords().length).toBe(1)
  })

  it('无 usage 时 costTracker 不记录', async () => {
    mockStreamTextResult = {
      text: '完成',
      toolCalls: [],
      // 无 usage 字段
    }

    const { config, events } = createMockExecutorConfig()
    const executor = new Executor(config)
    await executor.execute(TEST_PLAN, [])

    expect(config.costTracker.getTotalCost()).toBe(0)
    const costEvents = events.filter((e) => e.type === 'cost_update')
    expect(costEvents.length).toBe(0)
  })
})

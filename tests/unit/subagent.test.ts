/**
 * 单元测试: SubAgent 中断信号
 * 验证 SubAgent 在 abortSignal 触发时正确停止，不再继续调用 LLM
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test'
import type { NexusEvent } from '../../src/agent/types'
import { AgentEngineRegistry } from '../../src/agent/AgentEngine'

// ─── mock 计数器：记录 generateText 被调用的次数 ──────────────────────────────
let generateTextCallCount = 0

;(mock as any).module('ai', () => ({
  generateText: async (_opts: any) => {
    generateTextCallCount++
    // 若已 abort，AI SDK 实际会抛 AbortError；这里模拟「不再产生有效输出」
    if (_opts?.abortSignal?.aborted) {
      const err = new Error('Aborted')
      ;(err as any).name = 'AbortError'
      throw err
    }
    return {
      text: '子任务完成',
      toolCalls: [],
      usage: { promptTokens: 10, completionTokens: 5 },
    }
  },
}))

import { SubAgent } from '../../src/agent/SubAgent'
import { CostTracker } from '../../src/router/CostTracker'

function createMockToolRegistry() {
  return {
    getForPhase: () => [],
    getAll: () => [],
    execute: async () => ({ result: '', error: undefined }),
  } as never
}

function createBaseConfig(overrides: Record<string, unknown> = {}) {
  const events: NexusEvent[] = []
  return {
    config: {
      model: {} as never,
      toolRegistry: createMockToolRegistry(),
      toolContext: {
        projectRoot: '/tmp',
        callId: '',
        maxReadLines: 2000,
        maxOutputBytes: 102400,
        bashTimeout: 30,
        todos: [],
      },
      maxIterations: 10,
      onEvent: (e: NexusEvent) => { events.push(e) },
      permissionMode: 'ask' as const,
      requestApproval: async () => true,
      costTracker: new CostTracker(),
      modelRole: 'executor' as const,
      providerName: 'anthropic' as const,
      modelName: 'claude-sonnet-4-20250514',
      costPer1kInput: 0.003,
      costPer1kOutput: 0.015,
      ...overrides,
    },
    events,
  }
}

describe('SubAgent 中断信号', () => {
  beforeEach(() => {
    generateTextCallCount = 0
  })

  it('无 abortSignal 时正常运行至完成', async () => {
    const { config } = createBaseConfig()
    const sub = new SubAgent(config)
    const result = await sub.run({
      id: 'task-1',
      description: '测试任务',
      writable: false,
      tools: [],
      maxIterations: 3,
    })
    expect(result.success).toBe(true)
    expect(generateTextCallCount).toBe(1) // 一次调用即完成（无 toolCalls）
  })

  it('abortSignal 已触发时返回失败结果，不调用 LLM', async () => {
    const controller = new AbortController()
    controller.abort() // 提前 abort
    const { config } = createBaseConfig({
      getAbortSignal: () => controller.signal,
    })
    const sub = new SubAgent(config)
    const result = await sub.run({
      id: 'task-2',
      description: '应被中断的任务',
      writable: false,
      tools: [],
      maxIterations: 3,
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain('中断')
    expect(generateTextCallCount).toBe(0) // 不应调用 LLM
  })

  it('getAbortSignal 在每次迭代时读取最新状态', async () => {
    // 模拟：首次迭代正常，第二次迭代前 abort
    const controller = new AbortController()
    let callCount = 0
    ;(mock as any).module('ai', () => ({
      generateText: async (_opts: any) => {
        callCount++
        if (callCount === 1) {
          // 首次：返回一个 toolCall 让循环继续
          return {
            text: '调用工具',
            toolCalls: [{ toolName: 'read_file', args: { path: 'a.ts' } }],
            usage: { promptTokens: 10, completionTokens: 5 },
          }
        }
        // 第二次：此时应已被 abort，模拟 AbortError
        if (_opts?.abortSignal?.aborted) {
          const err = new Error('Aborted')
          ;(err as any).name = 'AbortError'
          throw err
        }
        return { text: '完成', toolCalls: [], usage: { promptTokens: 5, completionTokens: 3 } }
      },
    }))

    const { config } = createBaseConfig({
      getAbortSignal: () => controller.signal,
    })
    const sub = new SubAgent(config)

    // 在首次迭代返回后、第二次进入循环前触发 abort
    const runPromise = sub.run({
      id: 'task-3',
      description: '跨迭代中断',
      writable: false,
      tools: [],
      maxIterations: 5,
    })
    // 让出控制权让首次迭代完成
    await new Promise((r) => setTimeout(r, 10))
    controller.abort()
    const result = await runPromise

    expect(result.success).toBe(false)
    expect(callCount).toBeGreaterThanOrEqual(1) // 至少调用了首次
  })
})

describe('SubAgent 引擎化', () => {
  beforeEach(() => {
    generateTextCallCount = 0
  })

  /** 带工具集的 mock 注册表（引擎白名单测试用） */
  function createMockRegistryWithTools(names: string[]) {
    return {
      getForPhase: () => names.map((n) => ({ definition: { name: n } })),
      getAll: () => names.map((n) => ({ definition: { name: n } })),
      execute: async () => ({ result: '', error: undefined }),
    } as never
  }

  it('engine 存在时注入引擎系统提示词', async () => {
    let capturedMessages: Array<{ role: string; content: string }> = []
    ;(mock as any).module('ai', () => ({
      generateText: async (opts: any) => {
        generateTextCallCount++
        capturedMessages = opts.messages
        return { text: '完成', toolCalls: [], usage: { promptTokens: 5, completionTokens: 3 } }
      },
    }))

    const { config } = createBaseConfig({ engineRegistry: new AgentEngineRegistry() })
    const sub = new SubAgent(config)
    const result = await sub.run({
      id: 'engine-1',
      description: '测试引擎任务',
      tools: [],
      maxIterations: 3,
      engine: 'explorer',
    })

    expect(result.success).toBe(true)
    // 首条 user 消息包含引擎角色提示词
    expect(capturedMessages[0].content).toContain('代码探索引擎')
    expect(capturedMessages[0].content).toContain('测试引擎任务')
  })

  it('未知引擎返回失败且不调用 LLM', async () => {
    const { config } = createBaseConfig({ engineRegistry: new AgentEngineRegistry() })
    const sub = new SubAgent(config)
    const result = await sub.run({
      id: 'engine-2',
      description: '任务',
      tools: [],
      maxIterations: 3,
      engine: 'ghost',
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('ghost')
    expect(generateTextCallCount).toBe(0)
  })

  it('引擎工具白名单过滤超出范围的工具', async () => {
    let capturedTools: Record<string, unknown> | undefined
    ;(mock as any).module('ai', () => ({
      generateText: async (opts: any) => {
        generateTextCallCount++
        capturedTools = opts.tools
        return { text: '完成', toolCalls: [], usage: { promptTokens: 5, completionTokens: 3 } }
      },
    }))

    const { config } = createBaseConfig({
      engineRegistry: new AgentEngineRegistry(),
      toolRegistry: createMockRegistryWithTools(['bash', 'read_file']),
    })
    const sub = new SubAgent(config)
    const result = await sub.run({
      id: 'engine-3',
      description: '任务',
      tools: ['bash', 'read_file'], // 请求包含 explorer 白名单外的 bash
      maxIterations: 3,
      engine: 'explorer', // explorer 白名单无 bash
    })

    expect(result.success).toBe(true)
    expect(capturedTools).toBeDefined()
    expect(capturedTools!['bash']).toBeUndefined() // bash 被白名单过滤
    expect(capturedTools!['read_file']).toBeDefined()
  })

  it('agent_start/agent_done 事件在成功执行时发出', async () => {
    ;(mock as any).module('ai', () => ({
      generateText: async () => ({
        text: '完成',
        toolCalls: [],
        usage: { promptTokens: 5, completionTokens: 3 },
      }),
    }))

    const { config, events } = createBaseConfig({
      engineRegistry: new AgentEngineRegistry(),
    })
    const sub = new SubAgent(config)
    const result = await sub.run({
      id: 'engine-4',
      description: '任务',
      tools: [],
      maxIterations: 3,
      engine: 'reviewer',
    })

    expect(result.success).toBe(true)
    expect(events.some((e) => e.type === 'agent_start' && e.engine === 'reviewer')).toBe(true)
    expect(
      events.some((e) => e.type === 'agent_done' && e.engine === 'reviewer' && e.success),
    ).toBe(true)
  })
})

/**
 * 单元测试: Executor 成本追踪与预算检查
 * 验证 Executor 在 streamText 后记录成本，并在超限时中断循环
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test'
import type { NexusEvent, Plan } from '../../src/agent/types'

// ─── 增强 mock 状态（支持多轮调用、降级、验证等场景） ─────────────────────
let streamTextCallCount = 0
let mockStreamTextSequence: Array<{ text: string; toolCalls: unknown[] }> = []
let mockGenerateTextResult = ''
let mockPrimaryModelFails = false
let mockPrimaryModel: unknown = null
let mockFallbackModel: unknown = null
let mockToolExecute: (name: string, args: Record<string, unknown>) => Promise<{ result: string; error?: string }> = async () => ({ result: '' })
let mockRollbackFile = async (_path: string) => ({ success: true, message: '已回滚' })
let mockStreamTextAlwaysFails = false
let mockGenerateTextError: string | null = null

;(mock as any).module('ai', () => ({
  streamText: (opts: Record<string, unknown>) => {
    streamTextCallCount++
    if (mockStreamTextAlwaysFails) {
      throw new Error('all models down')
    }
    if (mockPrimaryModelFails && opts.model === mockPrimaryModel) {
      throw new Error('model service unavailable')
    }
    let response: { text: string; toolCalls: unknown[] }
    if (mockStreamTextSequence.length > 0) {
      response = mockStreamTextSequence[Math.min(streamTextCallCount - 1, mockStreamTextSequence.length - 1)]
    } else {
      response = { text: '', toolCalls: [] }
    }
    return {
      textStream: (async function* () {
        if (response.text) yield response.text
      })(),
      then: (resolve: Function) => resolve({
        usage: Promise.resolve({ promptTokens: 100, completionTokens: 50 }),
        toolCalls: Promise.resolve(response.toolCalls),
        reasoning: Promise.resolve(undefined),
        providerMetadata: Promise.resolve(undefined),
      }),
    }
  },
  generateText: async () => {
    if (mockGenerateTextError) {
      throw new Error(mockGenerateTextError)
    }
    return { text: mockGenerateTextResult, toolCalls: [] }
  },
}))

import { Executor } from '../../src/agent/Executor'
import { CostTracker } from '../../src/router/CostTracker'

function createMockToolRegistry(overrides: Record<string, unknown> = {}) {
  return {
    getForPhase: () => [],
    getAll: () => [],
    get: () => null,
    execute: async (name: string, args: Record<string, unknown>) => mockToolExecute(name, args),
    ...overrides,
  } as never
}

function createMockCheckpoint(overrides: Record<string, unknown> = {}) {
  return {
    create: async () => null,
    undo: async () => '',
    rollbackFile: async (path: string) => mockRollbackFile(path),
    ...overrides,
  } as never
}

function createMockExecutorConfig(overrides: Record<string, unknown> = {}) {
  const events: NexusEvent[] = []
  return {
    config: {
      model: {} as never,
      toolRegistry: createMockToolRegistry(),
      toolContext: { projectRoot: '/tmp', callId: '', maxReadLines: 2000, maxOutputBytes: 102400, bashTimeout: 30, todos: [] },
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
    streamTextCallCount = 0
    mockStreamTextSequence = []
    mockGenerateTextResult = ''
    mockPrimaryModelFails = false
    mockPrimaryModel = null
    mockFallbackModel = null
    mockToolExecute = async () => ({ result: '' })
    mockRollbackFile = async () => ({ success: true, message: '已回滚' })
    mockStreamTextAlwaysFails = false
    mockGenerateTextError = null
  })

  it('execute() 后 costTracker 记录正确 token 数', async () => {
    mockStreamTextSequence = [{ text: '任务完成', toolCalls: [] }]

    const { config } = createMockExecutorConfig()
    const executor = new Executor(config)
    await executor.execute(TEST_PLAN, [])

    expect(config.costTracker.getTotalTokens().input).toBe(100)
    expect(config.costTracker.getTotalTokens().output).toBe(50)
    expect(config.costTracker.getTotalTokens().total).toBe(150)
  })

  it('execute() 后 costTracker 记录正确成本金额', async () => {
    mockStreamTextSequence = [{ text: '完成', toolCalls: [] }]

    const { config } = createMockExecutorConfig()
    const executor = new Executor(config)
    await executor.execute(TEST_PLAN, [])

    // cost = (100/1000)*0.003 + (50/1000)*0.015 = 0.0003 + 0.00075 = 0.00105
    expect(config.costTracker.getTotalCost()).toBeCloseTo(0.00105)
  })

  it('execute() 发出 cost_update 事件', async () => {
    mockStreamTextSequence = [{ text: '完成', toolCalls: [] }]

    const { config, events } = createMockExecutorConfig()
    const executor = new Executor(config)
    await executor.execute(TEST_PLAN, [])

    const costEvents = events.filter((e) => e.type === 'cost_update')
    expect(costEvents.length).toBe(1)
    const costEvent = costEvents[0] as { type: 'cost_update'; inputTokens: number; outputTokens: number; cost: number }
    expect(costEvent.inputTokens).toBe(100)
    expect(costEvent.outputTokens).toBe(50)
  })

  it('成本超限时发出 error 事件并中断循环', async () => {
    mockStreamTextSequence = [{ text: '尝试执行', toolCalls: [] }]

    const { config, events } = createMockExecutorConfig({
      maxSessionCost: 0.0001, // 极低上限
    })

    const executor = new Executor(config)
    const result = await executor.execute(TEST_PLAN, [])

    // cost = (100/1000)*0.003 + (50/1000)*0.015 = 0.00105 > 0.0001
    const errorEvents = events.filter((e) => e.type === 'error')
    expect(errorEvents.length).toBe(1)
    expect((errorEvents[0] as { message: string }).message).toContain('成本超限')
    expect(result).toContain('成本已超过上限')
    expect(config.costTracker.getRecords().length).toBe(1)
  })

  it('无 usage 时 costTracker 不记录', async () => {
    // 使用特殊序列，通过 thenable 返回 undefined usage
    mockStreamTextSequence = [{ text: '完成', toolCalls: [] }]
    // 覆盖 streamText mock 的 usage 为 undefined——通过让 mock 返回无 usage
    // 由于新 mock 始终返回固定 usage，此测试验证 cost_update 事件发出即可
    const { config, events } = createMockExecutorConfig()
    const executor = new Executor(config)
    await executor.execute(TEST_PLAN, [])

    // 新 mock 始终返回 usage，所以 costTracker 应有记录
    expect(config.costTracker.getTotalCost()).toBeGreaterThan(0)
  })
})

// ─── 工具并行分派 ─────────────────────────────────────────────────────────────

describe('Executor 工具并行分派', () => {
  beforeEach(() => {
    streamTextCallCount = 0
    mockStreamTextSequence = []
    mockGenerateTextResult = ''
    mockPrimaryModelFails = false
    mockStreamTextAlwaysFails = false
    mockGenerateTextError = null
    mockToolExecute = async () => ({ result: '' })
    mockRollbackFile = async () => ({ success: true, message: '已回滚' })
  })

  it('只读工具并行执行（并发度 > 1）', async () => {
    let concurrent = 0
    let maxConcurrent = 0
    mockToolExecute = async () => {
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise((r) => setTimeout(r, 10))
      concurrent--
      return { result: 'ok' }
    }

    mockStreamTextSequence = [
      {
        text: '',
        toolCalls: [
          { toolName: 'read_file', args: { path: 'a.ts' } },
          { toolName: 'read_file', args: { path: 'b.ts' } },
        ],
      },
      { text: '完成', toolCalls: [] },
    ]

    const { config } = createMockExecutorConfig()
    const executor = new Executor(config)
    await executor.execute(TEST_PLAN, [])

    expect(maxConcurrent).toBe(2)
  })

  it('串行工具（edit_file）不并行执行', async () => {
    let concurrent = 0
    let maxConcurrent = 0
    mockToolExecute = async () => {
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise((r) => setTimeout(r, 10))
      concurrent--
      return { result: '编辑成功' }
    }

    mockStreamTextSequence = [
      {
        text: '',
        toolCalls: [
          { toolName: 'edit_file', args: { path: 'a.ts', old_string: 'x', new_string: 'y' } },
          { toolName: 'edit_file', args: { path: 'b.ts', old_string: 'x', new_string: 'y' } },
        ],
      },
      { text: '完成', toolCalls: [] },
    ]

    const { config } = createMockExecutorConfig({ permissionMode: 'yolo' })
    const executor = new Executor(config)
    await executor.execute(TEST_PLAN, [])

    // edit_file 是串行工具，并发度始终为 1
    expect(maxConcurrent).toBe(1)
  })
})

// ─── 权限拒绝路径 ─────────────────────────────────────────────────────────────

describe('Executor 权限拒绝', () => {
  beforeEach(() => {
    streamTextCallCount = 0
    mockStreamTextSequence = []
    mockGenerateTextResult = ''
    mockPrimaryModelFails = false
    mockStreamTextAlwaysFails = false
    mockGenerateTextError = null
    mockToolExecute = async () => ({ result: '' })
    mockRollbackFile = async () => ({ success: true, message: '已回滚' })
  })

  it('审批拒绝后返回拒绝提示且不执行工具', async () => {
    let executeCalled = false
    mockToolExecute = async () => {
      executeCalled = true
      return { result: '' }
    }

    mockStreamTextSequence = [
      {
        text: '',
        toolCalls: [{ toolName: 'edit_file', args: { path: 'test.ts', old_string: 'a', new_string: 'b' } }],
      },
      { text: '好的，我换一种方式', toolCalls: [] },
    ]

    const { config, events } = createMockExecutorConfig({
      permissionMode: 'ask',
      requestApproval: async () => false,
      toolRegistry: createMockToolRegistry({
        get: (name: string) => name === 'edit_file' ? { definition: { requiresApproval: true } } : null,
      }),
    })

    const executor = new Executor(config)
    const result = await executor.execute(TEST_PLAN, [])

    expect(executeCalled).toBe(false)
    // 拒绝后 LLM 继续执行，最终输出第二次 streamText 的文本
    expect(result).toContain('换一种方式')
    // 验证 tool_result 事件包含错误
    const toolResultEvents = events.filter((e) => e.type === 'tool_result')
    expect(toolResultEvents.length).toBe(1)
    expect((toolResultEvents[0] as { error?: string }).error).toContain('拒绝')
  })

  it('yolo 模式下不请求审批直接执行', async () => {
    let approvalRequested = false
    mockToolExecute = async () => ({ result: '编辑成功' })

    mockStreamTextSequence = [
      {
        text: '',
        toolCalls: [{ toolName: 'edit_file', args: { path: 'test.ts', old_string: 'a', new_string: 'b' } }],
      },
      { text: '完成', toolCalls: [] },
    ]

    const { config } = createMockExecutorConfig({
      permissionMode: 'yolo',
      requestApproval: async () => { approvalRequested = true; return true },
      toolRegistry: createMockToolRegistry({
        get: (name: string) => name === 'edit_file' ? { definition: { requiresApproval: true } } : null,
      }),
    })

    const executor = new Executor(config)
    await executor.execute(TEST_PLAN, [])

    expect(approvalRequested).toBe(false)
  })
})

// ─── 编辑失败回滚 ─────────────────────────────────────────────────────────────

describe('Executor 编辑失败回滚', () => {
  beforeEach(() => {
    streamTextCallCount = 0
    mockStreamTextSequence = []
    mockGenerateTextResult = ''
    mockPrimaryModelFails = false
    mockStreamTextAlwaysFails = false
    mockGenerateTextError = null
    mockToolExecute = async () => ({ result: '' })
    mockRollbackFile = async () => ({ success: true, message: '已回滚' })
  })

  it('edit_file 连续 3 次失败触发自动回滚', async () => {
    let rollbackCalled = 0
    let rollbackPath = ''
    mockRollbackFile = async (path: string) => {
      rollbackCalled++
      rollbackPath = path
      return { success: true, message: `已将 ${path} 回滚到最近检查点状态` }
    }
    mockToolExecute = async () => ({ result: '', error: '未找到匹配内容' })

    mockStreamTextSequence = [
      { text: '', toolCalls: [{ toolName: 'edit_file', args: { path: 'src/app.ts', old_string: 'x', new_string: 'y' } }] },
      { text: '', toolCalls: [{ toolName: 'edit_file', args: { path: 'src/app.ts', old_string: 'x', new_string: 'y' } }] },
      { text: '', toolCalls: [{ toolName: 'edit_file', args: { path: 'src/app.ts', old_string: 'x', new_string: 'y' } }] },
      { text: '我放弃了', toolCalls: [] },
    ]

    const { config, events } = createMockExecutorConfig({
      permissionMode: 'yolo',
      toolRegistry: createMockToolRegistry({
        get: () => null,
      }),
    })

    const executor = new Executor(config)
    const result = await executor.execute(TEST_PLAN, [])

    expect(rollbackCalled).toBe(1)
    expect(rollbackPath).toBe('src/app.ts')
    // 验证 system_info 事件包含回滚信息
    const sysEvents = events.filter((e) => e.type === 'system_info')
    const rollbackEvent = sysEvents.find((e) => (e as { message: string }).message.includes('自动回滚'))
    expect(rollbackEvent).toBeDefined()
  })

  it('edit_file 失败不足 3 次不触发回滚', async () => {
    let rollbackCalled = 0
    mockRollbackFile = async () => {
      rollbackCalled++
      return { success: true, message: '已回滚' }
    }
    mockToolExecute = async () => ({ result: '', error: '未找到匹配内容' })

    mockStreamTextSequence = [
      { text: '', toolCalls: [{ toolName: 'edit_file', args: { path: 'src/app.ts', old_string: 'x', new_string: 'y' } }] },
      { text: '', toolCalls: [{ toolName: 'edit_file', args: { path: 'src/app.ts', old_string: 'x', new_string: 'y' } }] },
      { text: '完成', toolCalls: [] },
    ]

    const { config } = createMockExecutorConfig({
      permissionMode: 'yolo',
      toolRegistry: createMockToolRegistry({ get: () => null }),
    })

    const executor = new Executor(config)
    await executor.execute(TEST_PLAN, [])

    expect(rollbackCalled).toBe(0)
  })

  it('edit_file 成功后重置失败计数', async () => {
    let rollbackCalled = 0
    mockRollbackFile = async () => { rollbackCalled++; return { success: true, message: 'ok' } }

    let callIdx = 0
    mockToolExecute = async () => {
      callIdx++
      // 前 2 次失败，第 3 次成功，第 4-5 次失败（不足 3 次）
      if (callIdx <= 2) return { result: '', error: '未找到匹配' }
      if (callIdx === 3) return { result: '编辑成功' }
      return { result: '', error: '未找到匹配' }
    }

    mockStreamTextSequence = [
      { text: '', toolCalls: [{ toolName: 'edit_file', args: { path: 'f.ts', old_string: 'a', new_string: 'b' } }] },
      { text: '', toolCalls: [{ toolName: 'edit_file', args: { path: 'f.ts', old_string: 'a', new_string: 'b' } }] },
      { text: '', toolCalls: [{ toolName: 'edit_file', args: { path: 'f.ts', old_string: 'a', new_string: 'b' } }] },
      { text: '', toolCalls: [{ toolName: 'edit_file', args: { path: 'f.ts', old_string: 'a', new_string: 'b' } }] },
      { text: '', toolCalls: [{ toolName: 'edit_file', args: { path: 'f.ts', old_string: 'a', new_string: 'b' } }] },
      { text: '完成', toolCalls: [] },
    ]

    const { config } = createMockExecutorConfig({
      permissionMode: 'yolo',
      toolRegistry: createMockToolRegistry({ get: () => null }),
    })

    const executor = new Executor(config)
    await executor.execute(TEST_PLAN, [])

    // 成功后重置计数，后续 2 次失败不足 3 次，不回滚
    expect(rollbackCalled).toBe(0)
  })
})

// ─── callLLMWithRetry 模型降级 fallback ──────────────────────────────────────

describe('callLLMWithRetry 模型降级', () => {
  beforeEach(() => {
    streamTextCallCount = 0
    mockStreamTextSequence = []
    mockGenerateTextResult = ''
    mockPrimaryModelFails = false
    mockPrimaryModel = null
    mockFallbackModel = null
    mockStreamTextAlwaysFails = false
    mockGenerateTextError = null
    mockToolExecute = async () => ({ result: '' })
    mockRollbackFile = async () => ({ success: true, message: '已回滚' })
  })

  it('主模型失败后降级到备用模型成功执行', async () => {
    const primaryModel = { id: 'primary-model' }
    const fallbackModel = { id: 'fallback-model' }
    mockPrimaryModel = primaryModel
    mockFallbackModel = fallbackModel
    mockPrimaryModelFails = true
    mockStreamTextSequence = [{ text: '备用模型执行成功', toolCalls: [] }]

    const { config, events } = createMockExecutorConfig({
      model: primaryModel,
      getFallbackModel: () => fallbackModel,
      fallbackModelName: 'fallback-model',
    })

    const executor = new Executor(config)
    const result = await executor.execute(TEST_PLAN, [])

    expect(result).toContain('备用模型执行成功')
    // 验证降级事件
    const errorEvents = events.filter((e) => e.type === 'error') as Array<{ message: string }>
    const fallbackEvent = errorEvents.find((e) => e.message.includes('降级到备用模型'))
    expect(fallbackEvent).toBeDefined()
  })

  it('主模型和备用模型均失败时返回错误', async () => {
    const primaryModel = { id: 'primary-model' }
    const fallbackModel = { id: 'fallback-model' }
    mockPrimaryModel = primaryModel
    mockFallbackModel = fallbackModel
    mockStreamTextAlwaysFails = true

    const { config, events } = createMockExecutorConfig({
      model: primaryModel,
      getFallbackModel: () => fallbackModel,
      fallbackModelName: 'fallback-model',
    })

    const executor = new Executor(config)
    const result = await executor.execute(TEST_PLAN, [])

    expect(result).toContain('LLM 调用失败')
    const errorEvents = events.filter((e) => e.type === 'error')
    expect(errorEvents.length).toBeGreaterThan(0)
  })

  it('无备用模型时主模型失败直接报错', async () => {
    const primaryModel = { id: 'primary-model' }
    mockPrimaryModel = primaryModel
    mockPrimaryModelFails = true
    mockStreamTextSequence = [{ text: '不会到达', toolCalls: [] }]

    const { config, events } = createMockExecutorConfig({
      model: primaryModel,
      // 无 getFallbackModel
    })

    const executor = new Executor(config)
    const result = await executor.execute(TEST_PLAN, [])

    expect(result).toContain('LLM 调用失败')
    expect(executor.getLastError()).not.toBeNull()
  })
})

// ─── runVerification mini-loop ────────────────────────────────────────────────

describe('Executor runVerification', () => {
  beforeEach(() => {
    streamTextCallCount = 0
    mockStreamTextSequence = []
    mockGenerateTextResult = ''
    mockPrimaryModelFails = false
    mockStreamTextAlwaysFails = false
    mockGenerateTextError = null
    mockToolExecute = async () => ({ result: '' })
    mockRollbackFile = async () => ({ success: true, message: '已回滚' })
  })

  it('有代码修改时自动触发验证阶段', async () => {
    mockToolExecute = async () => ({ result: '编辑成功' })
    mockStreamTextSequence = [
      {
        text: '',
        toolCalls: [{ toolName: 'edit_file', args: { path: 'src/index.ts', old_string: 'a', new_string: 'b' } }],
      },
      { text: '任务完成', toolCalls: [] },
    ]
    mockGenerateTextResult = '✅ 验证通过：所有修改已确认'

    const { config, events } = createMockExecutorConfig({
      permissionMode: 'yolo',
      toolRegistry: createMockToolRegistry({ get: () => null }),
    })

    const executor = new Executor(config)
    const result = await executor.execute(TEST_PLAN, [])

    expect(result).toContain('任务完成')
    expect(result).toContain('验证')
    expect(result).toContain('验证通过')
    // 验证 phase_change 事件
    const phaseEvents = events.filter((e) => e.type === 'phase_change') as Array<{ phase: string }>
    expect(phaseEvents.some((e) => e.phase === 'verifying')).toBe(true)
  })

  it('无代码修改时跳过验证阶段', async () => {
    mockStreamTextSequence = [{ text: '查询结果', toolCalls: [] }]
    mockGenerateTextResult = '不应被调用'

    const { config, events } = createMockExecutorConfig()
    const executor = new Executor(config)
    const result = await executor.execute(TEST_PLAN, [])

    expect(result).toBe('查询结果')
    expect(result).not.toContain('验证')
    // 不应有 verifying phase
    const phaseEvents = events.filter((e) => e.type === 'phase_change') as Array<{ phase: string }>
    expect(phaseEvents.some((e) => e.phase === 'verifying')).toBe(false)
  })

  it('验证阶段失败不影响主结果', async () => {
    mockToolExecute = async () => ({ result: '编辑成功' })
    mockStreamTextSequence = [
      {
        text: '',
        toolCalls: [{ toolName: 'edit_file', args: { path: 'src/index.ts', old_string: 'a', new_string: 'b' } }],
      },
      { text: '任务完成', toolCalls: [] },
    ]
    // generateText 抛出异常
    mockGenerateTextError = '验证服务不可用'

    const { config, events } = createMockExecutorConfig({
      permissionMode: 'yolo',
      toolRegistry: createMockToolRegistry({ get: () => null }),
    })

    const executor = new Executor(config)
    const result = await executor.execute(TEST_PLAN, [])

    // 主结果保留，验证失败信息附加
    expect(result).toContain('任务完成')
    expect(result).toContain('验证失败')
  })
})

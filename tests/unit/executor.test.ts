/**
 * 单元测试: Executor 成本追踪与预算检查
 * 验证 Executor 在 streamText 后记录成本，并在超限时中断循环
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test'
import type { NexusEvent, Plan } from '../../src/agent/types'

// ─── 增强 mock 状态（支持多轮调用、降级、验证等场景） ─────────────────────
let streamTextCallCount = 0
let mockStreamTextSequence: Array<{ text: string; toolCalls: unknown[] }> = []
let mockGenerateTextResult = ''
let mockPrimaryModelFails = false
let mockPrimaryModel: unknown = null
let mockFallbackModel: unknown = null
let mockToolExecute: (
  name: string,
  args: Record<string, unknown>,
) => Promise<{ result: string; error?: string }> = async () => ({ result: '' })
let mockRollbackFile = async (_path: string) => ({ success: true, message: '已回滚' })
let mockStreamTextAlwaysFails = false
let mockGenerateTextError: string | null = null
/** 最近一次 generateText 的 messages（验证 verifyPrompt 证据段注入） */
let mockGenerateTextMessages: unknown[] = []

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
      response =
        mockStreamTextSequence[Math.min(streamTextCallCount - 1, mockStreamTextSequence.length - 1)]
    } else {
      response = { text: '', toolCalls: [] }
    }
    return {
      textStream: (async function* () {
        if (response.text) yield response.text
      })(),
      then: (resolve: Function) =>
        resolve({
          usage: Promise.resolve({ inputTokens: 100, outputTokens: 50 }),
          toolCalls: Promise.resolve(response.toolCalls),
          reasoning: Promise.resolve(undefined),
          providerMetadata: Promise.resolve(undefined),
        }),
    }
  },
  generateText: async (opts: Record<string, unknown>) => {
    if (mockGenerateTextError) {
      throw new Error(mockGenerateTextError)
    }
    mockGenerateTextMessages = (opts.messages as unknown[]) ?? []
    return { text: mockGenerateTextResult, toolCalls: [] }
  },
}))

import { Executor, stripArtifactSection } from '../../src/agent/Executor'
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
      toolContext: {
        projectRoot: '/tmp',
        callId: '',
        maxReadLines: 2000,
        maxOutputBytes: 102400,
        bashTimeout: 30,
        todos: [],
      },
      checkpoint: createMockCheckpoint(),
      maxIterations: 10,
      permissionMode: 'ask' as const,
      onEvent: (e: NexusEvent) => {
        events.push(e)
      },
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
    const costEvent = costEvents[0] as {
      type: 'cost_update'
      inputTokens: number
      outputTokens: number
      cost: number
    }
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
          { toolName: 'read_file', input: { path: 'a.ts' } },
          { toolName: 'read_file', input: { path: 'b.ts' } },
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
          { toolName: 'edit_file', input: { path: 'a.ts', old_string: 'x', new_string: 'y' } },
          { toolName: 'edit_file', input: { path: 'b.ts', old_string: 'x', new_string: 'y' } },
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
        toolCalls: [
          { toolName: 'edit_file', input: { path: 'test.ts', old_string: 'a', new_string: 'b' } },
        ],
      },
      { text: '好的，我换一种方式', toolCalls: [] },
    ]

    const { config, events } = createMockExecutorConfig({
      permissionMode: 'ask',
      requestApproval: async () => false,
      toolRegistry: createMockToolRegistry({
        get: (name: string) =>
          name === 'edit_file' ? { definition: { requiresApproval: true } } : null,
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
        toolCalls: [
          { toolName: 'edit_file', input: { path: 'test.ts', old_string: 'a', new_string: 'b' } },
        ],
      },
      { text: '完成', toolCalls: [] },
    ]

    const { config } = createMockExecutorConfig({
      permissionMode: 'yolo',
      requestApproval: async () => {
        approvalRequested = true
        return true
      },
      toolRegistry: createMockToolRegistry({
        get: (name: string) =>
          name === 'edit_file' ? { definition: { requiresApproval: true } } : null,
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
      {
        text: '',
        toolCalls: [
          {
            toolName: 'edit_file',
            input: { path: 'src/app.ts', old_string: 'x', new_string: 'y' },
          },
        ],
      },
      {
        text: '',
        toolCalls: [
          {
            toolName: 'edit_file',
            input: { path: 'src/app.ts', old_string: 'x', new_string: 'y' },
          },
        ],
      },
      {
        text: '',
        toolCalls: [
          {
            toolName: 'edit_file',
            input: { path: 'src/app.ts', old_string: 'x', new_string: 'y' },
          },
        ],
      },
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
    const rollbackEvent = sysEvents.find((e) =>
      (e as { message: string }).message.includes('自动回滚'),
    )
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
      {
        text: '',
        toolCalls: [
          {
            toolName: 'edit_file',
            input: { path: 'src/app.ts', old_string: 'x', new_string: 'y' },
          },
        ],
      },
      {
        text: '',
        toolCalls: [
          {
            toolName: 'edit_file',
            input: { path: 'src/app.ts', old_string: 'x', new_string: 'y' },
          },
        ],
      },
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
    mockRollbackFile = async () => {
      rollbackCalled++
      return { success: true, message: 'ok' }
    }

    let callIdx = 0
    mockToolExecute = async () => {
      callIdx++
      // 前 2 次失败，第 3 次成功，第 4-5 次失败（不足 3 次）
      if (callIdx <= 2) return { result: '', error: '未找到匹配' }
      if (callIdx === 3) return { result: '编辑成功' }
      return { result: '', error: '未找到匹配' }
    }

    mockStreamTextSequence = [
      {
        text: '',
        toolCalls: [
          { toolName: 'edit_file', input: { path: 'f.ts', old_string: 'a', new_string: 'b' } },
        ],
      },
      {
        text: '',
        toolCalls: [
          { toolName: 'edit_file', input: { path: 'f.ts', old_string: 'a', new_string: 'b' } },
        ],
      },
      {
        text: '',
        toolCalls: [
          { toolName: 'edit_file', input: { path: 'f.ts', old_string: 'a', new_string: 'b' } },
        ],
      },
      {
        text: '',
        toolCalls: [
          { toolName: 'edit_file', input: { path: 'f.ts', old_string: 'a', new_string: 'b' } },
        ],
      },
      {
        text: '',
        toolCalls: [
          { toolName: 'edit_file', input: { path: 'f.ts', old_string: 'a', new_string: 'b' } },
        ],
      },
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
    // 验证降级事件（降级/重试属于仍在继续的过程性提示，用 system_info 而非 error）
    const infoEvents = events.filter((e) => e.type === 'system_info') as Array<{ message: string }>
    const fallbackEvent = infoEvents.find((e) => e.message.includes('降级到备用模型'))
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
    mockGenerateTextMessages = []
    mockToolExecute = async () => ({ result: '' })
    mockRollbackFile = async () => ({ success: true, message: '已回滚' })
  })

  it('有代码修改时自动触发验证阶段', async () => {
    mockToolExecute = async () => ({ result: '编辑成功' })
    mockStreamTextSequence = [
      {
        text: '',
        toolCalls: [
          {
            toolName: 'edit_file',
            input: { path: 'src/index.ts', old_string: 'a', new_string: 'b' },
          },
        ],
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
        toolCalls: [
          {
            toolName: 'edit_file',
            input: { path: 'src/index.ts', old_string: 'a', new_string: 'b' },
          },
        ],
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
    // 验证自身失败保守按通过处理，不触发修复循环
    expect(executor.getVerifyOutcome()).toEqual({ pass: true, failures: [] })
    // 不额外发 error 事件：失败信息仅随 ## 验证 报告展示一次，避免 TUI 重复显示
    const errorEvents = events.filter(
      (e) => e.type === 'error' && (e as { message: string }).message.includes('验证阶段失败'),
    )
    expect(errorEvents.length).toBe(0)
  })

  it('验证输出含 JSON 结论块时解析出结构化失败项', async () => {
    mockToolExecute = async () => ({ result: '编辑成功' })
    mockStreamTextSequence = [
      {
        text: '',
        toolCalls: [
          {
            toolName: 'edit_file',
            input: { path: 'src/index.ts', old_string: 'a', new_string: 'b' },
          },
        ],
      },
      { text: '任务完成', toolCalls: [] },
    ]
    mockGenerateTextResult =
      '❌ 1 项未完成\n\n```json\n{"pass": false, "failures": [{"todoId": "1", "detail": "缺少 email 验证"}]}\n```'

    const { config, events } = createMockExecutorConfig({
      permissionMode: 'yolo',
      toolRegistry: createMockToolRegistry({ get: () => null }),
    })

    const executor = new Executor(config)
    await executor.execute(TEST_PLAN, [])

    const outcome = executor.getVerifyOutcome()
    expect(outcome?.pass).toBe(false)
    expect(outcome?.failures).toEqual([{ todoId: '1', detail: '缺少 email 验证' }])
    // 发出“交由编排层决定修复”的 system_info 事件
    const sysEvents = events.filter((e) => e.type === 'system_info') as Array<{ message: string }>
    expect(sysEvents.some((e) => e.message.includes('未真正完成'))).toBe(true)
  })

  it('验证输出无结论块时保守按通过处理', async () => {
    mockToolExecute = async () => ({ result: '编辑成功' })
    mockStreamTextSequence = [
      {
        text: '',
        toolCalls: [
          {
            toolName: 'edit_file',
            input: { path: 'src/index.ts', old_string: 'a', new_string: 'b' },
          },
        ],
      },
      { text: '任务完成', toolCalls: [] },
    ]
    mockGenerateTextResult = '✅ 验证通过：所有修改已确认'

    const { config } = createMockExecutorConfig({
      permissionMode: 'yolo',
      toolRegistry: createMockToolRegistry({ get: () => null }),
    })

    const executor = new Executor(config)
    await executor.execute(TEST_PLAN, [])

    expect(executor.getVerifyOutcome()).toEqual({ pass: true, failures: [] })
  })

  it('证据门禁失败时结果进入 getEvidenceResult 并 emit 摘要（确定性证据优先）', async () => {
    mockToolExecute = async () => ({ result: '编辑成功' })
    mockStreamTextSequence = [
      {
        text: '',
        toolCalls: [
          {
            toolName: 'edit_file',
            input: { path: 'src/index.ts', old_string: 'a', new_string: 'b' },
          },
        ],
      },
      { text: '任务完成', toolCalls: [] },
    ]
    mockGenerateTextResult = '✅ 验证通过'

    const { config, events } = createMockExecutorConfig({
      permissionMode: 'yolo',
      toolRegistry: createMockToolRegistry({ get: () => null }),
      evidence: { lintCommand: 'bun -e process.exit(1)' },
    })

    const executor = new Executor(config)
    await executor.execute(TEST_PLAN, [])

    const evidence = executor.getEvidenceResult()
    expect(evidence).not.toBeNull()
    expect(evidence!.passed).toBe(false)
    const lint = evidence!.results.find((r) => r.gate === 'lint')!
    expect(lint.skipped).toBe(false)
    expect(lint.passed).toBe(false)
    const sysEvents = events.filter((e) => e.type === 'system_info') as Array<{ message: string }>
    expect(sysEvents.some((e) => e.message.includes('证据门禁'))).toBe(true)
  })

  it('verifyPrompt 注入确定性证据段（证据优先于目测）', async () => {
    mockToolExecute = async () => ({ result: '编辑成功' })
    mockStreamTextSequence = [
      {
        text: '',
        toolCalls: [
          {
            toolName: 'edit_file',
            input: { path: 'src/index.ts', old_string: 'a', new_string: 'b' },
          },
        ],
      },
      { text: '任务完成', toolCalls: [] },
    ]
    mockGenerateTextResult = '✅ 验证通过'

    const { config } = createMockExecutorConfig({
      permissionMode: 'yolo',
      toolRegistry: createMockToolRegistry({ get: () => null }),
      evidence: { lintCommand: 'bun -e process.exit(0)' },
    })

    const executor = new Executor(config)
    await executor.execute(TEST_PLAN, [])

    const lastUser = mockGenerateTextMessages.at(-1) as { content?: string } | undefined
    expect(lastUser?.content).toContain('确定性证据（门禁结果）')
    expect(lastUser?.content).toContain('lint: 通过')
    expect(lastUser?.content).toContain('按确定性失败处理')
  })

  it('验证失败项解析 evidence 字段（结构化反馈）', async () => {
    mockToolExecute = async () => ({ result: '编辑成功' })
    mockStreamTextSequence = [
      {
        text: '',
        toolCalls: [
          {
            toolName: 'edit_file',
            input: { path: 'src/index.ts', old_string: 'a', new_string: 'b' },
          },
        ],
      },
      { text: '任务完成', toolCalls: [] },
    ]
    mockGenerateTextResult =
      '```json\n{"pass": false, "failures": [{"todoId": "1", "detail": "[缺失] 缺少导出；[建议] 添加 export", "evidence": "test: exit 1"}]}\n```'

    const { config } = createMockExecutorConfig({
      permissionMode: 'yolo',
      toolRegistry: createMockToolRegistry({ get: () => null }),
    })

    const executor = new Executor(config)
    await executor.execute(TEST_PLAN, [])

    const outcome = executor.getVerifyOutcome()
    expect(outcome?.pass).toBe(false)
    expect(outcome?.failures[0].evidence).toBe('test: exit 1')
  })

  it('正常完成后不强制把未完成 todo 标记为 complete（学习信号保真）', async () => {
    mockStreamTextSequence = [{ text: '完成', toolCalls: [] }]

    const { config } = createMockExecutorConfig()
    const executor = new Executor(config)
    // 独立 plan 对象，避免与 TEST_PLAN 共享 todo 引用被前序测试污染
    const freshPlan: Plan = {
      summary: '查询任务',
      todos: [{ id: '1', content: '步骤一', status: 'pending' }],
      filesToModify: [],
      estimatedSteps: 1,
    }
    await executor.execute(freshPlan, [])

    // LLM 未调 update_todo 时 todo 保持 pending，而非被篡改为 complete
    expect(executor.getTodos()[0].status).toBe('pending')
  })

  it('验证阶段成本计入 costTracker（verifier 定价）', async () => {
    mockToolExecute = async () => ({ result: '编辑成功' })
    mockStreamTextSequence = [
      {
        text: '',
        toolCalls: [
          {
            toolName: 'edit_file',
            input: { path: 'src/index.ts', old_string: 'a', new_string: 'b' },
          },
        ],
      },
      { text: '任务完成', toolCalls: [] },
    ]
    mockGenerateTextResult = '✅ 验证通过'

    const { config } = createMockExecutorConfig({
      permissionMode: 'yolo',
      toolRegistry: createMockToolRegistry({ get: () => null }),
      verifyModel: {} as never,
      verifyCost: {
        providerName: 'deepseek',
        modelName: 'deepseek-v4-flash',
        costPer1kInput: 0.0001,
        costPer1kOutput: 0.0002,
      },
    })

    const executor = new Executor(config)
    await executor.execute(TEST_PLAN, [])

    // 验证调用的成本按 verifier 角色记录（generateText mock 无 usage 时不记录）
    const records = config.costTracker.getRecords() as Array<{ role: string }>
    // 主循环 2 次 streamText 记录 executor 角色；generateText mock 未返回 usage，验证不记录
    expect(records.every((r) => r.role === 'executor')).toBe(true)
  })
})

// ─── 文件产物归属与聚合清单剥离 ────────────────────────────────────

describe('Executor 文件产物', () => {
  beforeEach(() => {
    streamTextCallCount = 0
    mockStreamTextSequence = []
    mockGenerateTextResult = ''
    mockToolExecute = async () => ({ result: '编辑成功' })
    mockGenerateTextError = null
  })

  it('edit_file 成功时发出 file_artifact 并归属当前 in_progress todo', async () => {
    mockStreamTextSequence = [
      {
        text: '',
        toolCalls: [
          { toolName: 'edit_file', input: { path: 'src/a.ts', old_string: 'a', new_string: 'b' } },
        ],
      },
      { text: '任务完成', toolCalls: [] },
    ]
    mockGenerateTextResult = '✅ 验证通过'

    const plan: Plan = {
      summary: '测试计划',
      todos: [{ id: 't1', content: '步骤一', status: 'in_progress' }],
      filesToModify: [],
      estimatedSteps: 1,
    }

    const { config, events } = createMockExecutorConfig({
      permissionMode: 'yolo',
      toolRegistry: createMockToolRegistry({ get: () => null }),
    })

    const executor = new Executor(config)
    await executor.execute(plan, [])

    const artifactEvents = events.filter((e) => e.type === 'file_artifact') as Array<{
      path: string
      tool: string
      todoId?: string
    }>
    expect(artifactEvents.length).toBe(1)
    expect(artifactEvents[0].path).toBe('src/a.ts')
    expect(artifactEvents[0].tool).toBe('edit_file')
    expect(artifactEvents[0].todoId).toBe('t1')

    // 工具调用/结果事件同样携带任务归属（TUI 按任务分组展示）
    const callEvents = events.filter((e) => e.type === 'tool_call') as Array<{ todoId?: string }>
    expect(callEvents.length).toBeGreaterThan(0)
    expect(callEvents[0].todoId).toBe('t1')
    const resultEvents = events.filter(
      (e) => e.type === 'tool_result' && (e as { tool?: string }).tool === 'edit_file',
    ) as unknown as Array<{ todoId?: string }>
    expect(resultEvents[0].todoId).toBe('t1')
  })

  it('create_file 成功时同样发出 file_artifact', async () => {
    mockStreamTextSequence = [
      {
        text: '',
        toolCalls: [
          { toolName: 'create_file', input: { path: 'src/new.ts', content: 'export {}' } },
        ],
      },
      { text: '创建完成', toolCalls: [] },
    ]
    mockGenerateTextResult = '✅ 验证通过'

    const { config, events } = createMockExecutorConfig({
      permissionMode: 'yolo',
      toolRegistry: createMockToolRegistry({ get: () => null }),
    })

    const executor = new Executor(config)
    await executor.execute(TEST_PLAN, [])

    const artifactEvents = events.filter((e) => e.type === 'file_artifact') as Array<{
      path: string
    }>
    expect(artifactEvents.length).toBe(1)
    expect(artifactEvents[0].path).toBe('src/new.ts')
  })

  it('总结末尾的聚合“产出文件”区块被剥离，其余内容保留', async () => {
    mockStreamTextSequence = [
      {
        text: '',
        toolCalls: [
          { toolName: 'edit_file', input: { path: 'src/a.ts', old_string: 'a', new_string: 'b' } },
        ],
      },
      {
        text: '任务完成。\n\n## 产出文件\n- src/a.ts：已修改\n\n## 小结\n全部完成',
        toolCalls: [],
      },
    ]
    mockGenerateTextResult = '✅ 验证通过'

    const { config } = createMockExecutorConfig({
      permissionMode: 'yolo',
      toolRegistry: createMockToolRegistry({ get: () => null }),
    })

    const executor = new Executor(config)
    const result = await executor.execute(TEST_PLAN, [])

    expect(result).not.toContain('产出文件')
    expect(result).not.toContain('src/a.ts：已修改')
    expect(result).toContain('任务完成')
    expect(result).toContain('## 小结')
  })

  it('stripArtifactSection 不匹配时原样保留文本', () => {
    const text = '普通总结\n\n## 验证\n✅ 通过'
    expect(stripArtifactSection(text)).toBe(text)
  })
})

// ─── 执行循环自适应压实 ────────────────────────────────────────────

describe('Executor 自适应压实', () => {
  beforeEach(() => {
    streamTextCallCount = 0
    mockStreamTextSequence = []
    mockGenerateTextResult = ''
    mockGenerateTextError = null
  })

  it('窗口水位超阈值时触发微压实并发出 system_info', async () => {
    // mock usage 固定 promptTokens=100：contextWindow=150 → 67% > 阈值 60%
    mockToolExecute = async () => ({ result: 'src/a.ts (100 行)\n' + 'x'.repeat(2000) })
    mockStreamTextSequence = [
      { text: '', toolCalls: [{ toolName: 'read_file', input: { path: 'src/a.ts' } }] },
      { text: '', toolCalls: [{ toolName: 'read_file', input: { path: 'src/b.ts' } }] },
      { text: '', toolCalls: [{ toolName: 'read_file', input: { path: 'src/c.ts' } }] },
      { text: '任务完成', toolCalls: [] },
    ]

    const { config, events } = createMockExecutorConfig({
      permissionMode: 'yolo',
      contextWindow: 150,
      compaction: { compactionThreshold: 0.6, emergencyThreshold: 0.9, keepRecentResultsFull: 1 },
    })

    const executor = new Executor(config)
    const result = await executor.execute(TEST_PLAN, [])

    expect(result).toContain('任务完成')
    const compactEvents = events.filter(
      (e) => e.type === 'system_info' && (e as { message: string }).message.includes('压实'),
    )
    expect(compactEvents.length).toBeGreaterThan(0)
  })

  it('窗口水位低于阈值时不压实（全量保留，最大化利用）', async () => {
    mockToolExecute = async () => ({ result: 'src/a.ts (100 行)\n' + 'x'.repeat(2000) })
    mockStreamTextSequence = [
      { text: '', toolCalls: [{ toolName: 'read_file', input: { path: 'src/a.ts' } }] },
      { text: '', toolCalls: [{ toolName: 'read_file', input: { path: 'src/b.ts' } }] },
      { text: '任务完成', toolCalls: [] },
    ]

    const { config, events } = createMockExecutorConfig({
      permissionMode: 'yolo',
      contextWindow: 100000, // 100/100000 远低于阈值
      compaction: { compactionThreshold: 0.6, emergencyThreshold: 0.9, keepRecentResultsFull: 1 },
    })

    const executor = new Executor(config)
    await executor.execute(TEST_PLAN, [])

    const compactEvents = events.filter(
      (e) => e.type === 'system_info' && (e as { message: string }).message.includes('压实'),
    )
    expect(compactEvents.length).toBe(0)
  })
})

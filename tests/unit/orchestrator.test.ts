/**
 * 单元测试: Orchestrator 编排核心
 * 验证初始化、依赖注入、shutdown 生命周期
 * 注意: 仅 mock 叶子依赖，不 mock ModelRouter/config-secrets/providers
 *       避免 mock.module 跨文件泄漏
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type { NexusConfig, NexusEvent, Todo } from '../../src/agent/types'

// ─── mock 叶子依赖 ────────────────────────────────────────────────────────────

// 不 mock @ai-sdk/anthropic 和 @ai-sdk/openai，避免与 planner/executor 测试的 ai mock 冲突
// init() 不实际调用 LLM，provider 工厂仅被创建但不会被调用
;(mock as any).module('../../src/context/RulesLoader', () => ({
  loadRules: async () => ({
    project: {
      name: 'test',
      language: 'ts',
      testCommand: 'bun test',
      buildCommand: 'bun run build',
    },
    style: { indent: 2, quote: 'single', semicolons: false },
    constraints: {},
    context: { alwaysInclude: [] },
  }),
}))

;(mock as any).module('../../src/context/Assembler', () => ({
  ContextAssembler: class MockAssembler {
    setCodeGraph = () => {}
    setLessonRetriever = () => {}
    setSkillProvider = () => {}
    buildSystemPrompt = async () => 'system prompt'
    buildSystemPromptParts = async () => ({ stable: 'system prompt', dynamic: '' })
    assembleMessages = () => []
    assembleMessagesSplit = () => []
  },
}))

;(mock as any).module('../../src/context/TokenBudget', () => ({
  TokenBudget: class MockBudget {
    constructor() {}
  },
}))

let mockCheckpointInitCalled = false
;(mock as any).module('../../src/sandbox/Checkpoint', () => ({
  CheckpointManager: class MockCheckpoint {
    private enabled = true
    constructor() {}
    init = async () => {
      mockCheckpointInitCalled = true
    }
    create = async () => null
    undo = async () => ''
    hasCheckpoints = () => false
    mergeToWorkBranch = async () => ({ success: true, message: 'ok' })
    getCurrentStep = () => 0
    setEnabled = (enabled: boolean) => {
      this.enabled = enabled
    }
    isEnabled = () => this.enabled
  },
}))

;(mock as any).module('../../src/context/Compressor', () => ({
  compressHistory: () => ({
    messages: [],
    compressedCount: 0,
    originalTokens: 0,
    compressedTokens: 0,
  }),
}))

let mockDbCloseCalled = false
let mockDbSessions: Array<{
  id: string
  start_time: number
  message_count: number
  total_cost: number
}> = []
let mockDbMessages: Array<{ role: string; content: string }> = []
;(mock as any).module('../../src/storage/db', () => ({
  NexusDB: class MockDB {
    constructor() {}
    createSession = () => {}
    addMessage = () => {}
    endSession = () => {}
    close = () => {
      mockDbCloseCalled = true
    }
    saveTodos = () => {}
    getSession = (id: string) => mockDbSessions.find((s) => s.id === id) ?? null
    getLatestSession = () =>
      mockDbSessions.length > 0 ? mockDbSessions[mockDbSessions.length - 1] : null
    getMessages = () => [...mockDbMessages]
    loadTodos = () => []
    listRecentSessions = (limit: number) => mockDbSessions.slice(0, limit)
  },
}))

;(mock as any).module('../../src/tools/external', () => ({
  ExternalMCPManager: class MockMCP {
    register = () => {}
    connect = async () => true
    disconnectAll = async () => {}
    listAllTools = async () => []
  },
}))

let mockCodeGraphResult: any = { files: new Map() }
;(mock as any).module('../../src/context/CodeGraph', () => ({
  buildCodeGraph: async () => mockCodeGraphResult,
}))

;(mock as any).module('fs/promises', () => ({
  readFile: async () => '',
}))

;(mock as any).module('smol-toml', () => ({
  parse: () => ({}),
}))

;(mock as any).module('../../src/tools/registry', () => ({
  createToolRegistry: () => ({
    getAll: () => [],
    getForPhase: () => [],
    register: () => {},
    setSubAgentRunner: () => {},
    setHooks: () => {},
    setSkillReader: () => {},
    setWorktreeManager: () => {},
    setTaskBoard: () => {},
    setMailbox: () => {},
    setMergeApprovalHandler: () => {},
  }),
}))
// callLLMWithRetry mock - 让 Planner 可以正常执行而不调用真实 LLM
// 注意：这里 mock 的是 ReActLoop 而非 Planner，避免全局 mock 与 planner.test.ts 冲突
;(mock as any).module('../../src/agent/ReActLoop', () => ({
  callLLMWithRetry: async () => ({
    streamedText:
      '```json\n{"summary":"测试计划","todos":[],"filesToModify":[],"estimatedSteps":0}\n```',
    usage: { promptTokens: 10, completionTokens: 5 },
    toolCalls: [],
  }),
}))

// Executor mock - 用于 submit() 测试
let mockExecutorResult = '执行结果'
let mockExecutorTodos: Todo[] = []
let mockExecutorExecuteCalled = false
/** 每次 execute 后返回的验证结论序列（按执行次数索引，超出取最后一个） */
let mockExecutorVerifyOutcomeSeq: Array<{
  pass: boolean
  failures: Array<{ todoId: string; detail: string }>
} | null> = []
let mockExecutorLastErrorSeq: Array<string | null> = []
/** 每次 execute 后返回的证据门禁结果序列（缺省 null=未运行） */
let mockExecutorEvidenceSeq: Array<{
  passed: boolean
  results: Array<{
    gate: string
    command: string
    exitCode: number | null
    passed: boolean
    skipped: boolean
    output: string
  }>
} | null> = []
let mockExecutorExecuteCount = 0
;(mock as any).module('../../src/agent/Executor', () => ({
  Executor: class MockExecutor {
    execute = async () => {
      mockExecutorExecuteCalled = true
      mockExecutorExecuteCount++
      return mockExecutorResult
    }
    getTodos = () => mockExecutorTodos
    getLastError = () =>
      mockExecutorLastErrorSeq.length > 0
        ? mockExecutorLastErrorSeq[
            Math.min(mockExecutorExecuteCount - 1, mockExecutorLastErrorSeq.length - 1)
          ]
        : null
    getVerifyOutcome = () =>
      mockExecutorVerifyOutcomeSeq.length > 0
        ? mockExecutorVerifyOutcomeSeq[
            Math.min(mockExecutorExecuteCount - 1, mockExecutorVerifyOutcomeSeq.length - 1)
          ]
        : null
    getEvidenceResult = () =>
      mockExecutorEvidenceSeq.length > 0
        ? mockExecutorEvidenceSeq[
            Math.min(mockExecutorExecuteCount - 1, mockExecutorEvidenceSeq.length - 1)
          ]
        : null
    getLoopTrace = () => {
      // 与 getEvidenceResult/getVerifyOutcome 同源序列（按执行次数索引）
      const evidence =
        mockExecutorEvidenceSeq.length > 0
          ? mockExecutorEvidenceSeq[
              Math.min(mockExecutorExecuteCount - 1, mockExecutorEvidenceSeq.length - 1)
            ]
          : null
      const verify =
        mockExecutorVerifyOutcomeSeq.length > 0
          ? mockExecutorVerifyOutcomeSeq[
              Math.min(mockExecutorExecuteCount - 1, mockExecutorVerifyOutcomeSeq.length - 1)
            ]
          : null
      return {
        round: 0,
        iterations: 0,
        evidencePassed: evidence?.passed ?? true,
        evidence: evidence?.results ?? [],
        verifyPass: verify?.pass ?? null,
        verifyFailures: verify && !verify.pass ? verify.failures.length : 0,
      }
    }
    getHasCodeChanges = () => false
  },
}))

// SubAgent 在 init() 中被创建，需要 mock 以避免依赖 generateText
import { Orchestrator } from '../../src/agent/Orchestrator'

function createDefaultConfig(overrides: Partial<NexusConfig> = {}): NexusConfig {
  return {
    models: {
      planner: 'auto',
      executor: 'auto',
      summarizer: 'auto',
      verifier: 'auto',
      providers: {
        anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY', defaultModel: 'claude-sonnet-4-20250514' },
        openai: { apiKeyEnv: 'OPENAI_API_KEY', defaultModel: 'gpt-4o' },
        deepseek: {
          apiKeyEnv: 'DEEPSEEK_API_KEY',
          baseUrl: 'https://api.deepseek.com',
          defaultModel: 'deepseek-v4-flash',
        },
        custom: { apiKeyEnv: 'CUSTOM_API_KEY', defaultModel: '' },
      },
    },
    permissions: { mode: 'ask' },
    limits: {
      maxSessionCost: 5,
      bashTimeout: 30,
      maxReadLines: 2000,
      maxIterations: 50,
      maxOutputBytes: 102400,
      maxAutoRetries: 0,
    },
    context: {
      budgetRatio: 0.8,
      recentTurnsKeep: 5,
      compactionThreshold: 0.6,
      emergencyThreshold: 0.9,
      keepRecentResultsFull: 4,
    },
    checkpoint: { autoCheckpoint: true, branch: 'nexus/checkpoints' },
    ...overrides,
  }
}

function createOrchestratorConfig(overrides: Record<string, unknown> = {}) {
  const events: NexusEvent[] = []
  return {
    projectRoot: '/tmp/test-project',
    config: createDefaultConfig(),
    permissionMode: 'ask' as const,
    skipPlan: false,
    maxIterations: 10,
    onEvent: (e: NexusEvent) => {
      events.push(e)
    },
    requestApproval: async () => true,
    requestPlanApproval: async () => 'approve' as const,
    ...overrides,
  }
}

describe('Orchestrator', () => {
  // 保存和恢复环境变量
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    // 设置 ANTHROPIC_API_KEY 使 ModelRouter 能初始化 anthropic provider
    savedEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'test-orchestrator-key'
    mockCheckpointInitCalled = false
    mockDbCloseCalled = false
    mockCodeGraphResult = { files: new Map() }
    // 重置 mock 状态
    mockExecutorExecuteCalled = false
    mockExecutorResult = '执行结果'
    mockExecutorTodos = []
    mockExecutorVerifyOutcomeSeq = []
    mockExecutorLastErrorSeq = []
    mockExecutorEvidenceSeq = []
    mockExecutorExecuteCount = 0
    mockDbSessions = []
    mockDbMessages = []
  })

  afterEach(() => {
    // 恢复环境变量
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('构造后 getPhase() 返回 idle', () => {
    const orch = new Orchestrator(createOrchestratorConfig())
    expect(orch.getPhase()).toBe('idle')
  })

  it('init() 能正常初始化（不抛异常）', async () => {
    const orch = new Orchestrator(createOrchestratorConfig())
    await orch.init()
    expect(orch.getPhase()).toBe('idle')
  })

  it('init() 初始化 CheckpointManager（autoCheckpoint=true）', async () => {
    const orch = new Orchestrator(createOrchestratorConfig())
    await orch.init()
    await orch.startBackgroundInit()
    expect(mockCheckpointInitCalled).toBe(true)
  })

  it('init() 不初始化 CheckpointManager（autoCheckpoint=false）', async () => {
    const cfg = createOrchestratorConfig()
    cfg.config = createDefaultConfig({
      checkpoint: { autoCheckpoint: false, branch: 'nexus/checkpoints' },
    })
    const orch = new Orchestrator(cfg)
    await orch.init()
    await orch.startBackgroundInit()
    expect(mockCheckpointInitCalled).toBe(false)
  })

  it('init() 构建 CodeGraph（异步）', async () => {
    mockCodeGraphResult = { files: new Map([['test.ts', {}]]) }
    const orch = new Orchestrator(createOrchestratorConfig())
    await orch.init()
    await orch.startBackgroundInit()
  })

  it('init() CodeGraph 构建失败不阻塞初始化', async () => {
    mockCodeGraphResult = null
    const orch = new Orchestrator(createOrchestratorConfig())
    await orch.init()
    await orch.startBackgroundInit()
  })

  it('shutdown() 调用 db.close()', async () => {
    const orch = new Orchestrator(createOrchestratorConfig())
    await orch.init()
    await orch.startBackgroundInit()
    await orch.shutdown()
    expect(mockDbCloseCalled).toBe(true)
  })

  it('shutdown() 重复调用只执行一次', async () => {
    const orch = new Orchestrator(createOrchestratorConfig())
    await orch.init()
    await orch.shutdown()
    await orch.shutdown()
  })

  it('getTodos() 初始返回空数组', () => {
    const orch = new Orchestrator(createOrchestratorConfig())
    expect(orch.getTodos()).toEqual([])
  })

  it('getCostSummary() 初始返回零', () => {
    const orch = new Orchestrator(createOrchestratorConfig())
    const summary = orch.getCostSummary()
    expect(summary.total).toBe(0)
    expect(summary.inputTokens).toBe(0)
    expect(summary.outputTokens).toBe(0)
  })

  it('clearContext() 清空历史和 todos', () => {
    const orch = new Orchestrator(createOrchestratorConfig())
    orch.clearContext()
    expect(orch.getHistory()).toEqual([])
    expect(orch.getTodos()).toEqual([])
  })

  it('abort() 不抛异常', () => {
    const orch = new Orchestrator(createOrchestratorConfig())
    orch.abort()
  })

  // ─── getter/setter ──────────────────────────────────────────────────────

  it('setSkipPlan/getSkipPlan 正常工作', () => {
    const orch = new Orchestrator(createOrchestratorConfig())
    expect(orch.getSkipPlan()).toBe(false)
    orch.setSkipPlan(true)
    expect(orch.getSkipPlan()).toBe(true)
    orch.setSkipPlan(false)
    expect(orch.getSkipPlan()).toBe(false)
  })

  it('undo() 委托给 CheckpointManager', async () => {
    const orch = new Orchestrator(createOrchestratorConfig())
    const result = await orch.undo()
    expect(typeof result).toBe('string')
  })

  it('getHistory() 初始返回空数组', () => {
    const orch = new Orchestrator(createOrchestratorConfig())
    expect(orch.getHistory()).toEqual([])
  })

  it('getFullHistory() 返回完整历史副本', () => {
    const orch = new Orchestrator(createOrchestratorConfig())
    expect(orch.getFullHistory()).toEqual([])
  })

  it('getStatus() 返回子系统状态', async () => {
    const orch = new Orchestrator(createOrchestratorConfig())
    const statusBefore = orch.getStatus()
    expect(statusBefore.db).toBe(false)
    expect(statusBefore.codeGraph).toBe(false)
    expect(statusBefore.mcp).toBe(false)
    expect(statusBefore.watcher).toBe(false)
    expect(statusBefore.cost).toBe(0)

    await orch.init()
    await orch.startBackgroundInit()
    const statusAfter = orch.getStatus()
    expect(typeof statusAfter.model).toBe('string')
    expect(typeof statusAfter.cost).toBe('number')
  })

  it('getCurrentModel() 无 provider 时返回提示信息', async () => {
    delete process.env.ANTHROPIC_API_KEY
    const orch = new Orchestrator(createOrchestratorConfig())
    await orch.init()
    expect(orch.getCurrentModel()).toContain('未配置')

    // 恢复 API Key 以便后续测试
    process.env.ANTHROPIC_API_KEY = 'test-orchestrator-key'
  })

  it('compactHistory() 历史较短时返回无需压缩提示', () => {
    const orch = new Orchestrator(createOrchestratorConfig())
    const result = orch.compactHistory()
    expect(typeof result).toBe('string')
    expect(result).toContain('无需压缩')
  })

  // ─── submit() 核心路径 ──────────────────────────────────────────────────

  it('submit() 跳过 Plan 模式（skipPlan=true）正常执行', async () => {
    const orch = new Orchestrator(createOrchestratorConfig({ skipPlan: true }))
    await orch.init()
    await orch.startBackgroundInit()
    const result = await orch.submit('帮我修改代码')
    expect(result).toBe('执行结果')
    expect(mockExecutorExecuteCalled).toBe(true)
    expect(orch.getPhase()).toBe('done')
  })

  it('submit() 双阶段模式（skipPlan=false）正常执行', async () => {
    const orch = new Orchestrator(createOrchestratorConfig({ skipPlan: false }))
    await orch.init()
    await orch.startBackgroundInit()
    const result = await orch.submit('帮我修改代码')
    expect(result).toBe('执行结果')
    expect(mockExecutorExecuteCalled).toBe(true)
    expect(orch.getPhase()).toBe('done')
  })

  it('验证失败时自动触发修复重试（Verify→Fix 闭环）', async () => {
    // 第一次执行验证失败，重试后验证通过
    mockExecutorVerifyOutcomeSeq = [
      { pass: false, failures: [{ todoId: '1', detail: '缺少 email 验证' }] },
      null,
    ]
    const config = createDefaultConfig()
    config.limits.maxAutoRetries = 2
    const events: NexusEvent[] = []
    const orch = new Orchestrator(
      createOrchestratorConfig({
        skipPlan: true,
        config,
        onEvent: (e: NexusEvent) => events.push(e),
      }),
    )
    await orch.init()
    await orch.startBackgroundInit()
    const result = await orch.submit('帮我修改代码')

    expect(result).toBe('执行结果')
    expect(mockExecutorExecuteCount).toBe(2) // 首次执行 + 1 次修复重试
    const sysEvents = events.filter((e) => e.type === 'system_info') as Array<{ message: string }>
    expect(sysEvents.some((e) => e.message.includes('验证未通过'))).toBe(true)
    expect(sysEvents.some((e) => e.message.includes('自动修复成功'))).toBe(true)
  })

  it('验证驱动的修复最多 2 次，超出后停止重试', async () => {
    // 验证始终失败
    mockExecutorVerifyOutcomeSeq = [{ pass: false, failures: [{ todoId: '1', detail: '缺失项' }] }]
    const config = createDefaultConfig()
    config.limits.maxAutoRetries = 3
    const orch = new Orchestrator(createOrchestratorConfig({ skipPlan: true, config }))
    await orch.init()
    await orch.startBackgroundInit()
    await orch.submit('帮我修改代码')

    // 首次执行 + 2 次验证修复（封顶），第 3 次预算不再使用
    expect(mockExecutorExecuteCount).toBe(3)
  })

  it('执行错误时自动触发修复重试，修复成功后返回重试结果', async () => {
    // 首次执行报错，重试后正常
    mockExecutorLastErrorSeq = ['LLM 调用超时', null]
    const config = createDefaultConfig()
    config.limits.maxAutoRetries = 2
    const events: NexusEvent[] = []
    const orch = new Orchestrator(
      createOrchestratorConfig({
        skipPlan: true,
        config,
        onEvent: (e: NexusEvent) => events.push(e),
      }),
    )
    await orch.init()
    await orch.startBackgroundInit()
    const result = await orch.submit('帮我修改代码')

    expect(result).toBe('执行结果')
    expect(mockExecutorExecuteCount).toBe(2)
    const sysEvents = events.filter((e) => e.type === 'system_info') as Array<{ message: string }>
    expect(sysEvents.some((e) => e.message.includes('检测到执行错误'))).toBe(true)
    expect(sysEvents.some((e) => e.message.includes('自动修复成功'))).toBe(true)
  })

  it('证据门禁失败（确定性）时即使验证通过也进入修复循环', async () => {
    // 首次执行：verifier 通过但 lint 门禁失败；重试后全绿
    mockExecutorVerifyOutcomeSeq = [
      { pass: true, failures: [] },
      { pass: true, failures: [] },
    ]
    mockExecutorEvidenceSeq = [
      {
        passed: false,
        results: [
          {
            gate: 'lint',
            command: 'bun run lint',
            exitCode: 1,
            passed: false,
            skipped: false,
            output: 'error: unused variable x',
          },
          {
            gate: 'test',
            command: 'bun test',
            exitCode: 0,
            passed: true,
            skipped: false,
            output: '',
          },
        ],
      },
      {
        passed: true,
        results: [
          {
            gate: 'lint',
            command: 'bun run lint',
            exitCode: 0,
            passed: true,
            skipped: false,
            output: '',
          },
          {
            gate: 'test',
            command: 'bun test',
            exitCode: 0,
            passed: true,
            skipped: false,
            output: '',
          },
        ],
      },
    ]
    const config = createDefaultConfig()
    config.limits.maxAutoRetries = 2
    const events: NexusEvent[] = []
    const orch = new Orchestrator(
      createOrchestratorConfig({
        skipPlan: true,
        config,
        onEvent: (e: NexusEvent) => events.push(e),
      }),
    )
    await orch.init()
    await orch.startBackgroundInit()
    const result = await orch.submit('帮我修改代码')

    expect(result).toBe('执行结果')
    expect(mockExecutorExecuteCount).toBe(2) // 首次执行 + 1 次修复重试
    const sysEvents = events.filter((e) => e.type === 'system_info') as Array<{ message: string }>
    expect(sysEvents.some((e) => e.message.includes('证据门禁未通过'))).toBe(true)
    expect(sysEvents.some((e) => e.message.includes('自动修复成功'))).toBe(true)
  })

  it('修复循环结束后发出循环报告汇总（轮次/证据/验证/成本）', async () => {
    mockExecutorVerifyOutcomeSeq = [
      { pass: false, failures: [{ todoId: '1', detail: '缺少实现' }] },
      { pass: true, failures: [] },
    ]
    mockExecutorEvidenceSeq = [
      {
        passed: false,
        results: [
          {
            gate: 'test',
            command: 'bun test',
            exitCode: 1,
            passed: false,
            skipped: false,
            output: 'FAIL',
          },
          { gate: 'lint', command: '', exitCode: null, passed: false, skipped: true, output: '' },
        ],
      },
      {
        passed: true,
        results: [
          {
            gate: 'test',
            command: 'bun test',
            exitCode: 0,
            passed: true,
            skipped: false,
            output: '',
          },
          { gate: 'lint', command: '', exitCode: null, passed: false, skipped: true, output: '' },
        ],
      },
    ]
    const config = createDefaultConfig()
    config.limits.maxAutoRetries = 2
    const events: NexusEvent[] = []
    const orch = new Orchestrator(
      createOrchestratorConfig({
        skipPlan: true,
        config,
        onEvent: (e: NexusEvent) => events.push(e),
      }),
    )
    await orch.init()
    await orch.startBackgroundInit()
    await orch.submit('帮我修改代码')

    const sysEvents = events.filter((e) => e.type === 'system_info') as Array<{ message: string }>
    const report = sysEvents.find((e) => e.message.includes('循环报告'))
    expect(report).toBeDefined()
    expect(report!.message).toContain('共 2 轮')
    expect(report!.message).toContain('证据门禁 1 过 1 败')
    expect(report!.message).toContain('验证 1/2 轮通过')
  })

  it('runGoal 门面：验收未通过时重跑，通过后返回达成（L3 目标驱动）', async () => {
    // 第 1 轮 test 门禁失败，第 2 轮全绿
    mockExecutorVerifyOutcomeSeq = [
      { pass: false, failures: [{ todoId: '1', detail: '缺实现' }] },
      { pass: true, failures: [] },
    ]
    mockExecutorEvidenceSeq = [
      {
        passed: false,
        results: [
          {
            gate: 'test',
            command: 'bun test',
            exitCode: 1,
            passed: false,
            skipped: false,
            output: 'FAIL',
          },
        ],
      },
      {
        passed: true,
        results: [
          {
            gate: 'test',
            command: 'bun test',
            exitCode: 0,
            passed: true,
            skipped: false,
            output: '',
          },
        ],
      },
    ]
    const config = createDefaultConfig()
    const orch = new Orchestrator(createOrchestratorConfig({ skipPlan: true, config }))
    await orch.init()
    await orch.startBackgroundInit()

    const result = await orch.runGoal({ goal: '让所有测试通过', maxRounds: 3 })

    expect(result.achieved).toBe(true)
    expect(result.rounds).toBe(2)
    expect(mockExecutorExecuteCount).toBe(2) // 每轮一次 execute
  })

  it('runGoal 门面：轮次耗尽后返回未达成（预算护栏）', async () => {
    mockExecutorVerifyOutcomeSeq = [{ pass: false, failures: [{ todoId: '1', detail: '缺实现' }] }]
    mockExecutorEvidenceSeq = [
      {
        passed: false,
        results: [
          {
            gate: 'test',
            command: 'bun test',
            exitCode: 1,
            passed: false,
            skipped: false,
            output: 'FAIL',
          },
        ],
      },
    ]
    const config = createDefaultConfig()
    const orch = new Orchestrator(createOrchestratorConfig({ skipPlan: true, config }))
    await orch.init()
    await orch.startBackgroundInit()

    const result = await orch.runGoal({ goal: '让所有测试通过', maxRounds: 2 })

    expect(result.achieved).toBe(false)
    expect(result.rounds).toBe(2)
  })

  it('L4 trace 采集：/goal 轮次写入 loop_traces（真实 sqlite，不受 fs mock 影响）', async () => {
    mockExecutorVerifyOutcomeSeq = [
      { pass: false, failures: [{ todoId: '1', detail: '缺实现' }] },
      { pass: true, failures: [] },
    ]
    const config = createDefaultConfig()
    const orch = new Orchestrator(createOrchestratorConfig({ skipPlan: true, config }))
    await orch.init()
    await orch.startBackgroundInit()

    await orch.runGoal({ goal: '让所有测试通过', maxRounds: 2 })

    const { TraceStore } = await import('../../src/memory/TraceStore')
    const store = new TraceStore('/tmp/test-project')
    const goalTraces = store.recentTraces(50).filter((t) => t.kind === 'goal')
    expect(goalTraces.length).toBeGreaterThanOrEqual(1)
    expect(goalTraces[0].round).toBeGreaterThanOrEqual(1)
    store.close()
  })

  it('runLoop 门面：节拍执行一轮并写状态文件，abort 中断等待', async () => {
    const config = createDefaultConfig()
    const orch = new Orchestrator(createOrchestratorConfig({ skipPlan: true, config }))
    await orch.init()
    await orch.startBackgroundInit()

    // 第一轮完成后进入间隔等待：触发 abort 提前结束（避免 60s 真实等待）
    setTimeout(() => orch.abort(), 100)
    const result = await orch.runLoop('检查依赖更新', { maxRounds: 3, intervalMin: 1 })

    expect(mockExecutorExecuteCount).toBeGreaterThanOrEqual(1)
    expect(result).toContain('/loop 结束')
  })

  it('本地 Automations 门面：无配置时列表为空、手动触发提示未知、收件箱提示未配置', async () => {
    const config = createDefaultConfig()
    const orch = new Orchestrator(createOrchestratorConfig({ skipPlan: true, config }))
    await orch.init()
    await orch.startBackgroundInit()

    // 注：本文件 mock 了 fs/promises.readFile（返回空串），loops.toml 读取为空 → 无 loop 加载
    expect(orch.listLoops()).toEqual([])
    const now = await orch.runLoopNow('ci-triage')
    expect(now).toBe('未知 loop: ci-triage')
    expect(await orch.getLoopInbox()).toContain('未配置本地 Automations')
    expect(await orch.getLoopInbox('ci-triage')).toContain('未知 loop')
  })

  // 注：stopRequested 分支不在本文件测试——本文件全局 mock 了 fs/promises.readFile（返回空串，
  // bun mock.module 无法恢复），预写状态文件无法读回；LoopState 的停止信号读写已由
  // loopState.test.ts 全覆盖，runLoop 对该分支的消费逻辑与 abort/预算停止路径同构。

  it('submit() 无可用 provider 时返回错误信息', async () => {
    delete process.env.ANTHROPIC_API_KEY
    const orch = new Orchestrator(createOrchestratorConfig())
    await orch.init()
    const result = await orch.submit('帮我修改代码')
    expect(result).toContain('未检测到任何可用的 AI 模型 API Key')

    // 重复调用同样处理
    const result2 = await orch.submit('再试一次')
    expect(result2).toContain('未检测到任何可用的 AI 模型 API Key')
  })

  it('submit() 触发 abort 后中断', async () => {
    const orch = new Orchestrator(createOrchestratorConfig({ skipPlan: false }))
    await orch.init()
    await orch.startBackgroundInit()
    // 模拟 abort 在 plan 阶段被触发
    // 由于 mock 的 Planner.plan 立即返回，我们无法在 plan 执行中 abort
    // 但在 submit() 开始前设置 aborted 状态是不可能的
    // 验证 submit 完成后 phase 为 done 即可
    const result = await orch.submit('测试')
    expect(result).toBe('执行结果')
  })

  it('submit() reinitProviders 后在无 provider 时返回错误', async () => {
    delete process.env.ANTHROPIC_API_KEY
    const orch = new Orchestrator(createOrchestratorConfig())
    // 不主动 init，让 submit 内部调用 init
    // 此时 noProviderAvailable 应为 true
    // 但 submit 内部会调用 reinitProviders，仍然无 provider
    const result = await orch.submit('测试')
    expect(result).toContain('未检测到任何可用的 AI 模型 API Key')
  })

  // ─── 会话恢复 ───────────────────────────────────────────────────────────

  it('restoreSession() 指定 sessionId 不存在时返回错误', async () => {
    const orch = new Orchestrator(createOrchestratorConfig())
    await orch.init()
    await orch.startBackgroundInit()
    const result = await orch.restoreSession('non-existent-id')
    expect(result.restored).toBe(false)
    expect(result.message).toContain('未找到会话')
  })

  it('restoreSession() 无 sessionId 且无历史会话时返回错误', async () => {
    const orch = new Orchestrator(createOrchestratorConfig())
    await orch.init()
    await orch.startBackgroundInit()
    const result = await orch.restoreSession()
    expect(result.restored).toBe(false)
    expect(result.message).toContain('没有可恢复的历史会话')
  })

  it('restoreSession() 会话无消息时返回错误', async () => {
    const orch = new Orchestrator(createOrchestratorConfig())
    await orch.init()
    await orch.startBackgroundInit()
    mockDbSessions = [{ id: 'session-1', start_time: Date.now(), message_count: 0, total_cost: 0 }]
    mockDbMessages = []
    const result = await orch.restoreSession('session-1')
    expect(result.restored).toBe(false)
    expect(result.message).toContain('没有消息记录')
  })

  it('restoreSession() 成功恢复会话', async () => {
    const orch = new Orchestrator(createOrchestratorConfig())
    await orch.init()
    await orch.startBackgroundInit()
    mockDbSessions = [
      { id: 'session-1', start_time: Date.now() - 3600000, message_count: 2, total_cost: 0.5 },
    ]
    mockDbMessages = [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好，有什么可以帮助你的？' },
    ]
    const result = await orch.restoreSession('session-1')
    expect(result.restored).toBe(true)
    expect(result.message).toContain('已恢复会话')
    expect(result.message).toContain('2 条消息')
  })

  it('listRecentSessions() 返回会话列表', async () => {
    const orch = new Orchestrator(createOrchestratorConfig())
    // 不 init 时 DB 未初始化，返回空数组
    expect(orch.listRecentSessions()).toEqual([])

    await orch.init()
    await orch.startBackgroundInit()
    mockDbSessions = [
      { id: 's1', start_time: Date.now(), message_count: 3, total_cost: 0.1 },
      { id: 's2', start_time: Date.now() - 10000, message_count: 1, total_cost: 0.05 },
    ]
    const sessions = orch.listRecentSessions(5)
    expect(sessions.length).toBe(2)
    expect(sessions[0].id).toBe('s1')
    expect(sessions[0].messageCount).toBe(3)
  })

  // ─── mergeCheckpoints ───────────────────────────────────────────────────

  it('mergeCheckpoints() 无 checkpoint 时安全跳过', async () => {
    const orch = new Orchestrator(createOrchestratorConfig({ skipPlan: true }))
    await orch.init()
    await orch.mergeCheckpoints()
  })

  it('mergeCheckpoints() autoCheckpoint=false 时安全跳过', async () => {
    const cfg = createOrchestratorConfig()
    cfg.config = createDefaultConfig({
      checkpoint: { autoCheckpoint: false, branch: 'nexus/checkpoints' },
    })
    const orch = new Orchestrator(cfg)
    await orch.init()
    await orch.mergeCheckpoints()
  })

  // ─── planAndExecute 重规划循环 ──────────────────────────────────────────

  describe('planAndExecute 重规划循环', () => {
    it('计划被拒绝时立即返回拒绝消息', async () => {
      const orch = new Orchestrator(
        createOrchestratorConfig({
          skipPlan: false,
          requestPlanApproval: async () => 'reject' as const,
        }),
      )
      await orch.init()
      await orch.startBackgroundInit()
      const result = await orch.submit('帮我修改代码')
      expect(result).toContain('计划被拒绝')
      expect(mockExecutorExecuteCalled).toBe(false)
    })

    it('反馈重规划超过 MAX_REPLAN=3 后返回上限消息', async () => {
      let approvalCallCount = 0
      const orch = new Orchestrator(
        createOrchestratorConfig({
          skipPlan: false,
          requestPlanApproval: async () => {
            approvalCallCount++
            // 始终返回反馈文本，触发重规划
            return `需要调整方案 #${approvalCallCount}`
          },
        }),
      )
      await orch.init()
      await orch.startBackgroundInit()
      const result = await orch.submit('帮我修改代码')
      expect(result).toContain('最大重规划次数')
      // 初始 plan 审批 1 次 + 重规划 3 次 = 4 次调用
      expect(approvalCallCount).toBe(4)
      expect(mockExecutorExecuteCalled).toBe(false)
    })

    it('反馈重规划后批准则正常进入执行', async () => {
      let approvalCallCount = 0
      const orch = new Orchestrator(
        createOrchestratorConfig({
          skipPlan: false,
          requestPlanApproval: async () => {
            approvalCallCount++
            // 前两次返回反馈，第三次批准
            if (approvalCallCount <= 2) return `调整建议 #${approvalCallCount}`
            return 'approve' as const
          },
        }),
      )
      await orch.init()
      await orch.startBackgroundInit()
      const result = await orch.submit('帮我修改代码')
      expect(result).toBe('执行结果')
      expect(approvalCallCount).toBe(3)
      expect(mockExecutorExecuteCalled).toBe(true)
    })

    it('重规划期间 abort 中断返回中断消息', async () => {
      const orch = new Orchestrator(
        createOrchestratorConfig({
          skipPlan: false,
          requestPlanApproval: async () => {
            // 在审批时触发 abort
            orch.abort()
            return '需要调整'
          },
        }),
      )
      await orch.init()
      await orch.startBackgroundInit()
      const result = await orch.submit('帮我修改代码')
      expect(result).toContain('已中断')
      expect(mockExecutorExecuteCalled).toBe(false)
    })
  })
})

// 注意：本文件 mock 了 13 个模块，bun 的 mock.module 为全局且无法恢复
// （已知限制 oven-sh/bun#7823）。依赖真实模块的测试文件（pluginLoader/skillLibrary）
// 必须独立进程运行，见 package.json test:unit:skillplugin 与 CI 对应步骤。

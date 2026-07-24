/**
 * 单元测试: Orchestrator 编排核心
 * 验证初始化、依赖注入、shutdown 生命周期
 * 注意: 仅 mock 叶子依赖，不 mock ModelRouter/config-secrets/providers
 *       避免 mock.module 跨文件泄漏
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import type { NexusConfig, NexusEvent } from '../../src/agent/types'

// ─── mock 叶子依赖 ────────────────────────────────────────────────────────────

// 不 mock @ai-sdk/anthropic 和 @ai-sdk/openai，避免与 planner/executor 测试的 ai mock 冲突
// init() 不实际调用 LLM，provider 工厂仅被创建但不会被调用

(mock as any).module('../../src/context/RulesLoader', () => ({
  loadRules: async () => ({
    project: { name: 'test', language: 'ts', testCommand: 'bun test', buildCommand: 'bun run build' },
    style: { indent: 2, quote: 'single', semicolons: false },
    constraints: {},
    context: { alwaysInclude: [] },
  }),
}));

(mock as any).module('../../src/context/Assembler', () => ({
  ContextAssembler: class MockAssembler {
    setCodeGraph = () => {}
    buildSystemPrompt = async () => 'system prompt'
    assembleMessages = () => []
  },
}));

(mock as any).module('../../src/context/TokenBudget', () => ({
  TokenBudget: class MockBudget {
    constructor() {}
  },
}));

let mockCheckpointInitCalled = false
;(mock as any).module('../../src/sandbox/Checkpoint', () => ({
  CheckpointManager: class MockCheckpoint {
    private enabled = true
    constructor() {}
    init = async () => { mockCheckpointInitCalled = true }
    create = async () => null
    undo = async () => ''
    hasCheckpoints = () => false
    mergeToWorkBranch = async () => ({ success: true, message: 'ok' })
    getCurrentStep = () => 0
    setEnabled = (enabled: boolean) => { this.enabled = enabled }
    isEnabled = () => this.enabled
  },
}));

(mock as any).module('../../src/context/Compressor', () => ({
  compressHistory: () => ({ messages: [], compressedCount: 0, originalTokens: 0, compressedTokens: 0 }),
}));

let mockDbCloseCalled = false
;(mock as any).module('../../src/storage/db', () => ({
  NexusDB: class MockDB {
    constructor() {}
    getRecentSessions = () => []
    createSession = () => {}
    addMessage = () => {}
    endSession = () => {}
    close = () => { mockDbCloseCalled = true }
  },
}));

(mock as any).module('../../src/tools/external', () => ({
  ExternalMCPManager: class MockMCP {
    register = () => {}
    connect = async () => true
    disconnectAll = async () => {}
    listAllTools = async () => []
  },
}));

let mockCodeGraphResult: any = { files: new Map() }
;(mock as any).module('../../src/context/CodeGraph', () => ({
  buildCodeGraph: async () => mockCodeGraphResult,
}));

(mock as any).module('fs/promises', () => ({
  readFile: async () => '',
}));

(mock as any).module('smol-toml', () => ({
  parse: () => ({}),
}));

(mock as any).module('../../src/tools/registry', () => ({
  createToolRegistry: () => ({
    getAll: () => [],
    getForPhase: () => [],
    register: () => {},
    setSubAgentRunner: () => {},
  }),
}));

// 不 mock Planner/Executor，它们仅在 submit() 中使用，本测试不调用 submit()
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
        deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-chat' },
        custom: { apiKeyEnv: 'CUSTOM_API_KEY', defaultModel: '' },
      },
    },
    permissions: { mode: 'ask' },
    limits: { maxSessionCost: 5, bashTimeout: 30, maxReadLines: 2000, maxIterations: 50, maxOutputBytes: 102400 },
    context: { budgetRatio: 0.8, recentTurnsKeep: 5 },
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
    onEvent: (e: NexusEvent) => { events.push(e) },
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
    cfg.config = createDefaultConfig({ checkpoint: { autoCheckpoint: false, branch: 'nexus/checkpoints' } })
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
})

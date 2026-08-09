/**
 * Orchestrator - Agent 编排核心
 * 协调 Plan/Execute 双阶段、子 Agent 分派、检查点管理
 */

import { readFile } from 'fs/promises'
import { join } from 'path'
import { parse } from 'smol-toml'
import { loadSecrets, type SecretsConfig } from '../config-secrets'
import { ContextAssembler } from '../context/Assembler'
import { buildCodeGraph, type CodeGraph, updateCodeGraph } from '../context/CodeGraph'
import { compressHistory, llmCompressHistory } from '../context/Compressor'
import { FileWatcher } from '../context/FileWatcher'
import { loadRules } from '../context/RulesLoader'
import { closeSemanticSearchEngine } from '../context/SemanticSearch'
import { estimateTokens, TokenBudget } from '../context/TokenBudget'
import { CostTracker } from '../router/CostTracker'
import { ModelRouter } from '../router/ModelRouter'
import { getProvider } from '../router/providers'
import { CheckpointManager } from '../sandbox/Checkpoint'
import { WorktreeManager } from '../sandbox/WorktreeManager'
import { ExternalMCPManager, type ExternalServerConfig } from '../tools/external'
import { createToolRegistry, type ToolContext } from '../tools/registry'
import { logError } from '../utils/debugLog'
import { recordError } from '../utils/errorReport'
import { AgentEngineRegistry } from './AgentEngine'
import { loadAgentEngineConfigs } from './agentsConfig'
import { type EvidenceResult, formatEvidenceSummary } from './EvidenceGate'
import {
  Executor,
  type ExecutorConfig,
  type ToolApprovalDecision,
  type VerifyFailure,
} from './Executor'
import { type ExecutionSignals, GoalLoop, type GoalLoopResult } from './GoalLoop'
import { LearningManager } from './LearningManager'
import { type LoopConfig, LoopConfigLoader } from './LoopConfigLoader'
import { type LoopRuntimeInfo, LoopScheduler } from './LoopScheduler'
import { LoopState } from './LoopState'
import { Mailbox } from './Mailbox'
import { Planner } from './Planner'
import { loadPlugins, type PluginManifest } from './PluginLoader'
import { SessionManager } from './SessionManager'
import { SubAgent } from './SubAgent'
import { TaskBoard } from './TaskBoard'
import type {
  AgentPhase,
  ChatMessage,
  LoopTraceRound,
  NexusConfig,
  NexusEvent,
  PermissionMode,
  Plan,
  ProjectRules,
  Todo,
} from './types'

/** 轨迹摘要优先提取的参数键（按常见工具的关键参数排序） */
const TRACE_PRIMARY_ARG_KEYS = ['path', 'command', 'pattern', 'query', 'url']

/** 可中断等待：Ctrl+C（abortSignal）时提前返回，用于 /loop 间隔等待 */
function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

/** 把工具参数压缩为轨迹摘要（首选关键参数，否则取 JSON 前缀） */
function summarizeToolArgs(params: Record<string, unknown>): string {
  for (const key of TRACE_PRIMARY_ARG_KEYS) {
    const value = params[key]
    if (typeof value === 'string' && value.length > 0) {
      const flat = value.replace(/\s+/g, ' ')
      return `${key}=${flat.length > 80 ? `${flat.slice(0, 80)}…` : flat}`
    }
  }
  try {
    const json = JSON.stringify(params)
    return json.length > 80 ? `${json.slice(0, 80)}…` : json
  } catch {
    return ''
  }
}

export interface OrchestratorConfig {
  projectRoot: string
  config: NexusConfig
  permissionMode: PermissionMode
  skipPlan: boolean
  maxIterations: number
  onEvent: (event: NexusEvent) => void
  requestApproval: (
    tool: string,
    params: Record<string, unknown>,
    diff?: string,
  ) => Promise<ToolApprovalDecision>
  /** 计划审批：返回 'approve' | 'reject' | 反馈文本（反馈文本触发重规划） */
  requestPlanApproval: (plan: Plan) => Promise<'approve' | 'reject' | string>
}

export class Orchestrator {
  private cfg: OrchestratorConfig
  private phase: AgentPhase = 'idle'
  private history: ChatMessage[] = []
  private todos: Todo[] = []
  private toolRegistry = createToolRegistry()
  private costTracker = new CostTracker()
  private router: ModelRouter | null = null
  private secrets: SecretsConfig = { providers: {} }
  private checkpoint: CheckpointManager
  private assembler: ContextAssembler | null = null
  private rules: ProjectRules | null = null
  private aborted = false
  /** 会话持久化管理（封装 NexusDB，失败静默降级） */
  private sessionManager: SessionManager
  private shutdownCalled = false
  private subAgent: SubAgent | null = null
  private engineRegistry: AgentEngineRegistry | null = null
  private mcpManager: ExternalMCPManager | null = null
  private codeGraph: CodeGraph | null = null
  private fileWatcher: FileWatcher | null = null
  private noProviderAvailable = false
  /** 最近一次执行的关键信号（学习系统 outcome 判定 + /goal 验收判定共用） */
  private lastRunStats: {
    hasCodeChanges: boolean
    executionError: string | null
    evidencePassed: boolean | null
    evidenceSummary: string
    evidence: EvidenceResult[]
    verifyPass: boolean | null
  } = {
    hasCodeChanges: false,
    executionError: null,
    evidencePassed: null,
    evidenceSummary: '',
    evidence: [],
    verifyPass: null,
  }
  /** 本轮工具轨迹（轮次结束后压缩为摘要注入 history 与 DB，支撑跨轮/会话恢复后的上下文） */
  private turnToolTrace: Array<{ callId: string; tool: string; argsSummary: string; ok: boolean }> =
    []
  /** 本会话上下文利用率峰值（prompt token / 窗口，供 eval 报告量化观测） */
  private peakContextUtilization = 0
  /** 已加载的插件清单（/plugins 展示） */
  private plugins: PluginManifest[] = []
  /** 学习系统管理（经验/教训/技能，异步旁路，失败仅告警） */
  private learningManager = new LearningManager()
  /** 多智能体协作基础设施：worktree 隔离 / 共享任务板 / 信箱（会话级） */
  private worktreeManager: WorktreeManager
  private taskBoard = new TaskBoard()
  private mailbox = new Mailbox()
  /** 本地 Automations 会话内调度器（loops.toml 心跳；未配置时为 null） */
  private loopScheduler: LoopScheduler | null = null
  /** 是否跳过 Plan 阶段（运行时可切换） */
  private skipPlan: boolean
  /** 中断控制器（abort() 时触发，传递给 Executor/Planner 的 streamText） */
  private abortController: AbortController | null = null

  constructor(cfg: OrchestratorConfig) {
    this.cfg = cfg
    this.skipPlan = cfg.skipPlan
    this.checkpoint = new CheckpointManager(cfg.projectRoot, cfg.config.checkpoint.branch)
    this.checkpoint.setEnabled(cfg.config.checkpoint.autoCheckpoint)
    this.sessionManager = new SessionManager(cfg.projectRoot)
    this.worktreeManager = new WorktreeManager(cfg.projectRoot)
    // 工具钩子（config.toml [hooks]，供 CI/外部循环编排）
    this.toolRegistry.setHooks(cfg.config.hooks)
    // 多智能体协作装配：worktree 隔离 + 任务板 + 信箱 + 合并审批（接入 TUI 审批面板）
    this.toolRegistry.setWorktreeManager(this.worktreeManager)
    this.toolRegistry.setTaskBoard(this.taskBoard)
    this.toolRegistry.setMailbox(this.mailbox)
    this.toolRegistry.setMergeApprovalHandler(async (diffSummary, branchCount) => {
      // 工具层 merge 审批接口为 boolean，此处归一化 decision（拒绝原因暂不传递）
      const decision = await this.cfg.requestApproval('git_merge', { branchCount }, diffSummary)
      return typeof decision === 'boolean' ? decision : decision.approved
    })
  }

  /** 设置是否跳过 Plan 阶段（运行时切换 plan/auto 模式） */
  setSkipPlan(skip: boolean): void {
    this.skipPlan = skip
  }

  /** 获取当前是否跳过 Plan 阶段 */
  getSkipPlan(): boolean {
    return this.skipPlan
  }

  /** 初始化:加载 secrets、规则、构建上下文组装器（仅关键路径，快速完成） */
  async init(): Promise<void> {
    // 加载 API Key secrets(全局 ~/.nexus/secrets.toml)
    this.secrets = await loadSecrets(this.cfg.projectRoot)
    // 用 secrets 初始化 ModelRouter,确保 DeepSeek 等 provider 正确注册
    this.router = new ModelRouter(this.cfg.config, this.costTracker, this.secrets)

    this.rules = await loadRules(this.cfg.projectRoot)
    const contextWindow = this.router.getContextWindow('executor')
    const budget = new TokenBudget(contextWindow, this.cfg.config.context.budgetRatio)

    this.assembler = new ContextAssembler({
      projectRoot: this.cfg.projectRoot,
      rules: this.rules,
      tools: this.toolRegistry.getAll(),
      budget,
      recentTurnsKeep: this.cfg.config.context.recentTurnsKeep,
    })

    // 构建子智能体引擎注册表（内置引擎 + .nexus/agents.toml 用户配置合并）
    this.engineRegistry = new AgentEngineRegistry()
    const userEngines = await loadAgentEngineConfigs(this.cfg.projectRoot)
    const knownTools = new Set(this.toolRegistry.getAll().map((t) => t.definition.name))
    const engineWarnings = this.engineRegistry.mergeUserConfig(userEngines, knownTools)
    for (const warning of engineWarnings) {
      console.warn(warning)
    }

    // 创建 SubAgent 实例并注入工具注册表
    // 如果无可用 provider，推迟到首次 submit() 时创建
    if (this.router.hasAvailableProvider()) {
      this.subAgent = this.createSubAgent()
      this.toolRegistry.setSubAgentRunner(this.subAgent)
    } else {
      this.noProviderAvailable = true
    }
  }

  /** 后台初始化:在 TUI render 之后异步执行，避免阻塞终端启动 */
  async startBackgroundInit(): Promise<void> {
    // 初始化 git checkpoint（可能涉及 git 操作，较慢）
    if (this.cfg.config.checkpoint.autoCheckpoint) {
      try {
        await this.checkpoint.init()
      } catch (err) {
        console.warn('[Checkpoint] 初始化失败:', err)
      }
    }

    // 初始化会话持久化（静默，不在 TUI 中显示恢复提示）
    this.sessionManager.init()

    // 初始化学习系统（经验采集/教训检索/技能库，失败仅告警不阻塞）
    this.learningManager.init(this.cfg.projectRoot)
    this.assembler?.setLessonRetriever(this.learningManager.lessonProvider)

    // 加载插件（清单 + 技能目录 + MCP server 声明，失败仅告警不阻塞）
    try {
      const loaded = loadPlugins(this.cfg.projectRoot)
      this.plugins = loaded.plugins
      const skillLibrary = this.learningManager.getSkillLibrary()
      if (skillLibrary) {
        for (const dir of loaded.skillsDirs) {
          skillLibrary.addSkillsDir(dir)
        }
      }
      if (loaded.plugins.length > 0) {
        this.emit({
          type: 'system_info',
          message: `[Plugin] 已加载 ${loaded.plugins.length} 个插件: ${loaded.plugins.map((p) => p.name).join(', ')}`,
        })
      }
    } catch (err) {
      console.warn('[Plugin] 插件加载失败:', err)
    }

    // 技能接入：load_skill 读取器 + 系统提示技能元数据注入（依赖插件技能目录已登记）
    const skillLibrary = this.learningManager.getSkillLibrary()
    this.toolRegistry.setSkillReader(skillLibrary)
    this.assembler?.setSkillProvider(skillLibrary)

    // 构建代码图谱（后台异步，失败不阻塞）
    try {
      this.codeGraph = await buildCodeGraph(this.cfg.projectRoot)
      this.assembler?.setCodeGraph(this.codeGraph)
      if (this.codeGraph && this.codeGraph.files.size > 0) {
        this.emit({
          type: 'system_info',
          message: `[CodeGraph] 图谱构建完成，共 ${this.codeGraph.files.size} 个文件`,
        })
      }
    } catch (err) {
      console.warn('[CodeGraph] 代码图谱构建失败，将跳过代码地图注入:', err)
      this.codeGraph = null
    }

    // 初始化外部 MCP Server 并注册工具
    try {
      await this.initExternalMCP()
    } catch (err) {
      console.warn('[MCP] 外部 MCP Server 初始化失败:', err)
    }

    // 启动文件监听（增量更新 CodeGraph）
    try {
      this.fileWatcher = new FileWatcher({
        projectRoot: this.cfg.projectRoot,
        debounceMs: 2000,
        onChange: (changedFiles) => {
          // 增量更新代码图谱
          if (this.codeGraph) {
            updateCodeGraph(this.codeGraph, changedFiles, this.cfg.projectRoot)
              .then((updated) => {
                this.codeGraph = updated
                this.assembler?.setCodeGraph(updated)
              })
              .catch(() => {})
          }
        },
      })
      this.fileWatcher.start()
    } catch (err) {
      console.warn('[FileWatcher] 文件监听启动失败:', err)
    }

    // 启动本地 Automations 调度器（loops.toml 心跳；无配置/失败静默降级）
    await this.startLoops()
  }

  /**
   * 本地 Automations：加载 .nexus/loops.toml 并启动会话内心跳调度。
   * 无配置/解析失败静默降级（与无 Automations 行为一致）。
   */
  async startLoops(): Promise<void> {
    if (this.loopScheduler) return
    let loops: LoopConfig[] = []
    try {
      loops = await LoopConfigLoader.load(this.cfg.projectRoot)
    } catch (err) {
      console.warn('[Loops] loops.toml 加载失败:', err)
      return
    }
    if (loops.length === 0) return

    this.loopScheduler = new LoopScheduler({
      projectRoot: this.cfg.projectRoot,
      loops,
      runLoop: (prompt, opts) =>
        this.runLoop(prompt, {
          loopName: opts?.loopName,
          intervalMin: opts?.intervalMin,
          maxRounds: opts?.maxRounds,
          maxCost: opts?.maxCost,
        }),
      getTotalCost: () => this.costTracker.getTotalCost(),
      sessionMaxCost: this.cfg.config.limits.maxSessionCost,
      abortSignal: this.abortController?.signal,
      onEvent: (e) => this.emit(e),
    })
    try {
      await this.loopScheduler.start()
      this.emit({
        type: 'system_info',
        message: `[Loops] 已加载 ${loops.length} 个自动化: ${loops.map((l) => l.name).join(', ')}（/loops 查看）`,
      })
    } catch (err) {
      console.warn('[Loops] 调度器启动失败:', err)
      this.loopScheduler = null
    }
  }

  /** 停止本地 Automations 调度（shutdown 调用） */
  stopLoops(): void {
    this.loopScheduler?.stop()
    this.loopScheduler = null
  }

  /** 列出全部 loop 运行时信息（/loops 列表） */
  listLoops(): LoopRuntimeInfo[] {
    return this.loopScheduler?.list() ?? []
  }

  /** 手动触发指定 loop（不等调度） */
  async runLoopNow(name: string): Promise<string | null> {
    return (await this.loopScheduler?.runNow(name)) ?? `未知 loop: ${name}`
  }

  /** 启停指定 loop */
  async setLoopEnabled(name: string, enabled: boolean): Promise<void> {
    await this.loopScheduler?.setEnabled(name, enabled)
  }

  /** Triage 收件箱：读取指定（或全部）loop 的分级发现（[紧急]/[本周]/[观察]） */
  async getLoopInbox(name?: string): Promise<string> {
    const infos = name ? this.listLoops().filter((l) => l.config.name === name) : this.listLoops()
    if (infos.length === 0) {
      return name ? `未知 loop: ${name}` : '未配置本地 Automations（.nexus/loops.toml）'
    }
    const lines: string[] = []
    for (const info of infos) {
      const state = await new LoopState(this.cfg.projectRoot, info.config.name).read()
      const f = state.findings ?? { urgent: [], thisWeek: [], watch: [] }
      const has = f.urgent.length + f.thisWeek.length + f.watch.length > 0
      lines.push(`[loops.${info.config.name}]`)
      if (!has) {
        lines.push('  （无待处理事项）')
      } else {
        if (f.urgent.length > 0) lines.push(`  [紧急] ${f.urgent.join('；')}`)
        if (f.thisWeek.length > 0) lines.push(`  [本周] ${f.thisWeek.join('；')}`)
        if (f.watch.length > 0) lines.push(`  [观察] ${f.watch.join('；')}`)
      }
    }
    return lines.join('\n')
  }

  /** 读取 .nexus/config.toml 中的 mcp_servers 配置，连接外部 Server 并注册工具 */
  private async initExternalMCP(): Promise<void> {
    const mcpServers = await this.loadMCPServerConfigs()
    // 合并插件声明的 MCP server（项目 config.toml 优先，插件级在后）
    for (const plugin of this.plugins) {
      mcpServers.push(...plugin.mcpServers)
    }
    if (mcpServers.length === 0) return

    this.mcpManager = new ExternalMCPManager()

    // 注册所有 server 配置
    for (const server of mcpServers) {
      this.mcpManager.register(server)
    }

    // 逐个连接，失败不阻塞启动（禁用的 server 跳过）
    for (const server of mcpServers) {
      if (server.enabled === false) continue
      const ok = await this.mcpManager.connect(server.name)
      if (ok) {
        this.emit({ type: 'phase_change', phase: this.phase })
        console.log(`[MCP] 已连接外部 Server: ${server.name}`)
      } else {
        console.warn(`[MCP] 外部 Server "${server.name}" 连接失败，跳过其工具`)
      }
    }

    // 将外部工具注册到 ToolRegistry
    try {
      const handlers = await this.mcpManager.listAllTools()
      for (const handler of handlers) {
        this.toolRegistry.register(handler)
      }
      if (handlers.length > 0) {
        console.log(`[MCP] 已注册 ${handlers.length} 个外部工具`)
      }
    } catch (err) {
      console.warn('[MCP] 注册外部工具失败:', err)
    }
  }

  /** 从 .nexus/config.toml 读取 [[mcp_servers]] 配置（stdio 用 command，远程用 url） */
  private async loadMCPServerConfigs(): Promise<ExternalServerConfig[]> {
    const configPath = join(this.cfg.projectRoot, '.nexus', 'config.toml')
    try {
      const content = await readFile(configPath, 'utf-8')
      const raw = parse(content) as Record<string, unknown>
      const servers = raw.mcp_servers
      if (!Array.isArray(servers)) return []

      return servers
        .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
        .filter(
          (s) =>
            typeof s.name === 'string' &&
            (typeof s.command === 'string' || typeof s.url === 'string'),
        )
        .map((s) => ({
          name: s.name as string,
          ...(typeof s.command === 'string' ? { command: s.command } : {}),
          args: Array.isArray(s.args) ? (s.args as string[]) : [],
          env: s.env as Record<string, string> | undefined,
          ...(typeof s.url === 'string' ? { url: s.url } : {}),
          ...(typeof s.enabled === 'boolean' ? { enabled: s.enabled } : {}),
        }))
    } catch {
      // 配置文件不存在或无 mcp_servers，静默跳过
      return []
    }
  }

  /** 列出已安装插件（/plugins） */
  listPlugins(): string {
    if (this.plugins.length === 0) {
      return '未安装插件。插件目录约定: .nexus/plugins/<名称>/plugin.toml（可携 skills/ 与 [[mcp_servers]]）'
    }
    const lines: string[] = ['── 插件 ──']
    for (const p of this.plugins) {
      lines.push(`${p.name} v${p.version}${p.description ? ` — ${p.description}` : ''}`)
      if (p.skillsDir) lines.push('  skills: 已登记技能目录')
      for (const s of p.mcpServers) {
        lines.push(`  mcp: ${s.name} (${s.url ?? s.command ?? ''})`)
      }
    }
    return lines.join('\n')
  }

  /** 重新初始化 providers（TUI 中保存 API Key 后调用） */
  async reinitProviders(): Promise<void> {
    this.secrets = await loadSecrets(this.cfg.projectRoot)
    this.router?.reinit(this.secrets)

    // 如果之前因无 provider 推迟了 SubAgent 创建，现在补建
    if (this.noProviderAvailable && this.router?.hasAvailableProvider()) {
      this.noProviderAvailable = false
      this.subAgent = this.createSubAgent()
      this.toolRegistry.setSubAgentRunner(this.subAgent)
    }
  }

  /** 创建 SubAgent 实例：从 router 动态获取 provider 与成本参数，避免硬编码 */
  private createSubAgent(): SubAgent {
    const router = this.router
    if (!router) {
      throw new Error('createSubAgent 调用前 router 尚未初始化')
    }
    const route = router.getRouteInfo('executor')
    return new SubAgent({
      model: router.getModel('executor'),
      toolRegistry: this.toolRegistry,
      toolContext: this.getToolContext(),
      maxIterations: Math.min(10, this.cfg.config.limits.maxIterations),
      onEvent: (e) => this.emit(e),
      permissionMode: this.cfg.permissionMode,
      requestApproval: this.cfg.requestApproval,
      costTracker: this.costTracker,
      modelRole: 'executor',
      providerName: route.provider,
      modelName: route.model,
      costPer1kInput: route.costPer1kInput,
      costPer1kOutput: route.costPer1kOutput,
      costPer1kInputCached: route.costPer1kInputCached,
      modelParameters: getProvider(route.provider, this.secrets)?.getModelParameters?.(
        route.model,
        'executor',
      ),
      getAbortSignal: () => this.abortController?.signal,
      engineRegistry: this.engineRegistry ?? undefined,
      // 引擎差异化模型：按引擎指定的模型名走 ModelRouter 降级链
      getEngineModel: (modelName) => router.getModelByName(modelName),
      getEngineRouteInfo: (modelName) => router.getRouteInfoForModel(modelName),
      // 多智能体协作：worktree 隔离 + 信箱 + 成本熔断
      worktreeManager: this.worktreeManager,
      mailbox: this.mailbox,
      maxSessionCost: this.cfg.config.limits.maxSessionCost,
    })
  }

  /** 处理用户输入(主入口) */
  async submit(userInput: string): Promise<string> {
    try {
      if (!this.assembler || !this.rules) {
        await this.init()
      }

      // 若初始化时无 provider，再尝试一次（用户可能已通过 TUI 配置了 API Key）
      if (this.noProviderAvailable) {
        await this.reinitProviders()
        if (this.noProviderAvailable) {
          const errorMsg = [
            '❌ 未检测到任何可用的 AI 模型 API Key。',
            '',
            '请至少配置一个 provider：',
          ].join('\n')
          this.emit({ type: 'error', message: errorMsg, recoverable: true })
          return errorMsg
        }
      }

      this.aborted = false
      this.abortController = new AbortController()
      this.turnToolTrace = []
      this.emit({ type: 'user_input', text: userInput })
      const submitStartTime = Date.now()

      // 创建持久化会话并持久化用户消息（失败静默）
      this.sessionManager.ensureSession()
      this.sessionManager.addMessage('user', userInput)

      // 构建上下文（传入当前任务文本与历史占用估算：前者供教训检索，后者供代码地图动态扩容）
      const historyTokensEstimate = this.history.reduce(
        (sum, m) => sum + estimateTokens(m.content),
        0,
      )
      // stable/dynamic 拆分：stable 段（基础指令+规则+工具+技能）逐轮不变，
      // 作为 Anthropic cacheControl 断点前的可缓存前缀；dynamic 段每轮重建
      const { stable, dynamic } = await this.assembler!.buildSystemPromptParts(
        this.todos,
        userInput,
        historyTokensEstimate,
      )
      // DeepSeek 深度适配：追加 provider 优化后的系统提示后缀（仅当非空）
      // 后缀按模型固定不变，归入 stable 段保护缓存前缀
      let stableSystem = stable
      if (this.router) {
        const promptRoute = this.router.getRouteInfo('executor')
        const suffix = getProvider(promptRoute.provider, this.secrets)?.getSystemPromptSuffix?.(
          promptRoute.model,
          'executor',
        )
        if (suffix) stableSystem += `\n${suffix}`
      }

      // 自动压缩检测：历史过长时用 LLM 压缩早期对话
      if (this.history.length > this.cfg.config.context.recentTurnsKeep * 4 && this.router) {
        const contextWindow = this.router.getContextWindow('executor')
        const maxTokens = Math.floor(contextWindow * this.cfg.config.context.budgetRatio)
        try {
          const summarizerModel = this.router.getModel('summarizer')
          const result = await llmCompressHistory(
            this.history,
            summarizerModel,
            this.cfg.config.context.recentTurnsKeep,
            maxTokens,
          )
          if (result.compressed) {
            this.history = result.messages
            this.emit({
              type: 'system_info',
              message: `上下文已自动压缩: ~${Math.round(result.originalTokens / 1000)}k → ~${Math.round(result.compressedTokens / 1000)}k tokens`,
            })
          }
        } catch (err) {
          // 压缩失败不阻塞主流程，但记录日志
          logError('auto-compress', err).catch(() => {})
        }
      }

      const messages = this.assembler!.assembleMessagesSplit(
        stableSystem,
        dynamic,
        this.history,
        userInput,
      )

      let result: string

      if (this.skipPlan) {
        // 跳过 Plan,直接执行
        result = await this.executeDirectly(userInput, messages)
      } else {
        // 双阶段: Plan → Execute
        result = await this.planAndExecute(userInput, messages)
      }

      // 记录到历史
      this.history.push({ role: 'user', content: userInput })
      this.history.push({ role: 'assistant', content: result })

      // 本轮工具轨迹：压缩摘要追加在 assistant 回复之后，
      // 让下一轮与会话恢复后模型知道上次实际做了什么（避免重复探索）
      const traceText = this.flushToolTrace()

      // 持久化 assistant 回复与工具轨迹（失败静默）
      this.sessionManager.addMessage('assistant', result)
      if (traceText) {
        this.sessionManager.addMessage('user', traceText)
      }
      // 持久化 todos 快照（用于会话恢复）
      this.sessionManager.saveTodos(this.todos)
      // 共享任务板同步：执行后的 todo 状态变化（complete/新增）同步给协作视图
      this.taskBoard.syncFromTodos(this.todos)
      if (traceText) {
        this.history.push({ role: 'user', content: traceText })
      }

      this.phase = 'done'
      this.emit({ type: 'done', summary: result })
      // 异步记录本次任务经验（旁路，不阻塞回复返回）
      void this.recordExperienceAsync(userInput, submitStartTime)
      return result
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      this.emit({ type: 'error', message: errorMessage, recoverable: true })
      this.phase = 'error'
      // 自动记录错误报告
      recordError({
        type: 'submit_error',
        message: errorMessage,
        stack: err instanceof Error ? err.stack : undefined,
        context: {
          phase: this.phase,
          skipPlan: this.skipPlan,
          inputLength: userInput.length,
        },
        projectRoot: this.cfg.projectRoot,
      }).catch(() => {})
      return `执行出错: ${errorMessage}`
    }
  }

  /**
   * 异步记录本次任务经验并更新命中教训评分（学习旁路，失败仅告警）。
   * 经验是反思的原料；任务成功时对本任务检索命中的教训记一次成功命中，
   * 失败/部分完成时记一次失败命中（负反馈驱动低分教训自动归档），
   * 支撑 candidate → active 转正与评分升降（验证闭环）。
   */
  private async recordExperienceAsync(userInput: string, startTime: number): Promise<void> {
    if (!this.learningManager.available) return
    const outcome = this.determineOutcome()
    // 纯查询/对话任务不产生可学习的信号，不入经验库，避免稀释反思数据
    if (outcome === 'trivial') return
    this.learningManager.recordExperience({
      userInput,
      sessionId: this.sessionManager.sessionId,
      outcome,
      cost: this.costTracker.getTotalCost(),
      durationMs: Date.now() - startTime,
    })
  }

  /**
   * 判定任务结果：执行错误 = failure；全部 todo complete = success；其余 = partial。
   * 无代码变更且无计划 todo 的纯查询任务返回 'trivial'（不入经验库）。
   */
  private determineOutcome(): 'success' | 'failure' | 'partial' | 'trivial' {
    if (this.lastRunStats.executionError) return 'failure'
    if (!this.lastRunStats.hasCodeChanges && this.todos.length === 0) return 'trivial'
    if (this.todos.length === 0) return 'partial'
    return this.todos.every((t) => t.status === 'complete') ? 'success' : 'partial'
  }

  /** Plan → Execute 双阶段（支持重规划循环） */
  private async planAndExecute(userInput: string, messages: ChatMessage[]): Promise<string> {
    // ─── Plan 阶段 ───
    this.setPhase('planning')

    const plannerRoute = this.router!.getRouteInfo('planner')
    const plannerProvider = getProvider(plannerRoute.provider, this.secrets)
    const planner = new Planner({
      model: this.router!.getModel('planner'),
      toolRegistry: this.toolRegistry,
      toolContext: this.getToolContext(),
      maxIterations: Math.min(this.cfg.maxIterations, 8), // Plan 阶段限制 8 步，过长探索通常是迷路了
      onEvent: (e) => this.emit(e),
      costTracker: this.costTracker,
      modelRole: 'planner',
      providerName: plannerRoute.provider,
      modelName: plannerRoute.model,
      costPer1kInput: plannerRoute.costPer1kInput,
      costPer1kOutput: plannerRoute.costPer1kOutput,
      costPer1kInputCached: plannerRoute.costPer1kInputCached,
      modelParameters: plannerProvider?.getModelParameters?.(plannerRoute.model, 'planner'),
      // 懒获取：Plan 阶段也支持 Ctrl+C 中断（此前仅 Executor 可中断）
      getAbortSignal: () => this.abortController?.signal,
    })

    let currentPlan = await planner.plan(userInput, messages)
    this.todos = currentPlan.todos
    this.emit({ type: 'todo_update', todos: this.todos })

    // ─── 审批 + 重规划循环 ───
    const MAX_REPLAN = 3
    let replanAttempts = 0

    while (true) {
      if (this.aborted) return '已中断。'

      this.setPhase('awaiting_approval')
      const feedback = await this.cfg.requestPlanApproval(currentPlan)

      if (feedback === 'approve') {
        // 共享任务板：批准的计划灌入任务板，子 Agent 可通过 team_task_* 工具认领协作
        this.taskBoard.syncFromTodos(currentPlan.todos)
        break // 批准 → 进入执行
      }
      if (feedback === 'reject') {
        return '计划被拒绝。请重新描述你的需求,或告诉我需要调整什么。'
      }

      // feedback 是用户反馈文本 → 带反馈重规划
      replanAttempts++
      if (replanAttempts > MAX_REPLAN) {
        return '已达到最大重规划次数(3)。请重新提交需求。'
      }

      this.setPhase('planning')
      currentPlan = await planner.replan(userInput, messages, currentPlan, feedback)
      this.todos = currentPlan.todos
      this.emit({ type: 'todo_update', todos: this.todos })
    }

    // ─── Execute 阶段 ───
    return await this.runExecutor(currentPlan, messages)
  }

  /** 直接执行(跳过 Plan，Auto 模式) */
  private async executeDirectly(userInput: string, messages: ChatMessage[]): Promise<string> {
    // Auto 模式：空 todos，由 LLM 在执行中通过 update_todo 自主拆解
    const plan: Plan = {
      summary: userInput,
      todos: [],
      filesToModify: [],
      estimatedSteps: 0,
    }
    this.todos = []
    return await this.runExecutor(plan, messages)
  }

  /** 构建 Executor 配置（首次执行与自动修复重试共用，避免大对象重复构造） */
  private buildExecutorConfig(): ExecutorConfig {
    const executorRoute = this.router!.getRouteInfo('executor')
    const executorProvider = getProvider(executorRoute.provider, this.secrets)
    const verifierRoute = this.router!.getRouteInfo('verifier')
    const verifierProvider = getProvider(verifierRoute.provider, this.secrets)
    return {
      model: this.router!.getModel('executor'),
      toolRegistry: this.toolRegistry,
      toolContext: this.getToolContext(),
      checkpoint: this.checkpoint,
      maxIterations: this.cfg.maxIterations,
      permissionMode: this.cfg.permissionMode,
      onEvent: (e) => this.emit(e),
      requestApproval: this.cfg.requestApproval,
      costTracker: this.costTracker,
      modelRole: 'executor',
      providerName: executorRoute.provider,
      modelName: executorRoute.model,
      costPer1kInput: executorRoute.costPer1kInput,
      costPer1kOutput: executorRoute.costPer1kOutput,
      costPer1kInputCached: executorRoute.costPer1kInputCached,
      maxSessionCost: this.cfg.config.limits.maxSessionCost,
      getFallbackModel: () => this.router!.getDistinctFallbackModel('executor'),
      fallbackModelName: this.router!.getFallbackModelName('executor') ?? undefined,
      abortSignal: this.abortController?.signal,
      modelParameters: executorProvider?.getModelParameters?.(executorRoute.model, 'executor'),
      // 自适应压实：窗口大小 + 水位阈值 + summarizer 摘要模型
      contextWindow: executorRoute.contextWindow,
      compaction: {
        compactionThreshold: this.cfg.config.context.compactionThreshold,
        emergencyThreshold: this.cfg.config.context.emergencyThreshold,
        keepRecentResultsFull: this.cfg.config.context.keepRecentResultsFull,
      },
      compactModel: this.router!.getModel('summarizer'),
      // 验证阶段接入 verifier 角色模型（默认低价档），成本按 verifier 定价单独计费
      verifyModel: this.router!.getModel('verifier'),
      verifyModelParameters: verifierProvider?.getModelParameters?.(
        verifierRoute.model,
        'verifier',
      ),
      // 步级测试驱动闭环：仅当 testCommand 形如 bun test 时启用（可追加文件参数），其他框架保守跳过
      ...(this.rules && /^bun\s+test\b/.test(this.rules.project.testCommand)
        ? { autoTest: { runner: 'bun' as const, baseCommand: this.rules.project.testCommand } }
        : {}),
      // Loop Engineering 证据门禁：确定性检查（lint/typecheck/test）作为验证与修复循环的证据
      evidence: this.cfg.config.evidence,
      verifyCost: {
        providerName: verifierRoute.provider,
        modelName: verifierRoute.model,
        costPer1kInput: verifierRoute.costPer1kInput,
        costPer1kOutput: verifierRoute.costPer1kOutput,
        costPer1kInputCached: verifierRoute.costPer1kInputCached,
      },
    }
  }

  /** 提取 Executor 的验证失败项（验证通过或未运行时返回 null） */
  private extractVerifyFailures(executor: Executor): VerifyFailure[] | null {
    const outcome = executor.getVerifyOutcome()
    if (!outcome || outcome.pass) return null
    return outcome.failures
  }

  /** 记录最近一次执行的关键信号（供 determineOutcome 与 /goal 验收判定） */
  private recordLastRunStats(executor: Executor): void {
    const evidenceResult = executor.getEvidenceResult()
    this.lastRunStats = {
      hasCodeChanges: executor.getHasCodeChanges(),
      executionError: executor.getLastError(),
      evidencePassed: evidenceResult?.passed ?? null,
      evidenceSummary: evidenceResult ? formatEvidenceSummary(evidenceResult) : '',
      evidence: evidenceResult?.results ?? [],
      verifyPass: executor.getVerifyOutcome()?.pass ?? null,
    }
  }

  /** 最近一次执行的关键信号（L3 事件驱动循环 /goal 验收判定用） */
  getLastExecutionSignals(): ExecutionSignals {
    return {
      evidencePassed: this.lastRunStats.evidencePassed,
      evidenceSummary: this.lastRunStats.evidenceSummary,
      evidence: this.lastRunStats.evidence,
      verifyPass: this.lastRunStats.verifyPass,
      executionError: this.lastRunStats.executionError,
    }
  }

  /**
   * L3 事件驱动循环：/goal 目标驱动（跨多次 execute 的验收循环）。
   * 验收判定：门禁优先（acceptance 映射的确定性门禁）+ verifier 语义兜底。
   */
  async runGoal(opts: {
    goal: string
    acceptance?: string
    maxRounds?: number
    maxCost?: number
  }): Promise<GoalLoopResult> {
    const loop = new GoalLoop({
      goal: opts.goal,
      acceptance: opts.acceptance,
      maxRounds: opts.maxRounds,
      maxCost: opts.maxCost,
      sessionMaxCost: this.cfg.config.limits.maxSessionCost,
      submit: (input) => this.submit(input),
      getTotalCost: () => this.costTracker.getTotalCost(),
      getLastSignals: () => this.getLastExecutionSignals(),
      abortSignal: this.abortController?.signal,
      onEvent: (e) => this.emit(e),
    })
    const goalResult = await loop.run()
    // L4 trace 采集：/goal 每轮持久化（kind='goal'，供失败模式聚类）
    for (const round of goalResult.roundSummaries) {
      this.learningManager.recordLoopTrace({
        loopName: 'main',
        kind: 'goal',
        round: round.round,
        iterations: 0,
        evidencePassed: round.evidencePassed,
        evidence: [],
        verifyPass: round.verifyPass,
        verifyFailures: 0,
        cost: round.cost,
        createdAt: Date.now(),
      })
    }
    return goalResult
  }

  /**
   * L3 事件驱动循环：/loop 节拍循环（间隔重跑 + loop-state.md 状态文件）。
   * 每轮读取状态 → 执行 → 写状态 → 等待间隔；停止规则：
   * max-rounds / max-cost / 状态文件 stop_requested / Ctrl+C。
   */
  async runLoop(
    prompt: string,
    opts?: {
      loopName?: string
      intervalMin?: number
      maxRounds?: number
      maxCost?: number
    },
  ): Promise<string> {
    const intervalMs = Math.max(60, opts?.intervalMin ?? 10) * 1000
    const maxRounds = Math.max(1, opts?.maxRounds ?? 10)
    const maxCost = Math.min(opts?.maxCost ?? 2, this.cfg.config.limits.maxSessionCost)
    // 本地 Automations：按 loop 名分状态文件（loop-state-<name>.md），防多 loop 互相覆盖
    const state = new LoopState(this.cfg.projectRoot, opts?.loopName ?? 'main')

    let stateFile = await state.read()
    if (stateFile.stopRequested) {
      this.emit({
        type: 'system_info',
        message: '/loop 状态文件标记了停止请求，本轮不再执行',
      })
      return '/loop 已按状态文件停止请求退出。'
    }

    for (let round = 1; round <= maxRounds; round++) {
      if (this.aborted) break
      if (this.costTracker.getTotalCost() >= maxCost) {
        this.emit({
          type: 'system_info',
          message: `/loop 成本已达上限 ($${maxCost.toFixed(2)})，停止`,
        })
        break
      }

      const roundPrompt =
        round === 1 || !stateFile.lastResultSummary
          ? prompt
          : `${prompt}\n\n[上一轮状态]\n${stateFile.lastResultSummary}`
      this.emit({ type: 'system_info', message: `/loop 第 ${round}/${maxRounds} 轮开始...` })

      let output: string
      try {
        output = await this.submit(roundPrompt)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this.emit({
          type: 'error',
          message: `/loop 第 ${round} 轮执行失败: ${msg}`,
          recoverable: true,
        })
        await state.update({
          round,
          lastRunAt: Date.now(),
          lastResultSummary: `[第 ${round} 轮失败] ${msg}`,
        })
        break
      }

      const summary = output.length > 500 ? `${output.slice(0, 500)}…` : output
      stateFile = await state.update({
        round,
        lastRunAt: Date.now(),
        lastResultSummary: summary,
      })

      this.emit({
        type: 'system_info',
        message: `/loop 第 ${round} 轮完成（成本 $${this.costTracker
          .getTotalCost()
          .toFixed(4)}），${
          round < maxRounds ? `${intervalMs / 1000}s 后下一轮，Ctrl+C 可中断` : '已达到最大轮次'
        }`,
      })

      if (round < maxRounds) {
        // 等待间隔前重新读取状态：外部（人或脚本）可能在此期间请求停止
        stateFile = await state.read()
        if (stateFile.stopRequested) {
          this.emit({ type: 'system_info', message: '/loop 状态文件标记了停止请求，提前退出' })
          break
        }
        await sleepWithAbort(intervalMs, this.abortController?.signal)
      }
    }

    // L4 trace 采集：/loop 汇总一轮（kind='loop'，loop_name 按配置分文件）
    this.learningManager.recordLoopTrace({
      loopName: opts?.loopName ?? 'main',
      kind: 'loop',
      round: stateFile.round,
      iterations: 0,
      evidencePassed: null,
      evidence: [],
      verifyPass: null,
      verifyFailures: 0,
      cost: this.costTracker.getTotalCost(),
      createdAt: Date.now(),
    })

    return `/loop 结束：共 ${stateFile.round} 轮。状态文件: .nexus/loop-state.md（修改其中 stop_requested 可控制后续运行）`
  }

  /** 运行 Executor */
  private async runExecutor(plan: Plan, messages: ChatMessage[]): Promise<string> {
    this.setPhase('executing')

    const executor = new Executor(this.buildExecutorConfig())
    let currentResult = await executor.execute(plan, messages)
    let currentExecutor = executor
    this.todos = executor.getTodos()

    // 自动修复模式：执行错误、验证失败或证据门禁失败时自动重试（Loop Engineering L2 反馈循环）。
    // 验证驱动的修复与错误修复共享 maxAutoRetries 预算，且验证修复额外封顶 2 次；
    // 证据门禁失败（确定性）优先反馈，无需 verifier 复述；成本上限由 Executor 内部 isOverBudget 检查兜底。
    const maxRetries = this.cfg.config.limits.maxAutoRetries
    const MAX_VERIFY_FIXES = 2
    const loopTrace: LoopTraceRound[] = []

    let pendingError = executor.getLastError()
    let pendingVerifyFailures = this.extractVerifyFailures(executor)
    let pendingEvidence = executor.getEvidenceResult()
    let verifyFixesUsed = 0
    loopTrace.push({ ...executor.getLoopTrace(), round: 0 })

    const pendingEvidenceFailures = () =>
      (pendingEvidence?.results ?? []).filter((r) => !r.skipped && !r.passed)

    if (
      maxRetries > 0 &&
      (pendingError !== null ||
        pendingVerifyFailures !== null ||
        pendingEvidenceFailures().length > 0)
    ) {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        if (this.aborted) break
        if (
          pendingError === null &&
          pendingVerifyFailures === null &&
          pendingEvidenceFailures().length === 0
        ) {
          break
        }

        const isVerifyFix = pendingError === null && pendingVerifyFailures !== null
        if (isVerifyFix && verifyFixesUsed >= MAX_VERIFY_FIXES) break
        if (isVerifyFix) verifyFixesUsed++

        const fixKind =
          pendingEvidenceFailures().length > 0
            ? 'evidence'
            : pendingVerifyFailures !== null
              ? 'verify'
              : 'error'
        this.emit({
          type: 'system_info',
          message:
            fixKind === 'evidence'
              ? `自动修复模式：证据门禁未通过，尝试修复确定性失败 (${attempt}/${maxRetries})...`
              : fixKind === 'verify'
                ? `自动修复模式：验证未通过，尝试补齐缺失项 (${attempt}/${maxRetries})...`
                : `自动修复模式：检测到执行错误，尝试自动修复 (${attempt}/${maxRetries})...`,
        })

        const fixInstruction = this.buildFixInstruction(
          pendingError,
          pendingVerifyFailures,
          pendingEvidenceFailures(),
        )

        // 将错误/验证失败信息和修复指令追加到消息中
        const retryMessages: ChatMessage[] = [
          ...messages,
          { role: 'assistant', content: currentResult },
          { role: 'user', content: fixInstruction },
        ]

        // 创建新的 Executor 实例重试（迭代上限收紧为 10）
        const retryExecutor = new Executor({
          ...this.buildExecutorConfig(),
          maxIterations: Math.min(10, this.cfg.maxIterations),
        })

        currentResult = await retryExecutor.execute(
          { ...plan, summary: `${plan.summary}（自动修复尝试 ${attempt}）` },
          retryMessages,
        )
        currentExecutor = retryExecutor
        this.todos = retryExecutor.getTodos()

        pendingError = retryExecutor.getLastError()
        pendingVerifyFailures = this.extractVerifyFailures(retryExecutor)
        pendingEvidence = retryExecutor.getEvidenceResult()
        loopTrace.push({ ...retryExecutor.getLoopTrace(), round: attempt })
        if (
          pendingError === null &&
          pendingVerifyFailures === null &&
          pendingEvidenceFailures().length === 0
        ) {
          this.emit({ type: 'system_info', message: `自动修复成功（第 ${attempt} 次尝试）` })
          this.recordLastRunStats(currentExecutor)
          this.emitLoopTraceSummary(loopTrace)
          return currentResult
        }
      }

      this.emit({
        type: 'system_info',
        message: `自动修复模式：已尝试 ${maxRetries} 次修复，均未成功。请手动处理。`,
      })
      this.emitLoopTraceSummary(loopTrace)
    }

    this.recordLastRunStats(currentExecutor)
    return currentResult
  }

  /**
   * 组装修复指令（Loop Engineering 反馈铁律：紧凑且可操作；确定性证据优先）。
   * 证据门禁失败直接列出门禁与输出尾部（无需 LLM 复述），再列 verifier 语义失败项。
   */
  private buildFixInstruction(
    pendingError: string | null,
    pendingVerifyFailures: VerifyFailure[] | null,
    evidenceFailures: EvidenceResult[],
  ): string {
    const parts: string[] = []
    if (evidenceFailures.length > 0) {
      parts.push(
        `确定性证据门禁失败:\n${evidenceFailures
          .map((r) => `- [${r.gate}] ${r.command} (exit=${r.exitCode})\n${r.output}`)
          .join('\n\n')}\n请修复这些问题，修复后重新运行对应检查确认通过。`,
      )
    }
    if (pendingVerifyFailures && pendingVerifyFailures.length > 0) {
      parts.push(
        `验证阶段发现以下待办未真正完成:\n${pendingVerifyFailures
          .map((f) =>
            f.evidence
              ? `- [todo ${f.todoId}] ${f.detail}（证据: ${f.evidence}）`
              : `- [todo ${f.todoId}] ${f.detail}`,
          )
          .join('\n')}\n\n请补齐这些缺失项。`,
      )
    }
    if (pendingError) {
      parts.push(`执行时遇到了以下错误:\n${pendingError}\n\n请修复这个问题。`)
    }
    parts.push('完成后运行测试验证修复是否成功。')
    return parts.join('\n\n')
  }

  /** 循环 trace 汇总（Loop Engineering 观测：轮次/证据门禁/验证/总成本，不污染交付文本） */
  private emitLoopTraceSummary(loopTrace: LoopTraceRound[]): void {
    const evidenceRan = loopTrace.flatMap((r) => r.evidence.filter((e) => !e.skipped))
    const evidencePassed = evidenceRan.filter((e) => e.passed).length
    const evidenceFailed = evidenceRan.length - evidencePassed
    const verifyRounds = loopTrace.filter((r) => r.verifyPass !== null)
    const verifyPassed = verifyRounds.filter((r) => r.verifyPass).length
    const cost = this.costTracker.getTotalCost()
    this.emit({
      type: 'system_info',
      message:
        `循环报告: 共 ${loopTrace.length} 轮（首次 + ${loopTrace.length - 1} 次修复）` +
        ` / 证据门禁 ${evidencePassed} 过 ${evidenceFailed} 败` +
        ` / 验证 ${verifyPassed}/${verifyRounds.length} 轮通过` +
        ` / 总成本 $${cost.toFixed(4)}`,
    })
    // L4 trace 采集：逐轮持久化（kind='exec'，供失败模式聚类）
    for (const round of loopTrace) {
      this.learningManager.recordLoopTrace({
        loopName: 'main',
        kind: 'exec',
        round: round.round,
        iterations: round.iterations,
        evidencePassed: round.evidencePassed,
        evidence: round.evidence,
        verifyPass: round.verifyPass,
        verifyFailures: round.verifyFailures,
        cost: this.costTracker.getTotalCost(),
        createdAt: Date.now(),
      })
    }
  }

  /** 中断当前操作 */
  abort(): void {
    this.aborted = true
    this.abortController?.abort()
  }

  /** 回滚到上一个检查点 */
  async undo(): Promise<string> {
    return await this.checkpoint.undo()
  }

  /** 获取当前阶段 */
  getPhase(): AgentPhase {
    return this.phase
  }

  /** 获取 todos */
  getTodos(): Todo[] {
    return this.todos
  }

  /** 获取成本摘要（含 DeepSeek 缓存/推理统计） */
  getCostSummary(): {
    total: number
    inputTokens: number
    outputTokens: number
    cacheHitTokens?: number
    cacheMissTokens?: number
    cacheHitRate?: number
    cacheSavedCost?: number
    reasoningTokens?: number
    reasoningPercentage?: number
  } {
    const tokens = this.costTracker.getTotalTokens()
    const cache = this.costTracker.getCacheStats()
    const reasoning = this.costTracker.getReasoningStats()
    return {
      total: this.costTracker.getTotalCost(),
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      cacheHitTokens: cache.hit,
      cacheMissTokens: cache.miss,
      cacheHitRate: cache.hitRate,
      cacheSavedCost: this.costTracker.getCacheSavedCost(),
      reasoningTokens: reasoning.total,
      reasoningPercentage: reasoning.percentage,
    }
  }

  /** 获取当前模型 */
  getCurrentModel(): string {
    if (!this.router) return 'not-initialized'
    if (!this.router.hasAvailableProvider()) return '未配置，请先配置 API Key'
    // 直接返回实际解析后的模型名，不带 auto 前缀
    return this.router.getCurrentModel('executor')
  }

  /** 切换模型（校验是否支持 tool calling） */
  setModel(model: string): void {
    if (this.router && !this.router.modelSupportsTools(model)) {
      throw new Error(`模型 ${model} 不支持 tool calling，不能用于 executor/planner 角色`)
    }
    this.router?.setModel('executor', model)
    this.router?.setModel('planner', model)
  }

  /** 获取所有已知模型（含未配置 provider 的） */
  getAllKnownModels(): Array<{
    name: string
    provider: string
    configured: boolean
    current: boolean
  }> {
    return this.router?.getAllKnownModels() ?? []
  }

  /** 检查指定 provider 是否已配置 API Key */
  isProviderConfigured(providerName: string): boolean {
    return this.router?.isProviderConfigured(providerName) ?? false
  }

  /** 获取可用模型列表 */
  getAvailableModels(): Array<{ name: string; provider: string; current: boolean }> {
    return this.router?.getAvailableModels() ?? []
  }

  /** 会话结束时自动合并 checkpoint 到工作分支 */
  async mergeCheckpoints(): Promise<void> {
    // 即使 autoCheckpoint 关闭，若已初始化仍需切回工作分支
    if (!this.cfg.config.checkpoint.autoCheckpoint) {
      // 仅在已初始化（可能已切换到 checkpoint 分支）时恢复
      if (this.checkpoint.hasCheckpoints()) {
        await this.checkpoint.mergeToWorkBranch()
      }
      return
    }
    if (!this.checkpoint.hasCheckpoints()) return

    this.emit({ type: 'phase_change', phase: 'verifying' })

    const result = await this.checkpoint.mergeToWorkBranch()

    if (result.success) {
      // 合并成功,发出 checkpoint 事件通知
      this.emit({
        type: 'checkpoint',
        step: this.checkpoint.getCurrentStep(),
        message: result.message,
      })
    } else {
      // 合并失败(可能是冲突),发出错误事件提示用户手动解决
      this.emit({
        type: 'error',
        message: result.message,
        recoverable: true,
      })
    }
  }

  /** 结束当前会话并关闭数据库 */
  async shutdown(): Promise<void> {
    if (this.shutdownCalled) return
    this.shutdownCalled = true

    // 停止本地 Automations 调度（清除定时器，避免进程退出后残留心跳）
    this.stopLoops()

    // 先合并 checkpoint
    try {
      await this.mergeCheckpoints()
    } catch (err) {
      console.warn('[Checkpoint] 合并检查点失败:', err)
    }

    // 会话结束学习闭环：反思未反思经验、技能合并提议、记忆治理（失败仅告警）
    await this.runEndOfSessionLearning()

    const cost = this.getCostSummary()
    this.sessionManager.endSession(
      cost.total,
      cost.inputTokens,
      cost.outputTokens,
      this.history.length,
    )
    this.sessionManager.close()

    // 断开所有外部 MCP Server 连接
    if (this.mcpManager) {
      try {
        await this.mcpManager.disconnectAll()
      } catch (err) {
        console.warn('[MCP] 断开外部 Server 失败:', err)
      }
      this.mcpManager = null
    }

    // 清理多智能体 worktree（已合并/无变更的删除，有未合并变更的保留现场）
    try {
      await this.worktreeManager.shutdown()
    } catch (err) {
      console.warn('[Worktree] 清理失败:', err)
    }
    this.taskBoard.clear()
    this.mailbox.clear()

    // 停止文件监听
    if (this.fileWatcher) {
      this.fileWatcher.stop()
      this.fileWatcher = null
    }

    // 关闭语义搜索引擎单例的数据库连接
    try {
      closeSemanticSearchEngine()
    } catch (err) {
      console.warn('[SemanticSearch] 关闭失败:', err)
    }

    // 关闭代码图谱磁盘缓存
    try {
      this.codeGraph?.cache?.close()
    } catch (err) {
      console.warn('[CodeGraph] 缓存关闭失败:', err)
    }
  }

  /** 会话结束时执行学习闭环（委托 LearningManager），并把结果以事件形式呈现 */
  private async runEndOfSessionLearning(): Promise<void> {
    if (!this.router) {
      this.learningManager.close()
      return
    }
    const result = await this.learningManager.runEndOfSession(this.router.getModel('summarizer'))
    if (result.newLessons > 0) {
      this.emit({
        type: 'system_info',
        message: `[Memory] 本次会话反思出 ${result.newLessons} 条新教训（/memory 查看）`,
      })
    }
    // L4：消费循环 trace 失败模式（高频失败 → 教训；advice 经 Reflector LLM 精化，NEXUS_L4_REFINE=off 关闭）
    const traceResult = await this.learningManager.consumeLoopTraces(
      3,
      this.router.getModel('summarizer'),
    )
    if (traceResult.newLessons > 0) {
      this.emit({
        type: 'system_info',
        message: `[Memory] 已从循环 trace 提炼 ${traceResult.newLessons} 条失败模式教训（/memory 查看）`,
      })
    }
    if (result.skillProposals > 0) {
      this.emit({
        type: 'system_info',
        message: `[Memory] 检测到 ${result.skillProposals} 个技能合并提议（/memory skills 查看）`,
      })
    }
    if (result.deletedLessons > 0) {
      this.emit({
        type: 'system_info',
        message: `[Memory] 教训库容量治理：淘汰 ${result.deletedLessons} 条低价值教训`,
      })
    }
  }

  /** 清除上下文 */
  clearContext(): void {
    this.history = []
    this.todos = []
  }

  /** 恢复指定会话（从 DB 加载 history + todos） */
  async restoreSession(sessionId?: string): Promise<{ restored: boolean; message: string }> {
    const loaded = this.sessionManager.loadSession(sessionId)
    if (!loaded.ok) {
      return { restored: false, message: loaded.message }
    }

    // 重建 history（只恢复 user/assistant 角色）
    this.history = loaded.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))

    // 加载 todos
    this.todos = loaded.todos

    // 设置当前会话 ID 为恢复的会话（继续在同一会话下追加消息）
    this.sessionManager.sessionId = loaded.sessionId

    const todoInfo =
      this.todos.length > 0
        ? `，${this.todos.filter((t) => t.status !== 'complete').length} 个待办未完成`
        : ''
    const msg = `已恢复会话（${new Date(loaded.startTime).toLocaleString()}）：${this.history.length} 条消息${todoInfo}`

    this.emit({ type: 'system_info', message: msg })
    if (this.todos.length > 0) {
      this.emit({ type: 'todo_update', todos: this.todos })
    }

    return { restored: true, message: msg }
  }

  /** 列出最近会话（供 /resume 命令展示） */
  listRecentSessions(
    limit = 5,
  ): Array<{ id: string; startTime: number; messageCount: number; cost: number }> {
    return this.sessionManager.listRecentSessions(limit).map((s) => ({
      id: s.id,
      startTime: s.start_time,
      messageCount: s.message_count,
      cost: s.total_cost,
    }))
  }

  /** 压缩上下文历史 */
  compactHistory(): { tokensUsed: number } | string {
    if (this.history.length < 4) {
      return '消息数量较少，无需压缩'
    }

    const contextWindow = this.router?.getContextWindow('executor') ?? 128000
    const maxTokens = Math.floor(contextWindow * (this.cfg.config.context?.budgetRatio ?? 0.8))
    const recentKeep = this.cfg.config.context?.recentTurnsKeep ?? 5

    const result = compressHistory(this.history, recentKeep, maxTokens)

    if (result.compressedCount === 0) {
      return `无需压缩（当前 ~${Math.round(result.originalTokens / 1000)}k tokens，上限 ~${Math.round(maxTokens / 1000)}k）`
    }

    this.history = result.messages
    const currentTokens = result.compressedTokens

    return {
      tokensUsed: currentTokens,
    }
  }

  /** 获取历史摘要 */
  getHistory(): string[] {
    return this.history.filter((m) => m.role === 'user').map((m) => m.content.slice(0, 80))
  }

  /** 获取完整历史（用于导出） */
  getFullHistory(): ChatMessage[] {
    return [...this.history]
  }

  /** 获取各子系统健康状态 */
  getStatus(): {
    db: boolean
    codeGraph: boolean
    mcp: boolean
    watcher: boolean
    model: string
    cost: number
  } {
    return {
      db: this.sessionManager.available,
      codeGraph: this.codeGraph !== null && this.codeGraph.files.size > 0,
      mcp: this.mcpManager !== null,
      watcher: this.fileWatcher !== null && this.fileWatcher.isRunning(),
      model: this.getCurrentModel(),
      cost: this.costTracker.getTotalCost(),
    }
  }

  /** 搜索会话消息 */
  searchSessions(query: string): string {
    const results = this.sessionManager.searchMessages(query)
    if (!this.sessionManager.available) {
      return '数据库不可用，无法搜索'
    }
    if (results.length === 0) {
      return `未找到包含 "${query}" 的会话消息`
    }

    const lines: string[] = [`找到 ${results.length} 个相关会话：\n`]
    for (const r of results) {
      const time = new Date(r.startTime).toLocaleString()
      lines.push(`[${r.sessionId.slice(0, 8)}] ${time} | ${r.matchCount} 条匹配`)
      for (const m of r.matches) {
        const roleLabel = m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : '系统'
        lines.push(`  ${roleLabel}: ${m.snippet}`)
      }
      lines.push('')
    }
    lines.push('提示: 使用 /resume <会话ID> 恢复某个会话查看完整上下文')
    return lines.join('\n')
  }

  /** 设置自动修复模式的重试次数 */
  setAutoRetries(retries: number): void {
    this.cfg.config.limits.maxAutoRetries = Math.max(0, Math.min(3, retries))
  }

  /** 获取当前自动修复重试次数 */
  getAutoRetries(): number {
    return this.cfg.config.limits.maxAutoRetries
  }

  /** 获取最近的错误报告 */
  async getRecentErrors(limit = 10): Promise<string> {
    const { getRecentErrors } = await import('../utils/errorReport')
    const errors = await getRecentErrors(this.cfg.projectRoot, limit)
    if (errors.length === 0) {
      return '暂无错误报告'
    }
    const lines: string[] = [`最近 ${errors.length} 条错误报告：\n`]
    for (const err of errors) {
      const time = new Date(err.timestamp).toLocaleString()
      lines.push(`[${time}] ${err.type}`)
      lines.push(`  消息: ${err.message}`)
      if (err.context) {
        const ctx = Object.entries(err.context)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ')
        lines.push(`  上下文: ${ctx}`)
      }
      lines.push('')
    }
    lines.push('提示: 错误报告保存在 .nexus/error-log.jsonl')
    return lines.join('\n')
  }

  /** 查看学习记忆统计与 top 教训（/memory，委托 LearningManager） */
  listMemory(): string {
    return this.learningManager.listMemory()
  }

  /** 删除一条教训或技能（/memory delete lesson|skill <id>，委托 LearningManager） */
  deleteMemoryEntry(kind: 'lesson' | 'skill', id: number | string): string {
    return this.learningManager.deleteMemoryEntry(kind, id)
  }

  /** 列出技能文件（/memory skills，委托 LearningManager） */
  listSkills(): string {
    return this.learningManager.listSkills()
  }

  private getToolContext(): ToolContext {
    return {
      projectRoot: this.cfg.projectRoot,
      callId: '',
      maxReadLines: this.cfg.config.limits.maxReadLines,
      maxOutputBytes: this.cfg.config.limits.maxOutputBytes,
      bashTimeout: this.cfg.config.limits.bashTimeout,
      todos: this.todos,
    }
  }

  private setPhase(phase: AgentPhase): void {
    this.phase = phase
    this.emit({ type: 'phase_change', phase })
  }

  private emit(event: NexusEvent): void {
    this.captureToolTrace(event)
    // 上下文利用率峰值追踪（prompt token / 窗口）
    if (event.type === 'cost_update' && event.windowTokens && event.promptTokens) {
      const ratio = event.promptTokens / event.windowTokens
      if (ratio > this.peakContextUtilization) this.peakContextUtilization = ratio
    }
    this.cfg.onEvent(event)
  }

  /** 本会话上下文利用率峰值（0~1，未上报窗口信息时为 0） */
  getPeakContextUtilization(): number {
    return this.peakContextUtilization
  }

  /** 采集本轮工具调用轨迹（tool_call 开条，tool_result 补成功/失败标记） */
  private captureToolTrace(event: NexusEvent): void {
    if (event.type === 'tool_call') {
      this.turnToolTrace.push({
        callId: event.callId,
        tool: event.tool,
        argsSummary: summarizeToolArgs(event.params),
        ok: true,
      })
    } else if (event.type === 'tool_result') {
      const entry = this.turnToolTrace.find((e) => e.callId === event.callId)
      if (entry && event.error) entry.ok = false
    }
  }

  /**
   * 生成本轮工具轨迹的压缩摘要（供 history 与 DB 持久化），并清空采集缓冲。
   * 无工具调用时返回空字符串；条目上限 30，总长上限 1600 字符。
   */
  private flushToolTrace(): string {
    const entries = this.turnToolTrace
    this.turnToolTrace = []
    if (entries.length === 0) return ''

    const MAX_ENTRIES = 30
    const kept = entries.slice(-MAX_ENTRIES)
    const lines = kept.map(
      (e) => `${e.ok ? '✓' : '✗'} ${e.tool}${e.argsSummary ? ` ${e.argsSummary}` : ''}`,
    )
    let body = lines.join('\n')
    const MAX_CHARS = 1600
    if (body.length > MAX_CHARS) {
      body = `${body.slice(0, MAX_CHARS)}\n...（轨迹过长已截断）`
    }
    const header =
      entries.length > MAX_ENTRIES
        ? `（仅保留最近 ${MAX_ENTRIES} 条，共 ${entries.length} 条）\n`
        : ''
    return `[系统记录·工具轨迹] 上一轮任务实际执行的工具操作（压缩摘要，非用户输入）:\n${header}${body}`
  }
}

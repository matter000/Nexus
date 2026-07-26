/**
 * Orchestrator - Agent 编排核心
 * 协调 Plan/Execute 双阶段、子 Agent 分派、检查点管理
 */

import type {
  AgentPhase,
  ChatMessage,
  NexusConfig,
  NexusEvent,
  PermissionMode,
  Plan,
  ProjectRules,
  Todo,
} from './types'
import { Planner } from './Planner'
import { Executor } from './Executor'
import { SubAgent } from './SubAgent'
import { createToolRegistry, type ToolContext } from '../tools/registry'
import { ContextAssembler } from '../context/Assembler'
import { TokenBudget } from '../context/TokenBudget'
import { loadRules } from '../context/RulesLoader'
import { ModelRouter } from '../router/ModelRouter'
import { CostTracker } from '../router/CostTracker'
import { CheckpointManager } from '../sandbox/Checkpoint'
import { compressHistory, llmCompressHistory } from '../context/Compressor'
import { loadSecrets, type SecretsConfig } from '../config-secrets'
import { NexusDB } from '../storage/db'
import { ExternalMCPManager, type ExternalServerConfig } from '../tools/external'
import { buildCodeGraph, updateCodeGraph, type CodeGraph } from '../context/CodeGraph'
import { FileWatcher } from '../context/FileWatcher'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { parse } from 'smol-toml'
import { logError } from '../utils/debugLog'

export interface OrchestratorConfig {
  projectRoot: string
  config: NexusConfig
  permissionMode: PermissionMode
  skipPlan: boolean
  maxIterations: number
  onEvent: (event: NexusEvent) => void
  requestApproval: (tool: string, params: Record<string, unknown>, diff?: string) => Promise<boolean>
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
  private db: NexusDB | null = null
  private currentSessionId: string | null = null
  private shutdownCalled = false
  private subAgent: SubAgent | null = null
  private mcpManager: ExternalMCPManager | null = null
  private codeGraph: CodeGraph | null = null
  private fileWatcher: FileWatcher | null = null
  private noProviderAvailable = false
  /** 是否跳过 Plan 阶段（运行时可切换） */
  private skipPlan: boolean
  /** 中断控制器（abort() 时触发，传递给 Executor/Planner 的 streamText） */
  private abortController: AbortController | null = null

  constructor(cfg: OrchestratorConfig) {
    this.cfg = cfg
    this.skipPlan = cfg.skipPlan
    this.checkpoint = new CheckpointManager(
      cfg.projectRoot,
      cfg.config.checkpoint.branch
    )
    this.checkpoint.setEnabled(cfg.config.checkpoint.autoCheckpoint)
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
    const budget = new TokenBudget(
      contextWindow,
      this.cfg.config.context.budgetRatio
    )

    this.assembler = new ContextAssembler({
      projectRoot: this.cfg.projectRoot,
      rules: this.rules,
      tools: this.toolRegistry.getAll(),
      budget,
      recentTurnsKeep: this.cfg.config.context.recentTurnsKeep,
    })

    // 创建 SubAgent 实例并注入工具注册表
    // 如果无可用 provider，推迟到首次 submit() 时创建
    if (this.router.hasAvailableProvider()) {
      this.subAgent = new SubAgent({
        model: this.router.getModel('executor'),
        toolRegistry: this.toolRegistry,
        toolContext: this.getToolContext(),
        maxIterations: Math.min(10, this.cfg.config.limits.maxIterations),
        onEvent: (e) => this.emit(e),
        permissionMode: this.cfg.permissionMode,
        requestApproval: this.cfg.requestApproval,
        costTracker: this.costTracker,
        modelRole: 'executor',
        providerName: 'anthropic', // 默认 provider，子 Agent 成本计入主 provider
        modelName: this.router.getCurrentModel('executor'),
        costPer1kInput: 0.003,
        costPer1kOutput: 0.015,
      })
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

    // 初始化 NexusDB 会话持久化（静默，不在 TUI 中显示恢复提示）
    try {
      this.db = new NexusDB(this.cfg.projectRoot)
    } catch (err) {
      console.warn('[NexusDB] 数据库初始化失败，会话将不会持久化:', err)
      this.db = null
    }

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
            updateCodeGraph(this.codeGraph, changedFiles, this.cfg.projectRoot).then((updated) => {
              this.codeGraph = updated
              this.assembler?.setCodeGraph(updated)
            }).catch(() => {})
          }
        },
      })
      this.fileWatcher.start()
    } catch (err) {
      console.warn('[FileWatcher] 文件监听启动失败:', err)
    }
  }

  /** 读取 .nexus/config.toml 中的 mcp_servers 配置，连接外部 Server 并注册工具 */
  private async initExternalMCP(): Promise<void> {
    const mcpServers = await this.loadMCPServerConfigs()
    if (mcpServers.length === 0) return

    this.mcpManager = new ExternalMCPManager()

    // 注册所有 server 配置
    for (const server of mcpServers) {
      this.mcpManager.register(server)
    }

    // 逐个连接，失败不阻塞启动
    for (const server of mcpServers) {
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

  /** 从 .nexus/config.toml 读取 [[mcp_servers]] 配置 */
  private async loadMCPServerConfigs(): Promise<ExternalServerConfig[]> {
    const configPath = join(this.cfg.projectRoot, '.nexus', 'config.toml')
    try {
      const content = await readFile(configPath, 'utf-8')
      const raw = parse(content) as Record<string, unknown>
      const servers = raw.mcp_servers
      if (!Array.isArray(servers)) return []

      return servers
        .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
        .filter((s) => typeof s.name === 'string' && typeof s.command === 'string')
        .map((s) => ({
          name: s.name as string,
          command: s.command as string,
          args: Array.isArray(s.args) ? (s.args as string[]) : [],
          env: s.env as Record<string, string> | undefined,
        }))
    } catch {
      // 配置文件不存在或无 mcp_servers，静默跳过
      return []
    }
  }

  /** 重新初始化 providers（TUI 中保存 API Key 后调用） */
  async reinitProviders(): Promise<void> {
    this.secrets = await loadSecrets(this.cfg.projectRoot)
    this.router?.reinit(this.secrets)

    // 如果之前因无 provider 推迟了 SubAgent 创建，现在补建
    if (this.noProviderAvailable && this.router?.hasAvailableProvider()) {
      this.noProviderAvailable = false
      this.subAgent = new SubAgent({
        model: this.router.getModel('executor'),
        toolRegistry: this.toolRegistry,
        toolContext: this.getToolContext(),
        maxIterations: Math.min(10, this.cfg.config.limits.maxIterations),
        onEvent: (e) => this.emit(e),
        permissionMode: this.cfg.permissionMode,
        requestApproval: this.cfg.requestApproval,
        costTracker: this.costTracker,
        modelRole: 'executor',
        providerName: 'anthropic',
        modelName: this.router.getCurrentModel('executor'),
        costPer1kInput: 0.003,
        costPer1kOutput: 0.015,
      })
      this.toolRegistry.setSubAgentRunner(this.subAgent)
    }
  }

  /** 处理用户输入(主入口) */
  async submit(userInput: string): Promise<string> {
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
    this.emit({ type: 'user_input', text: userInput })

    // 创建持久化会话
    if (this.db && !this.currentSessionId) {
      try {
        this.currentSessionId = crypto.randomUUID()
        this.db.createSession(this.currentSessionId, this.cfg.projectRoot)
      } catch (err) {
        console.warn('[NexusDB] 创建会话失败:', err)
        this.currentSessionId = null
      }
    }

    // 持久化用户消息
    if (this.db && this.currentSessionId) {
      try {
        this.db.addMessage(this.currentSessionId, 'user', userInput)
      } catch (err) {
        console.warn('[NexusDB] 持久化用户消息失败:', err)
      }
    }

    // 构建上下文
    const systemPrompt = await this.assembler!.buildSystemPrompt(this.todos)

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

    const messages = this.assembler!.assembleMessages(systemPrompt, this.history, userInput)

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

    // 持久化 assistant 回复
    if (this.db && this.currentSessionId) {
      try {
        this.db.addMessage(this.currentSessionId, 'assistant', result)
        // 持久化 todos 快照（用于会话恢复）
        if (this.todos.length > 0) {
          this.db.saveTodos(this.currentSessionId, this.todos)
        }
      } catch (err) {
        console.warn('[NexusDB] 持久化 assistant 消息失败:', err)
      }
    }

    this.phase = 'done'
    this.emit({ type: 'done', summary: result })
    return result
  }

  /** Plan → Execute 双阶段（支持重规划循环） */
  private async planAndExecute(userInput: string, messages: ChatMessage[]): Promise<string> {
    // ─── Plan 阶段 ───
    this.setPhase('planning')

    const plannerRoute = this.router!.getRouteInfo('planner')
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

  /** 运行 Executor */
  private async runExecutor(plan: Plan, messages: ChatMessage[]): Promise<string> {
    this.setPhase('executing')

    const executorRoute = this.router!.getRouteInfo('executor')
    const executor = new Executor({
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
      maxSessionCost: this.cfg.config.limits.maxSessionCost,
      getFallbackModel: () => this.router!.getModelWithFallback('executor'),
      fallbackModelName: this.router!.getFallbackModelName('executor') ?? undefined,
      abortSignal: this.abortController?.signal,
    })

    const result = await executor.execute(plan, messages)
    this.todos = executor.getTodos()
    return result
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

  /** 获取成本摘要 */
  getCostSummary(): { total: number; inputTokens: number; outputTokens: number } {
    const tokens = this.costTracker.getTotalTokens()
    return {
      total: this.costTracker.getTotalCost(),
      inputTokens: tokens.input,
      outputTokens: tokens.output,
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
  getAllKnownModels(): Array<{ name: string; provider: string; configured: boolean; current: boolean }> {
    return this.router?.getAllKnownModels() ?? []
  }

  /** 检查指定 provider 是否已配置 API Key */
  isProviderConfigured(providerName: string): boolean {
    return this.router?.isProviderConfigured(providerName as any) ?? false
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

    // 先合并 checkpoint
    try {
      await this.mergeCheckpoints()
    } catch (err) {
      console.warn('[Checkpoint] 合并检查点失败:', err)
    }

    if (this.db && this.currentSessionId) {
      try {
        const cost = this.getCostSummary()
        this.db.endSession(
          this.currentSessionId,
          cost.total,
          cost.inputTokens,
          cost.outputTokens,
          this.history.length
        )
      } catch (err) {
        console.warn('[NexusDB] 结束会话失败:', err)
      }
      this.currentSessionId = null
    }
    this.db?.close()
    this.db = null

    // 断开所有外部 MCP Server 连接
    if (this.mcpManager) {
      try {
        await this.mcpManager.disconnectAll()
      } catch (err) {
        console.warn('[MCP] 断开外部 Server 失败:', err)
      }
      this.mcpManager = null
    }

    // 停止文件监听
    if (this.fileWatcher) {
      this.fileWatcher.stop()
      this.fileWatcher = null
    }
  }

  /** 清除上下文 */
  clearContext(): void {
    this.history = []
    this.todos = []
  }

  /** 恢复指定会话（从 DB 加载 history + todos） */
  async restoreSession(sessionId?: string): Promise<{ restored: boolean; message: string }> {
    // 确保 DB 已初始化
    if (!this.db) {
      try {
        this.db = new NexusDB(this.cfg.projectRoot)
      } catch {
        return { restored: false, message: '数据库不可用，无法恢复会话' }
      }
    }

    // 查找目标会话
    const session = sessionId
      ? this.db.getSession(sessionId)
      : this.db.getLatestSession(this.cfg.projectRoot)

    if (!session) {
      return { restored: false, message: sessionId ? `未找到会话: ${sessionId}` : '没有可恢复的历史会话' }
    }

    // 加载消息历史
    const messages = this.db.getMessages(session.id)
    if (messages.length === 0) {
      return { restored: false, message: '该会话没有消息记录' }
    }

    // 重建 history（只恢复 user/assistant 角色）
    this.history = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))

    // 加载 todos
    this.todos = this.db.loadTodos(session.id)

    // 设置当前会话 ID 为恢复的会话（继续在同一会话下追加消息）
    this.currentSessionId = session.id

    const todoInfo = this.todos.length > 0
      ? `，${this.todos.filter((t) => t.status !== 'complete').length} 个待办未完成`
      : ''
    const msg = `已恢复会话（${new Date(session.start_time).toLocaleString()}）：${this.history.length} 条消息${todoInfo}`

    this.emit({ type: 'system_info', message: msg })
    if (this.todos.length > 0) {
      this.emit({ type: 'todo_update', todos: this.todos })
    }

    return { restored: true, message: msg }
  }

  /** 列出最近会话（供 /resume 命令展示） */
  listRecentSessions(limit = 5): Array<{ id: string; startTime: number; messageCount: number; cost: number }> {
    if (!this.db) {
      try {
        this.db = new NexusDB(this.cfg.projectRoot)
      } catch {
        return []
      }
    }
    return this.db.listRecentSessions(limit, this.cfg.projectRoot).map((s) => ({
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
    return this.history
      .filter((m) => m.role === 'user')
      .map((m) => m.content.slice(0, 80))
  }

  /** 获取完整历史（用于导出） */
  getFullHistory(): ChatMessage[] {
    return [...this.history]
  }

  /** 获取各子系统健康状态 */
  getStatus(): { db: boolean; codeGraph: boolean; mcp: boolean; watcher: boolean; model: string; cost: number } {
    return {
      db: this.db !== null,
      codeGraph: this.codeGraph !== null && this.codeGraph.files.size > 0,
      mcp: this.mcpManager !== null,
      watcher: this.fileWatcher !== null && this.fileWatcher.isRunning(),
      model: this.getCurrentModel(),
      cost: this.costTracker.getTotalCost(),
    }
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
    this.cfg.onEvent(event)
  }
}

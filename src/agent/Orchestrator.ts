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

export interface OrchestratorConfig {
  projectRoot: string
  config: NexusConfig
  permissionMode: PermissionMode
  skipPlan: boolean
  maxIterations: number
  onEvent: (event: NexusEvent) => void
  requestApproval: (tool: string, params: Record<string, unknown>, diff?: string) => Promise<boolean>
}

export class Orchestrator {
  private cfg: OrchestratorConfig
  private phase: AgentPhase = 'idle'
  private history: ChatMessage[] = []
  private todos: Todo[] = []
  private toolRegistry = createToolRegistry()
  private costTracker = new CostTracker()
  private router: ModelRouter
  private checkpoint: CheckpointManager
  private assembler: ContextAssembler | null = null
  private rules: ProjectRules | null = null
  private aborted = false

  constructor(cfg: OrchestratorConfig) {
    this.cfg = cfg
    this.router = new ModelRouter(cfg.config, this.costTracker)
    this.checkpoint = new CheckpointManager(
      cfg.projectRoot,
      cfg.config.checkpoint.branch
    )
  }

  /** 初始化:加载规则、构建上下文组装器 */
  async init(): Promise<void> {
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

    // 初始化 git checkpoint
    if (this.cfg.config.checkpoint.autoCheckpoint) {
      await this.checkpoint.init()
    }
  }

  /** 处理用户输入(主入口) */
  async submit(userInput: string): Promise<string> {
    if (!this.assembler || !this.rules) {
      await this.init()
    }

    this.aborted = false
    this.emit({ type: 'user_input', text: userInput })

    // 构建上下文
    const systemPrompt = await this.assembler!.buildSystemPrompt(this.todos)
    const messages = this.assembler!.assembleMessages(systemPrompt, this.history, userInput)

    let result: string

    if (this.cfg.skipPlan) {
      // 跳过 Plan,直接执行
      result = await this.executeDirectly(userInput, messages)
    } else {
      // 双阶段: Plan → Execute
      result = await this.planAndExecute(userInput, messages)
    }

    // 记录到历史
    this.history.push({ role: 'user', content: userInput })
    this.history.push({ role: 'assistant', content: result })

    this.phase = 'done'
    this.emit({ type: 'done', summary: result })
    return result
  }

  /** Plan → Execute 双阶段 */
  private async planAndExecute(userInput: string, messages: ChatMessage[]): Promise<string> {
    // ─── Plan 阶段 ───
    this.setPhase('planning')

    const planner = new Planner({
      model: this.router.getModel('planner'),
      toolRegistry: this.toolRegistry,
      toolContext: this.getToolContext(),
      maxIterations: Math.min(this.cfg.maxIterations, 15),
      onEvent: (e) => this.emit(e),
    })

    const plan = await planner.plan(userInput, messages)
    this.todos = plan.todos
    this.emit({ type: 'todo_update', todos: this.todos })

    // 等待用户审批计划
    this.setPhase('awaiting_approval')
    const approved = await this.cfg.requestApproval('plan', { plan: plan.summary })
    if (!approved) {
      return '计划被拒绝。请重新描述你的需求,或告诉我需要调整什么。'
    }

    if (this.aborted) return '已中断。'

    // ─── Execute 阶段 ───
    return await this.runExecutor(plan, messages)
  }

  /** 直接执行(跳过 Plan) */
  private async executeDirectly(userInput: string, messages: ChatMessage[]): Promise<string> {
    const plan: Plan = {
      summary: userInput,
      todos: [{ id: '1', content: userInput, status: 'pending' }],
      filesToModify: [],
      estimatedSteps: 1,
    }
    this.todos = plan.todos
    return await this.runExecutor(plan, messages)
  }

  /** 运行 Executor */
  private async runExecutor(plan: Plan, messages: ChatMessage[]): Promise<string> {
    this.setPhase('executing')

    const executor = new Executor({
      model: this.router.getModel('executor'),
      toolRegistry: this.toolRegistry,
      toolContext: this.getToolContext(),
      checkpoint: this.checkpoint,
      maxIterations: this.cfg.maxIterations,
      permissionMode: this.cfg.permissionMode,
      onEvent: (e) => this.emit(e),
      requestApproval: this.cfg.requestApproval,
    })

    const result = await executor.execute(plan, messages)
    this.todos = executor.getTodos()
    return result
  }

  /** 中断当前操作 */
  abort(): void {
    this.aborted = true
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
    return this.router.getCurrentModel('executor')
  }

  /** 切换模型 */
  setModel(model: string): void {
    this.router.setModel('executor', model)
    this.router.setModel('planner', model)
  }

  /** 清除上下文 */
  clearContext(): void {
    this.history = []
    this.todos = []
  }

  /** 获取历史摘要 */
  getHistory(): string[] {
    return this.history
      .filter((m) => m.role === 'user')
      .map((m) => m.content.slice(0, 80))
  }

  private getToolContext(): ToolContext {
    return {
      projectRoot: this.cfg.projectRoot,
      callId: '',
      maxReadLines: this.cfg.config.limits.maxReadLines,
      maxOutputBytes: this.cfg.config.limits.maxOutputBytes,
      bashTimeout: this.cfg.config.limits.bashTimeout,
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

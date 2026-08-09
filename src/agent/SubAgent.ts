/**
 * 子 Agent 分派
 * 复杂任务自动拆解,子 Agent 有独立上下文窗口
 * 关键约束:深度限制 1 层,写权限默认关闭
 *
 * 多智能体协作增强（2026-08）：
 * - worktree 隔离执行（isolation: 'worktree'）：并行写防踩脚，业界首选方案
 * - coder→reviewer 自动审查闭环：写变更自动审查，高危问题回传修复一轮
 * - Mailbox 信箱轮询：每轮工具执行后检查新消息注入下轮上下文
 * - 成本熔断：会话成本超限时拒绝 spawn 新子任务
 */

import type { LanguageModel } from 'ai'
import { generateText, stepCountIs } from 'ai'
import type { CostTracker } from '../router/CostTracker'
import { withDeepSeekThinking } from '../router/providers/deepseekFetch'
import { requiresForcedApproval } from '../sandbox/CommandGuard'
import type { WorktreeInfo, WorktreeManager } from '../sandbox/WorktreeManager'
import type { ToolContext, ToolRegistry } from '../tools/registry'
import { resolveToolParameters } from '../tools/schemas'
import type { AgentEngineRegistry } from './AgentEngine'
import type { ToolApprovalDecision } from './Executor'
import { Mailbox } from './Mailbox'
import { splitModelParameters } from './ReActLoop'
import type {
  ModelRole,
  ModelRoute,
  NexusEvent,
  PermissionMode,
  SubAgentResult,
  SubAgentTask,
} from './types'

export interface SubAgentConfig {
  model: LanguageModel
  toolRegistry: ToolRegistry
  toolContext: ToolContext
  maxIterations: number
  onEvent: (event: NexusEvent) => void
  /** 权限模式（与 Executor 一致） */
  permissionMode: PermissionMode
  /** 审批回调：返回 true=批准 / false=拒绝 / 带 reason 决策对象 */
  requestApproval: (
    tool: string,
    params: Record<string, unknown>,
    diff?: string,
  ) => Promise<ToolApprovalDecision>
  /** 成本追踪器 */
  costTracker: CostTracker
  /** 当前模型角色（用于成本记录） */
  modelRole: ModelRole
  /** 当前 provider 名称 */
  providerName: string
  /** 当前模型名称 */
  modelName: string
  /** 输入 token 单价（每 1k） */
  costPer1kInput: number
  /** 输出 token 单价（每 1k） */
  costPer1kOutput: number
  /** 缓存命中输入单价（每 1k），DeepSeek 分级计费用 */
  costPer1kInputCached?: number
  /**
   * Provider 特定的模型参数（DeepSeek 深度适配）。
   * 子 Agent 同样是多轮工具调用，需传入 thinking: disabled 等参数避免 422。
   */
  modelParameters?: Record<string, unknown>
  /**
   * 中断信号获取器（Orchestrator.abort() 时触发，与 Executor 行为一致）。
   * 用 getter 而非静态 signal：因为 SubAgent 在 init() 时创建，
   * 而 abortController 在 submit() 时才新建，getter 保证始终拿到最新的 signal。
   */
  getAbortSignal?: () => AbortSignal | undefined
  /** 引擎注册表（解析 task.engine 的角色/工具/迭代上限） */
  engineRegistry?: AgentEngineRegistry
  /** 按模型名解析引擎差异化模型（Orchestrator 注入，走 ModelRouter 降级链） */
  getEngineModel?: (modelName: string) => LanguageModel
  /** 按模型名获取路由信息（引擎差异化模型的成本追踪） */
  getEngineRouteInfo?: (modelName: string) => ModelRoute
  /** worktree 管理器（isolation: 'worktree' 并行写隔离用，缺省不支持隔离） */
  worktreeManager?: WorktreeManager
  /** 引擎间信箱（多智能体通信用，缺省不启用） */
  mailbox?: Mailbox
  /** 会话成本上限（熔断用，缺省不熔断） */
  maxSessionCost?: number
}

export class SubAgent {
  private config: SubAgentConfig

  constructor(config: SubAgentConfig) {
    this.config = config
  }

  /** 执行子 Agent 任务（生命周期壳：成本熔断 → 引擎校验 → worktree 隔离 → 审查闭环） */
  async run(task: SubAgentTask): Promise<SubAgentResult> {
    // ─── 成本熔断：多 Agent 协作耗 token 约 15x（Anthropic 复盘数据），超限时拒绝 spawn ───
    if (
      this.config.maxSessionCost !== undefined &&
      this.config.costTracker.isOverBudget(this.config.maxSessionCost)
    ) {
      this.emitDone(task.engine ?? 'generic', task.id, false, '')
      return {
        id: task.id,
        success: false,
        summary: '',
        filesChanged: [],
        error: `会话成本已超过上限，拒绝分派子任务 ${task.id}。请控制多智能体使用范围（仅高价值、高度可并行的任务）`,
      }
    }

    const engineDef = task.engine ? this.config.engineRegistry?.get(task.engine) : undefined
    if (task.engine && !engineDef) {
      this.emitDone(task.engine, task.id, false, '')
      return {
        id: task.id,
        success: false,
        summary: '',
        filesChanged: [],
        error: `未知引擎: ${task.engine}`,
      }
    }

    // ─── worktree 隔离：writable + isolation 且管理器可用时创建独立工作目录 ───
    const wantIsolation =
      task.isolation === 'worktree' && (task.writable ?? engineDef?.writable ?? false)
    let worktreeInfo: WorktreeInfo | null = null
    if (wantIsolation && this.config.worktreeManager) {
      worktreeInfo = await this.config.worktreeManager.create(task.id)
      // 创建失败（非 git 仓库/无 git）：回退主工作区执行，不阻塞任务
    }

    let result = await this.runCore(task, worktreeInfo?.path)

    // ─── worktree 收尾：无变更自动清理；有变更提交后进入审查/合并流程 ───
    const wm = this.config.worktreeManager
    if (worktreeInfo && wm) {
      if (!result.success) {
        // 失败保留现场（可能有部分变更需人工检查），仅在结果中标注
        result = { ...result, worktreePath: worktreeInfo.path, worktreeBranch: worktreeInfo.branch }
      } else {
        const changed = await wm.hasChanges(task.id)
        if (!changed) {
          await wm.remove(task.id)
        } else {
          await wm.commitChanges(
            task.id,
            `nexus-agent(${task.id}): ${task.description.slice(0, 60)}`,
          )
          // 审查闭环在合并前进行（reviewer 指向同一 worktree）
          result = await this.maybeAutoReview(task, engineDef, result, worktreeInfo.path)
          result = {
            ...result,
            worktreeBranch: worktreeInfo.branch,
            worktreePath: worktreeInfo.path,
            diffSummary: await wm.getDiffSummary(task.id),
          }
        }
      }
    } else {
      // 主工作区写任务同样走审查闭环（编排层串行执行，无踩脚风险）
      result = await this.maybeAutoReview(task, engineDef, result, undefined)
    }

    return result
  }

  /**
   * 自动审查闭环（coder→reviewer）：
   * 引擎开启 autoReview 且任务成功有文件变更时，自动派 reviewer 引擎审查；
   * 报告含高严重度问题时回传原引擎修复一轮（限 1 轮，防成本失控）。
   * 审查/修复任务均带 noReview 标记，不会递归触发。
   */
  private async maybeAutoReview(
    task: SubAgentTask,
    engineDef: { name: string; autoReview?: boolean } | undefined,
    result: SubAgentResult,
    reviewRoot: string | undefined,
  ): Promise<SubAgentResult> {
    if (
      !result.success ||
      result.filesChanged.length === 0 ||
      task.noReview ||
      !engineDef?.autoReview ||
      !this.config.engineRegistry?.has('reviewer')
    ) {
      return result
    }

    const changeList = result.filesChanged.join(', ')
    const diffPart = result.diffSummary ? `\n\n变更摘要:\n${result.diffSummary}` : ''
    const reviewTask: SubAgentTask = {
      id: `${task.id}-review`,
      description: `审查以下代码变更的质量（逻辑缺陷、边界条件、错误处理、安全隐患）。审查范围仅限这些变更：${changeList}${diffPart}`,
      tools: [],
      maxIterations: 10,
      engine: 'reviewer',
      noReview: true,
      ...(reviewRoot ? { runInDir: reviewRoot } : {}),
    }
    const reviewResult = await this.runCore(reviewTask, reviewRoot)
    const reviewReport = reviewResult.success ? reviewResult.summary : ''
    if (!reviewReport) {
      return { ...result, reviewReport: reviewResult.error ?? '(审查未产出报告)' }
    }

    // 高严重度问题 → 回传原引擎修复一轮（审查报告按引擎提示词约定含 高/中/低 分级）
    if (reviewReport.includes('高')) {
      const fixTask: SubAgentTask = {
        id: `${task.id}-fix`,
        description: `修复审查发现的高严重度问题。原任务: ${task.description}`,
        tools: task.tools,
        maxIterations: task.maxIterations,
        ...(task.engine ? { engine: task.engine } : {}),
        writable: true,
        noReview: true,
        input: `审查报告（仅修复标记为"高"的问题）:\n${reviewReport}`,
        ...(reviewRoot ? { runInDir: reviewRoot } : {}),
      }
      const fixResult = await this.runCore(fixTask, reviewRoot)
      const mergedFiles = Array.from(new Set([...result.filesChanged, ...fixResult.filesChanged]))
      return {
        ...result,
        filesChanged: mergedFiles,
        reviewReport: `${reviewReport}\n\n[自动修复轮] ${fixResult.success ? fixResult.summary : `修复失败: ${fixResult.error}`}`,
      }
    }

    return { ...result, reviewReport }
  }

  /** 核心执行循环（引擎解析 → 工具循环 → 汇总）。rootOverride：worktree/既有目录执行用 */
  private async runCore(task: SubAgentTask, rootOverride?: string): Promise<SubAgentResult> {
    const { toolRegistry, toolContext, onEvent } = this.config
    // 执行目录：显式 rootOverride（worktree）优先，其次任务自带 runInDir（审查/修复指向同一目录）
    const effectiveRoot = rootOverride ?? task.runInDir
    const execToolContext: ToolContext = effectiveRoot
      ? { ...toolContext, projectRoot: effectiveRoot }
      : toolContext

    // ─── 引擎解析：task.engine 存在时从注册表取引擎定义 ────────────────────
    const engineDef = task.engine ? this.config.engineRegistry?.get(task.engine) : undefined
    onEvent({ type: 'agent_start', engine: engineDef?.name ?? 'generic', taskId: task.id })

    // 引擎差异化模型：引擎指定 model 时经 getEngineModel 闭包解析（含降级链）
    const engineRoute = engineDef?.model
      ? this.config.getEngineRouteInfo?.(engineDef.model)
      : undefined
    const model =
      engineDef?.model && this.config.getEngineModel
        ? this.config.getEngineModel(engineDef.model)
        : this.config.model
    const { providerName, modelName, costPer1kInput, costPer1kOutput, costPer1kInputCached } =
      engineRoute
        ? {
            providerName: engineRoute.provider,
            modelName: engineRoute.model,
            costPer1kInput: engineRoute.costPer1kInput,
            costPer1kOutput: engineRoute.costPer1kOutput,
            costPer1kInputCached: engineRoute.costPer1kInputCached,
          }
        : {
            providerName: this.config.providerName,
            modelName: this.config.modelName,
            costPer1kInput: this.config.costPer1kInput,
            costPer1kOutput: this.config.costPer1kOutput,
            costPer1kInputCached: this.config.costPer1kInputCached,
          }

    // 写权限：任务显式值优先，其次引擎默认值
    const writable = task.writable ?? engineDef?.writable ?? false

    // 根据 writable 决定可用工具
    const phase = writable ? 'execute' : 'plan'
    const availableTools = toolRegistry.getForPhase(phase)

    // 工具白名单：引擎 tools 为上限，任务 tools 为附加限制（引擎未配置时沿用任务列表）
    const engineTools = engineDef?.tools ?? []
    const requestedTools =
      task.tools.length > 0
        ? engineTools.length > 0
          ? task.tools.filter((t) => engineTools.includes(t))
          : task.tools
        : engineTools
    const filteredTools =
      requestedTools.length > 0
        ? availableTools.filter((t) => requestedTools.includes(t.definition.name))
        : availableTools

    const toolsForAI: Record<string, { description: string; parameters: unknown }> = {}
    for (const tool of filteredTools) {
      toolsForAI[tool.definition.name] = {
        description: tool.definition.description,
        parameters: resolveToolParameters(tool.definition.name, tool.definition.inputSchema),
      }
    }

    // 迭代上限：引擎定义优先（引擎无定义时用任务参数）
    const maxIterations = engineDef?.maxIterations ?? task.maxIterations

    // 系统提示词：引擎角色提示词 + 任务描述 + 流水线前序输出
    const systemPrefix = engineDef?.systemPrompt ?? task.systemPrompt ?? ''
    const inputSection = task.input ? `\n\n上游输出（供参考）:\n${task.input}` : ''
    // 多智能体协作上下文：告知自身 ID 与通信方式（Mailbox/任务板可用时）
    const agentId = `${engineDef?.name ?? 'generic'}-${task.id}`
    const teamSection = this.config.mailbox
      ? `\n\n多智能体协作：你的 ID 是 ${agentId}，主 Agent ID 是 lead。可用 send_message 向其他 agent 发消息（如任务依赖、需要协助），用 team_task_list/team_task_claim 查看和认领共享任务。`
      : ''
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
      {
        role: 'user',
        content: `${
          systemPrefix
            ? `${systemPrefix}

`
            : ''
        }你是一个子 Agent,负责完成以下子任务:

${task.description}

完成后输出简洁的结果摘要。${inputSection}${teamSection}`,
      },
    ]

    let iterations = 0
    let summary = ''
    const filesChanged: string[] = []

    try {
      while (iterations < maxIterations) {
        // 检查中断信号（与 Executor 行为一致）
        const abortSignal = this.config.getAbortSignal?.()
        if (abortSignal?.aborted) {
          this.emitDone(engineDef?.name ?? 'generic', task.id, false, '')
          return {
            id: task.id,
            success: false,
            summary: '',
            filesChanged,
            error: '子 Agent 已被中断',
          }
        }
        iterations++

        // 拆分 provider 参数：thinking 经 ALS + fetch 拦截器注入，其余经 providerOptions 映射
        const { topLevel, providerOptions, thinking } = splitModelParameters(
          this.config.modelParameters,
        )
        // v6: 工具字段 parameters → inputSchema；maxSteps → stopWhen
        const toolsForSDK: Record<string, unknown> = {}
        for (const [name, t] of Object.entries(toolsForAI)) {
          toolsForSDK[name] = { description: t.description, inputSchema: t.parameters }
        }
        const result = await withDeepSeekThinking(thinking, () =>
          generateText({
            model,
            messages,
            tools: toolsForSDK,
            stopWhen: stepCountIs(1),
            abortSignal,
            ...(topLevel as Record<string, never>),
            ...(providerOptions ? { providerOptions } : {}),
          } as never),
        )

        // 记录成本（引擎差异化模型时按该模型路由计费；v6 usage 字段 inputTokens/outputTokens）
        const usage = await result.usage
        if (usage) {
          this.config.costTracker.record({
            role: this.config.modelRole,
            provider: providerName,
            model: modelName,
            inputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
            costPer1kInput,
            costPer1kOutput,
            costPer1kInputCached,
          })
        }

        if (!result.toolCalls || result.toolCalls.length === 0) {
          summary = result.text
          break
        }

        messages.push({ role: 'assistant', content: result.text || '' } as never)

        for (const toolCall of result.toolCalls) {
          const callId = `sub-${task.id}-${iterations}-${toolCall.toolName}`
          // v6: toolCall 参数字段 args → input
          const args = (toolCall.input ?? {}) as Record<string, unknown>

          // 权限检查（与 Executor 一致的逻辑）
          const approved = await this.checkPermission(toolCall.toolName, args)
          if (!approved) {
            messages.push({
              role: 'user',
              content: `[工具被拒绝 ${toolCall.toolName}]: 用户拒绝了此操作`,
            } as never)
            continue
          }

          const toolResult = await toolRegistry.execute(toolCall.toolName, args, {
            ...execToolContext,
            callId,
          })

          // 追踪文件变更
          if (toolCall.toolName === 'edit_file' && !toolResult.error && args.path) {
            filesChanged.push(args.path as string)
          }

          const resultContent = toolResult.error ? `[错误]: ${toolResult.error}` : toolResult.result
          messages.push({
            role: 'user',
            content: `[${toolCall.toolName}]: ${resultContent}`,
          } as never)
        }

        // Mailbox 轮询：每轮工具执行后检查新消息，注入下轮上下文（Agent Teams 通信机制）
        if (this.config.mailbox) {
          const unread = this.config.mailbox.readUnread(agentId)
          if (unread.length > 0) {
            messages.push({
              role: 'user',
              content: `[信箱消息] ${Mailbox.formatMessages(unread)}`,
            } as never)
          }
        }
      }

      if (iterations >= maxIterations && !summary) {
        summary = '达到子 Agent 迭代上限,任务可能未完全完成。'
      }

      this.emitDone(engineDef?.name ?? 'generic', task.id, true, summary)
      return {
        id: task.id,
        success: true,
        summary,
        filesChanged,
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      this.emitDone(engineDef?.name ?? 'generic', task.id, false, message)
      return {
        id: task.id,
        success: false,
        summary: '',
        filesChanged,
        error: message,
      }
    }
  }

  /** 权限检查（与 Executor 逻辑一致）；返回决策（可含拒绝原因） */
  private async checkPermission(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ToolApprovalDecision> {
    const { toolRegistry, permissionMode, requestApproval } = this.config
    const handler = toolRegistry.get(toolName)
    // 只读工具无需审批
    if (!handler?.definition.requiresApproval) return true

    // bash 危险命令始终强制审批
    if (
      toolName === 'bash' &&
      typeof args.command === 'string' &&
      requiresForcedApproval(args.command)
    ) {
      return requestApproval(toolName, args)
    }

    switch (permissionMode) {
      case 'yolo':
        return true
      case 'auto-all':
        return true
      case 'auto-edit':
        return toolName === 'edit_file' ? true : requestApproval(toolName, args)
      case 'ask':
      default:
        return requestApproval(toolName, args)
    }
  }

  /** 引擎注册表（供工具层校验引擎名与构造 PipelineRunner） */
  getEngineRegistry(): AgentEngineRegistry | undefined {
    return this.config.engineRegistry
  }

  /** 发出 agent_done 事件（run 的所有出口统一调用） */
  private emitDone(engine: string, taskId: string, success: boolean, summary: string): void {
    this.config.onEvent({ type: 'agent_done', engine, taskId, success, summary })
  }
}

/** dispatch_subagent 工具的定义(暴露给主 Agent 的 LLM) */
export const dispatchSubagentToolDefinition = {
  name: 'dispatch_subagent',
  description:
    '分派一个子 Agent 执行独立的子任务。子 Agent 有独立的上下文窗口,只返回最终结果。适用于:探索大量文件、批量修改、独立验证等。写任务加 isolation:"worktree" 可在独立 git worktree 中执行（完成后需审批合并）。',
  inputSchema: {
    type: 'object' as const,
    properties: {
      description: {
        type: 'string' as const,
        description: '子任务的详细描述',
      },
      writable: {
        type: 'boolean' as const,
        description: '是否允许子 Agent 修改文件(默认 false)',
      },
      tools: {
        type: 'array' as const,
        description: '允许使用的工具列表(默认根据 writable 自动选择)',
        items: { type: 'string' as const },
      },
      isolation: {
        type: 'string' as const,
        description:
          '隔离模式：worktree = 在独立 git worktree 中执行（写任务防踩脚，完成后需审批合并）',
        enum: ['worktree'],
      },
    },
    required: ['description'],
  },
  requiresApproval: true,
  phase: 'execute' as const,
}

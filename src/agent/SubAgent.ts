/**
 * 子 Agent 分派
 * 复杂任务自动拆解,子 Agent 有独立上下文窗口
 * 关键约束:深度限制 1 层,写权限默认关闭
 */

import type { LanguageModel } from 'ai'
import { generateText } from 'ai'
import type { CostTracker } from '../router/CostTracker'
import { withDeepSeekThinking } from '../router/providers/deepseekFetch'
import { requiresForcedApproval } from '../sandbox/CommandGuard'
import type { ToolContext, ToolRegistry } from '../tools/registry'
import { resolveToolParameters } from '../tools/schemas'
import type { AgentEngineRegistry } from './AgentEngine'
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
  /** 审批回调 */
  requestApproval: (
    tool: string,
    params: Record<string, unknown>,
    diff?: string,
  ) => Promise<boolean>
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
}

export class SubAgent {
  private config: SubAgentConfig

  constructor(config: SubAgentConfig) {
    this.config = config
  }

  /** 执行子 Agent 任务 */
  async run(task: SubAgentTask): Promise<SubAgentResult> {
    const { toolRegistry, toolContext, onEvent } = this.config

    // ─── 引擎解析：task.engine 存在时从注册表取引擎定义 ────────────────────
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

完成后输出简洁的结果摘要。${inputSection}`,
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
        const result = await withDeepSeekThinking(thinking, () =>
          generateText({
            model,
            messages,
            tools: toolsForAI,
            maxSteps: 1,
            abortSignal,
            ...(topLevel as Record<string, never>),
            ...(providerOptions ? { providerOptions } : {}),
          } as Parameters<typeof generateText>[0]),
        )

        // 记录成本（引擎差异化模型时按该模型路由计费）
        const usage = await result.usage
        if (usage) {
          this.config.costTracker.record({
            role: this.config.modelRole,
            provider: providerName,
            model: modelName,
            inputTokens: usage.promptTokens,
            outputTokens: usage.completionTokens,
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
          const args = toolCall.args as Record<string, unknown>

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
            ...toolContext,
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

  /** 权限检查（与 Executor 逻辑一致） */
  private async checkPermission(toolName: string, args: Record<string, unknown>): Promise<boolean> {
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
    '分派一个子 Agent 执行独立的子任务。子 Agent 有独立的上下文窗口,只返回最终结果。适用于:探索大量文件、批量修改、独立验证等。',
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
    },
    required: ['description'],
  },
  requiresApproval: true,
  phase: 'execute' as const,
}

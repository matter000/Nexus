/**
 * 子 Agent 分派
 * 复杂任务自动拆解,子 Agent 有独立上下文窗口
 * 关键约束:深度限制 1 层,写权限默认关闭
 */

import { generateText } from 'ai'
import type { LanguageModel } from 'ai'
import type { NexusEvent, PermissionMode, SubAgentResult, SubAgentTask, ModelRole } from './types'
import type { ToolRegistry, ToolContext } from '../tools/registry'
import { requiresForcedApproval } from '../sandbox/CommandGuard'
import type { CostTracker } from '../router/CostTracker'

export interface SubAgentConfig {
  model: LanguageModel
  toolRegistry: ToolRegistry
  toolContext: ToolContext
  maxIterations: number
  onEvent: (event: NexusEvent) => void
  /** 权限模式（与 Executor 一致） */
  permissionMode: PermissionMode
  /** 审批回调 */
  requestApproval: (tool: string, params: Record<string, unknown>, diff?: string) => Promise<boolean>
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
}

export class SubAgent {
  private config: SubAgentConfig

  constructor(config: SubAgentConfig) {
    this.config = config
  }

  /** 执行子 Agent 任务 */
  async run(task: SubAgentTask): Promise<SubAgentResult> {
    const { model, toolRegistry, toolContext, maxIterations, onEvent } = this.config

    // 根据 writable 决定可用工具
    const phase = task.writable ? 'execute' : 'plan'
    const availableTools = toolRegistry.getForPhase(phase)

    // 如果指定了工具列表,进一步过滤
    const filteredTools = task.tools.length > 0
      ? availableTools.filter((t) => task.tools.includes(t.definition.name))
      : availableTools

    const toolsForAI: Record<string, { description: string; parameters: unknown }> = {}
    for (const tool of filteredTools) {
      toolsForAI[tool.definition.name] = {
        description: tool.definition.description,
        parameters: tool.definition.inputSchema as unknown,
      }
    }

    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
      {
        role: 'user',
        content: `你是一个子 Agent,负责完成以下子任务:\n\n${task.description}\n\n完成后输出简洁的结果摘要。`,
      },
    ]

    let iterations = 0
    let summary = ''
    const filesChanged: string[] = []

    try {
      while (iterations < task.maxIterations) {
        iterations++

        const result = await generateText({
          model,
          messages,
          tools: toolsForAI,
          maxSteps: 1,
        })

        // 记录成本
        const usage = await result.usage
        if (usage) {
          this.config.costTracker.record({
            role: this.config.modelRole,
            provider: this.config.providerName,
            model: this.config.modelName,
            inputTokens: usage.promptTokens,
            outputTokens: usage.completionTokens,
            costPer1kInput: this.config.costPer1kInput,
            costPer1kOutput: this.config.costPer1kOutput,
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

          const resultContent = toolResult.error
            ? `[错误]: ${toolResult.error}`
            : toolResult.result
          messages.push({ role: 'user', content: `[${toolCall.toolName}]: ${resultContent}` } as never)
        }
      }

      if (iterations >= task.maxIterations && !summary) {
        summary = '达到子 Agent 迭代上限,任务可能未完全完成。'
      }

      return {
        id: task.id,
        success: true,
        summary,
        filesChanged,
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
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
    if (toolName === 'bash' && typeof args.command === 'string' && requiresForcedApproval(args.command)) {
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

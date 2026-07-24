/**
 * 子 Agent 分派
 * 复杂任务自动拆解,子 Agent 有独立上下文窗口
 * 关键约束:深度限制 1 层,写权限默认关闭
 */

import { generateText } from 'ai'
import type { LanguageModel } from 'ai'
import type { NexusEvent, SubAgentResult, SubAgentTask } from './types'
import type { ToolRegistry, ToolContext } from '../tools/registry'

export interface SubAgentConfig {
  model: LanguageModel
  toolRegistry: ToolRegistry
  toolContext: ToolContext
  maxIterations: number
  onEvent: (event: NexusEvent) => void
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

        if (!result.toolCalls || result.toolCalls.length === 0) {
          summary = result.text
          break
        }

        messages.push({ role: 'assistant', content: result.text || '' } as never)

        for (const toolCall of result.toolCalls) {
          const callId = `sub-${task.id}-${iterations}-${toolCall.toolName}`
          const args = toolCall.args as Record<string, unknown>

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
  requiresApproval: false,
  phase: 'execute' as const,
}

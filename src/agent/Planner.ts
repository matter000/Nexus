/**
 * Plan 阶段
 * 探索代码库 + 生成结构化计划,只用只读工具(read/grep)
 */

import { streamText } from 'ai'
import type { LanguageModel } from 'ai'
import type { ChatMessage, Plan, Todo, NexusEvent, ModelRole } from './types'
import type { ToolRegistry, ToolContext } from '../tools/registry'
import { toolSchemas } from '../tools/schemas'
import { consumePendingPlan, setPendingPlan } from '../tools/submitPlan'
import type { CostTracker } from '../router/CostTracker'
import { callWithRetry } from '../utils'

const PLAN_SYSTEM_SUFFIX = `
## 当前阶段: Plan (规划)

你正在规划阶段。你的任务是:
1. 使用 read_file 和 grep 工具探索代码库,理解现有实现
2. 分析用户的需求,确定需要修改哪些文件
3. 调用 submit_plan 工具提交结构化的执行计划

## 提交计划

在探索完成后,调用 submit_plan 工具提交计划,包含:
- summary: 计划摘要（一句话描述整体目标）
- todos: 执行步骤列表,每步包含 id 和 content
- filesToModify: 预计需要修改的文件路径列表
- estimatedSteps: 预估总步数

注意:
- 计划要具体可执行,每步对应一个明确的文件操作
- 步骤数量合理(通常 3-10 步)
- 先理解再规划,不要凭空猜测文件内容
- 调用 submit_plan 后规划阶段结束,不需要额外输出文本`

export interface PlannerConfig {
  model: LanguageModel
  toolRegistry: ToolRegistry
  toolContext: ToolContext
  maxIterations: number
  onEvent: (event: NexusEvent) => void
  /** 成本追踪器 */
  costTracker: CostTracker
  /** 当前模型角色（用于成本记录） */
  modelRole: ModelRole
  /** 当前 provider 名称（用于成本记录，内置为 ProviderName，自定义为任意键名） */
  providerName: string
  /** 当前模型名称（用于成本记录） */
  modelName: string
  /** 输入 token 单价（每 1k） */
  costPer1kInput: number
  /** 输出 token 单价（每 1k） */
  costPer1kOutput: number
}

export class Planner {
  private config: PlannerConfig

  constructor(config: PlannerConfig) {
    this.config = config
  }

  /** 执行 Plan 阶段,返回结构化计划 */
  async plan(userRequest: string, contextMessages: ChatMessage[]): Promise<Plan> {
    const { model, toolRegistry, toolContext, maxIterations, onEvent } = this.config

    // 清除上一轮遗留的 pendingPlan，防止跨调用状态泄漏
    setPendingPlan(null)

    onEvent({ type: 'llm_start', phase: 'plan' })

    // Plan 阶段只用只读工具
    const planTools = toolRegistry.getForPhase('plan')
    const toolsForAI: Record<string, { description: string; parameters: unknown }> = {}
    for (const tool of planTools) {
      toolsForAI[tool.definition.name] = {
        description: tool.definition.description,
        parameters: toolSchemas[tool.definition.name] ?? tool.definition.inputSchema,
      }
    }

    const messages = [
      ...contextMessages.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      { role: 'user' as const, content: userRequest },
    ]

    let iterations = 0
    let lastText = ''

    // ReAct loop for planning (只读探索)
    while (iterations < maxIterations) {
      iterations++

      // 使用 callWithRetry 包装整个流式消费过程
      const streamResult = await callWithRetry(async () => {
        const result = streamText({
          model,
          system: PLAN_SYSTEM_SUFFIX,
          messages: messages as Array<{ role: 'user' | 'assistant'; content: string }>,
          tools: toolsForAI,
          maxSteps: 1,
        })

        // 流式消费文本
        let streamedText = ''
        for await (const chunk of result.textStream) {
          streamedText += chunk
          onEvent({ type: 'llm_chunk', text: chunk })
        }

        // 流式结束后获取完整结果（含 toolCalls、usage）
        const finalResult = await result
        const usage = await finalResult.usage
        const toolCalls = await finalResult.toolCalls
        return { streamedText, usage, toolCalls }
      }, {
        onRetry: ({ attempt, delay, error }) => {
          onEvent({ type: 'error', message: `流式请求重试 #${attempt}（${delay}ms 后）: ${error.message}`, recoverable: true })
        },
      })

      const { streamedText, usage, toolCalls } = streamResult

      // 记录 token 用量到 CostTracker
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
        onEvent({
          type: 'cost_update',
          inputTokens: usage.promptTokens,
          outputTokens: usage.completionTokens,
          cost: this.config.costTracker.getTotalCost(),
        })
      }

      // 处理工具调用
      if (toolCalls && toolCalls.length > 0) {
        // 将 assistant 消息加入历史
        messages.push({ role: 'assistant', content: streamedText || '' } as never)

        let planSubmitted = false
        for (const toolCall of toolCalls) {
          const callId = `plan-${iterations}-${toolCall.toolName}`
          onEvent({
            type: 'tool_call',
            tool: toolCall.toolName,
            params: toolCall.args as Record<string, unknown>,
            callId,
          })

          const toolResult = await toolRegistry.execute(
            toolCall.toolName,
            toolCall.args as Record<string, unknown>,
            { ...toolContext, callId }
          )

          onEvent({
            type: 'tool_result',
            callId,
            tool: toolCall.toolName,
            result: toolResult.result,
            error: toolResult.error,
          })

          // 检测 submit_plan 工具调用
          if (toolCall.toolName === 'submit_plan' && !toolResult.error) {
            planSubmitted = true
          }

          // 将工具结果加入消息
          messages.push({
            role: 'user',
            content: `[工具结果 ${toolCall.toolName}]: ${toolResult.error ?? toolResult.result}`,
          } as never)
        }

        // submit_plan 已提交，结束规划循环
        if (planSubmitted) {
          const plan = consumePendingPlan()
          if (plan) {
            onEvent({ type: 'llm_done', text: `计划已提交: ${plan.summary}` })
            return plan
          }
        }
        continue
      }

      // 无工具调用，说明规划完成（兜底：LLM 未调用 submit_plan 而是输出文本）
      lastText = streamedText
      break
    }

    onEvent({ type: 'llm_done', text: lastText })

    // 优先检查是否有 submit_plan 提交的计划
    const submittedPlan = consumePendingPlan()
    if (submittedPlan) return submittedPlan

    // 兜底：从文本中解析 JSON 计划
    return this.parsePlan(lastText, userRequest)
  }

  /** 带用户反馈重规划 */
  async replan(
    userRequest: string,
    contextMessages: ChatMessage[],
    prevPlan: Plan,
    feedback: string,
  ): Promise<Plan> {
    const { model, toolRegistry, toolContext, maxIterations, onEvent } = this.config

    // 清除上一轮遗留的 pendingPlan
    setPendingPlan(null)

    onEvent({ type: 'llm_start', phase: 'plan' })
    onEvent({ type: 'system_info', message: `根据反馈重规划: ${feedback.slice(0, 80)}` })

    const planTools = toolRegistry.getForPhase('plan')
    const toolsForAI: Record<string, { description: string; parameters: unknown }> = {}
    for (const tool of planTools) {
      toolsForAI[tool.definition.name] = {
        description: tool.definition.description,
        parameters: toolSchemas[tool.definition.name] ?? tool.definition.inputSchema,
      }
    }

    // 注入上一版计划 + 用户反馈
    const messages = [
      ...contextMessages.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      { role: 'user' as const, content: userRequest },
      { role: 'assistant' as const, content: `上一版计划:\n\`\`\`json\n${JSON.stringify(prevPlan, null, 2)}\n\`\`\`` },
      {
        role: 'user' as const,
        content: `用户对计划的反馈：${feedback}\n\n请根据反馈调整计划。可以继续用工具探索代码，然后输出新的 JSON 计划。`,
      },
    ]

    let iterations = 0
    let lastText = ''

    while (iterations < maxIterations) {
      iterations++

      const streamResult = await callWithRetry(async () => {
        const result = streamText({
          model,
          system: PLAN_SYSTEM_SUFFIX,
          messages: messages as Array<{ role: 'user' | 'assistant'; content: string }>,
          tools: toolsForAI,
          maxSteps: 1,
        })

        let streamedText = ''
        for await (const chunk of result.textStream) {
          streamedText += chunk
          onEvent({ type: 'llm_chunk', text: chunk })
        }

        const finalResult = await result
        const usage = await finalResult.usage
        const toolCalls = await finalResult.toolCalls
        return { streamedText, usage, toolCalls }
      }, {
        onRetry: ({ attempt, delay, error }) => {
          onEvent({ type: 'error', message: `流式请求重试 #${attempt}（${delay}ms 后）: ${error.message}`, recoverable: true })
        },
      })

      const { streamedText, usage, toolCalls } = streamResult

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
        onEvent({
          type: 'cost_update',
          inputTokens: usage.promptTokens,
          outputTokens: usage.completionTokens,
          cost: this.config.costTracker.getTotalCost(),
        })
      }

      if (toolCalls && toolCalls.length > 0) {
        messages.push({ role: 'assistant', content: streamedText || '' } as never)

        let planSubmitted = false
        for (const toolCall of toolCalls) {
          const callId = `replan-${iterations}-${toolCall.toolName}`
          onEvent({
            type: 'tool_call',
            tool: toolCall.toolName,
            params: toolCall.args as Record<string, unknown>,
            callId,
          })

          const toolResult = await toolRegistry.execute(
            toolCall.toolName,
            toolCall.args as Record<string, unknown>,
            { ...toolContext, callId }
          )

          onEvent({
            type: 'tool_result',
            callId,
            tool: toolCall.toolName,
            result: toolResult.result,
            error: toolResult.error,
          })

          if (toolCall.toolName === 'submit_plan' && !toolResult.error) {
            planSubmitted = true
          }

          messages.push({
            role: 'user',
            content: `[工具结果 ${toolCall.toolName}]: ${toolResult.error ?? toolResult.result}`,
          } as never)
        }

        if (planSubmitted) {
          const plan = consumePendingPlan()
          if (plan) {
            onEvent({ type: 'llm_done', text: `重规划已提交: ${plan.summary}` })
            return plan
          }
        }
        continue
      }

      lastText = streamedText
      break
    }

    onEvent({ type: 'llm_done', text: lastText })
    const submittedPlan = consumePendingPlan()
    if (submittedPlan) return submittedPlan
    return this.parsePlan(lastText, userRequest)
  }

  /** 从 LLM 输出中解析结构化计划 */
  private parsePlan(text: string, userRequest: string): Plan {
    // 尝试从 JSON 代码块中提取
    const jsonMatch = text.match(/```json\s*\n([\s\S]*?)\n```/)
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]) as Plan
        if (parsed.todos && Array.isArray(parsed.todos)) {
          return {
            summary: parsed.summary ?? userRequest,
            todos: parsed.todos.map((t, i) => ({
              id: t.id ?? String(i + 1),
              content: t.content ?? `步骤 ${i + 1}`,
              status: 'pending' as const,
            })),
            filesToModify: parsed.filesToModify ?? [],
            estimatedSteps: parsed.todos.length,
          }
        }
      } catch {
        // JSON 解析失败,回退到简单计划
      }
    }

    // 回退:生成简单计划
    return {
      summary: userRequest,
      todos: [
        { id: '1', content: '分析需求并探索相关代码', status: 'pending' },
        { id: '2', content: '实施修改', status: 'pending' },
        { id: '3', content: '验证修改正确性', status: 'pending' },
      ],
      filesToModify: [],
      estimatedSteps: 3,
    }
  }
}

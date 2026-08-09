/**
 * Plan 阶段
 * 探索代码库 + 生成结构化计划,只用只读工具(read/grep)
 */

import type { LanguageModel } from 'ai'
import type { CostTracker } from '../router/CostTracker'
import type { ToolContext, ToolRegistry } from '../tools/registry'
import { resolveToolParameters } from '../tools/schemas'
import { consumePendingPlan, setPendingPlan } from '../tools/submitPlan'
import { callLLMWithRetry, type LLMCallConfig } from './ReActLoop'
import type { ChatMessage, ModelRole, NexusEvent, Plan } from './types'

/** Plan 阶段消息（与 ReActLoop 输入同构，支持原生 tool 消息） */
type PlanMessage = LLMCallConfig['messages'][number]

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

## todo 质量标准
- 每个 todo 必须对应一个明确的 edit_file 操作。例如:
  ✓ "修改 src/UserService.ts 的 createUser 方法，添加 email 格式验证"
  ✗ "重构用户模块"（太笼统，无法执行）
- 步骤按依赖排序：先创建/修改基础文件，再修改依赖它的文件
- 如果需求简单（如 "创建一个文件"），1-2 步即可；复杂需求 5-8 步

注意:
- 先理解再规划,不要凭空猜测文件内容
- 调用 submit_plan 后规划阶段结束,不需要额外输出文本

## 重要：必须调用 submit_plan

完成代码探索后，你必须调用 submit_plan 工具提交计划，这是规划阶段结束的唯一方式。
如果只输出文本而不调用工具，计划将被忽略，执行阶段将使用原始需求作为 todo 直接执行。`

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
  /** 缓存命中输入单价（每 1k），DeepSeek 分级计费用 */
  costPer1kInputCached?: number
  /**
   * Provider 特定的模型参数
   * 由 ProviderAdapter.getModelParameters() 生成，DeepSeek 等模型的调用参数优化用。
   * 为 undefined 时使用 SDK 默认值。
   */
  modelParameters?: Record<string, unknown>
  /**
   * 中断信号获取器（Orchestrator.abort() 时触发）。
   * 用懒获取而非静态 signal：replan 发生在新一轮 submit 中，
   * 静态 signal 会携带上一轮的已中止状态。
   */
  getAbortSignal?: () => AbortSignal | undefined
}

export class Planner {
  private config: PlannerConfig

  constructor(config: PlannerConfig) {
    this.config = config
  }

  /** 执行 Plan 阶段,返回结构化计划 */
  async plan(userRequest: string, contextMessages: ChatMessage[]): Promise<Plan> {
    const { onEvent } = this.config

    // 清除上一轮遗留的 pendingPlan，防止跨调用状态泄漏
    setPendingPlan(null)

    onEvent({ type: 'llm_start', phase: 'plan' })

    const messages: PlanMessage[] = [
      ...contextMessages.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      { role: 'user', content: userRequest },
    ]

    const { lastText, submittedPlan } = await this.runExploreLoop(messages, 'plan')
    if (submittedPlan) {
      onEvent({ type: 'system_info', message: `计划已提交: ${submittedPlan.summary}` })
      return submittedPlan
    }

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
    const { onEvent } = this.config

    // 清除上一轮遗留的 pendingPlan
    setPendingPlan(null)

    onEvent({ type: 'llm_start', phase: 'plan' })
    onEvent({ type: 'system_info', message: `根据反馈重规划: ${feedback.slice(0, 80)}` })

    // 注入上一版计划 + 用户反馈
    const messages: PlanMessage[] = [
      ...contextMessages.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      { role: 'user', content: userRequest },
      {
        role: 'assistant',
        content: `上一版计划:\n\`\`\`json\n${JSON.stringify(prevPlan, null, 2)}\n\`\`\``,
      },
      {
        role: 'user',
        content: `用户对计划的反馈：${feedback}\n\n请根据反馈调整计划。可以继续用工具探索代码，然后输出新的 JSON 计划。`,
      },
    ]

    const { lastText, submittedPlan } = await this.runExploreLoop(messages, 'replan')
    if (submittedPlan) {
      onEvent({ type: 'system_info', message: `重规划已提交: ${submittedPlan.summary}` })
      return submittedPlan
    }

    return this.parsePlan(lastText, userRequest)
  }

  /** Plan 阶段只读工具集 → LLM 工具描述表 */
  private buildPlanTools(): Record<string, { description: string; parameters: unknown }> {
    const toolsForAI: Record<string, { description: string; parameters: unknown }> = {}
    for (const tool of this.config.toolRegistry.getForPhase('plan')) {
      toolsForAI[tool.definition.name] = {
        description: tool.definition.description,
        parameters: resolveToolParameters(tool.definition.name, tool.definition.inputSchema),
      }
    }
    return toolsForAI
  }

  /**
   * plan/replan 共用的只读探索循环。
   * 工具结果以 AI SDK 原生 tool 消息回传（与 Executor 一致），
   * 避免以 user 角色文本注入导致模型丢失自身工具调用结构。
   */
  private async runExploreLoop(
    messages: PlanMessage[],
    callIdPrefix: string,
  ): Promise<{ lastText: string; submittedPlan: Plan | null }> {
    const { model, toolRegistry, toolContext, maxIterations, onEvent } = this.config
    const toolsForAI = this.buildPlanTools()

    let iterations = 0
    let lastText = ''

    while (iterations < maxIterations) {
      // 中断检查：用户 Ctrl+C 后不再发起新一轮 LLM 调用
      if (this.config.getAbortSignal?.()?.aborted) break
      iterations++

      // 使用共享的 LLM 调用工具（统一 streamText + 重试 + 成本记录）
      const { streamedText, toolCalls } = await callLLMWithRetry(
        {
          model,
          system: PLAN_SYSTEM_SUFFIX,
          messages,
          tools: toolsForAI,
          maxSteps: 1,
          modelParameters: this.config.modelParameters,
          abortSignal: this.config.getAbortSignal?.(),
        },
        {
          onEvent,
          costConfig: {
            costTracker: this.config.costTracker,
            modelRole: this.config.modelRole,
            providerName: this.config.providerName,
            modelName: this.config.modelName,
            costPer1kInput: this.config.costPer1kInput,
            costPer1kOutput: this.config.costPer1kOutput,
            costPer1kInputCached: this.config.costPer1kInputCached,
          },
          abortSignal: this.config.getAbortSignal?.(),
        },
      )

      // 无工具调用 → 探索结束（兜底：LLM 未调用 submit_plan 而是输出文本）
      if (!toolCalls || toolCalls.length === 0) {
        lastText = streamedText
        break
      }

      // assistant 消息携带工具调用（normalizeMessagesForSDK 会转为 content 部件）
      // callId 带索引：同一迭代内多个同名工具调用不会冲突（React key 唯一性）
      messages.push({
        role: 'assistant',
        content: streamedText || '',
        toolCalls: toolCalls.map((tc, idx) => ({
          toolCallId: `${callIdPrefix}-${iterations}-${tc.toolName}-${idx}`,
          toolName: tc.toolName,
          args: tc.args as Record<string, unknown>,
        })),
      })

      let planSubmitted = false
      const toolResults: Array<{
        type: 'tool-result'
        toolCallId: string
        toolName: string
        result: string
      }> = []

      for (const [toolIndex, toolCall] of toolCalls.entries()) {
        const callId = `${callIdPrefix}-${iterations}-${toolCall.toolName}-${toolIndex}`
        onEvent({
          type: 'tool_call',
          tool: toolCall.toolName,
          params: toolCall.args as Record<string, unknown>,
          callId,
        })

        const toolResult = await toolRegistry.execute(
          toolCall.toolName,
          toolCall.args as Record<string, unknown>,
          { ...toolContext, callId },
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

        toolResults.push({
          type: 'tool-result',
          toolCallId: callId,
          toolName: toolCall.toolName,
          result: toolResult.error ? `[错误] ${toolResult.error}` : toolResult.result,
        })
      }

      // 工具结果统一以一条 tool 消息回传（AI SDK 原生格式）
      messages.push({ role: 'tool', content: toolResults })

      // submit_plan 已提交，结束规划循环
      if (planSubmitted) {
        const plan = consumePendingPlan()
        if (plan) return { lastText: '', submittedPlan: plan }
      }
    }

    // 循环结束后的安全兜底：中断等边界情况下 pendingPlan 可能已提交但未消费
    const pending = consumePendingPlan()
    return { lastText, submittedPlan: pending }
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

    // 兜底：plan 阶段未能产出结构化计划（LLM 未调用 submit_plan 也未输出 JSON）
    // 返回单步骤计划，以用户原始需求为 todo，由 Executor 自主拆解
    return {
      summary: userRequest,
      todos: [{ id: '1', content: userRequest, status: 'pending' }],
      filesToModify: [],
      estimatedSteps: 0,
    }
  }
}

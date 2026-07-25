/**
 * ReAct 循环共享工具
 * 封装 Planner 和 Executor 共用的 streamText + 重试 + 成本记录逻辑。
 * 消除 ~50 行在每个文件中的重复代码。
 */

import { streamText } from 'ai'
import type { LanguageModel } from 'ai'
import type { NexusEvent, ModelRole } from './types'
import { callWithRetry } from '../utils'
import { logLLMRequest, logLLMResponse } from '../utils/debugLog'
import type { CostTracker } from '../router/CostTracker'

export interface LLMCallConfig {
  model: LanguageModel
  system: string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  tools: Record<string, { description: string; parameters: unknown }>
  maxSteps: number
  abortSignal?: AbortSignal
}

export interface LLMCallResult {
  streamedText: string
  usage?: { promptTokens: number; completionTokens: number }
  toolCalls: Array<{ toolName: string; args: Record<string, unknown> }>
}

export interface CostRecordConfig {
  costTracker: CostTracker
  modelRole: ModelRole
  providerName: string
  modelName: string
  costPer1kInput: number
  costPer1kOutput: number
}

export interface ReActCallbacks {
  /** 每次 LLM 调用后触发（用于流式文本、工具调用、结果等事件） */
  onEvent: (event: NexusEvent) => void
  /** 成本记录配置 */
  costConfig: CostRecordConfig
  /** 中止信号 */
  abortSignal?: AbortSignal
}

/**
 * 调用 LLM 并处理流式消费、重试、成本记录。
 * 返回 { streamedText, toolCalls }。
 *
 * Planner 用法：
 *   const result = await callLLMWithRetry({ model, system, messages, tools, maxSteps: 1, abortSignal }, callbacks)
 *
 * Executor 用法（带降级模型）：
 *   const result = await callLLMWithRetry(config, callbacks, fallbackModel)
 */
export async function callLLMWithRetry(
  config: LLMCallConfig,
  callbacks: ReActCallbacks,
  fallbackModel?: LanguageModel,
): Promise<LLMCallResult> {
  const { model, system, messages, tools, maxSteps, abortSignal } = config
  const { onEvent, costConfig } = callbacks

  const doCall = (m: LanguageModel) =>
    callWithRetry(async () => {
      // 调试日志：记录 LLM 请求
      logLLMRequest(m, system, messages, tools).catch(() => {})

      const result = streamText({
        model: m,
        system,
        messages,
        tools,
        maxSteps,
        abortSignal,
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
      const rawToolCalls = await finalResult.toolCalls
      return { streamedText, usage, toolCalls: rawToolCalls ?? [] }
    }, {
      onRetry: ({ attempt, delay, error }) => {
        onEvent({
          type: 'error',
          message: `流式请求重试 #${attempt}（${delay}ms 后）: ${error.message}`,
          recoverable: true,
        })
      },
    })

  // 主模型调用
  let result: { streamedText: string; usage?: { promptTokens: number; completionTokens: number }; toolCalls: unknown[] }
  try {
    result = await doCall(model)
  } catch (primaryError) {
    // 降级到备用模型（如果提供）
    if (fallbackModel) {
      onEvent({
        type: 'error',
        message: `主模型不可用 (${(primaryError as Error).message})，降级到备用模型`,
        recoverable: true,
      })
      try {
        result = await doCall(fallbackModel)
      } catch (fallbackError) {
        throw new Error(
          `LLM 调用失败：主模型和备用模型均不可用。\n主模型错误: ${(primaryError as Error).message}\n备用模型错误: ${(fallbackError as Error).message}`
        )
      }
    } else {
      throw primaryError
    }
  }

  const { streamedText, usage } = result
  const toolCalls = (result.toolCalls ?? []) as Array<{
    toolName: string
    args: Record<string, unknown>
  }>

  // 调试日志：记录 LLM 响应
  logLLMResponse(streamedText, toolCalls, usage).catch(() => {})

  // 记录 token 用量
  if (usage) {
    costConfig.costTracker.record({
      role: costConfig.modelRole,
      provider: costConfig.providerName,
      model: costConfig.modelName,
      inputTokens: usage.promptTokens,
      outputTokens: usage.completionTokens,
      costPer1kInput: costConfig.costPer1kInput,
      costPer1kOutput: costConfig.costPer1kOutput,
    })
    onEvent({
      type: 'cost_update',
      inputTokens: usage.promptTokens,
      outputTokens: usage.completionTokens,
      cost: costConfig.costTracker.getTotalCost(),
    })
  }

  return { streamedText, usage, toolCalls }
}

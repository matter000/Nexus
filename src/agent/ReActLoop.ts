/**
 * ReAct 循环共享工具
 * 封装 Planner 和 Executor 共用的 streamText + 重试 + 成本记录 + 推理内容事件逻辑。
 * 消除 ~50 行在每个文件中的重复代码。
 *
 * DeepSeek 深度适配（v4 系列）:
 * - 思考模式默认启用（thinking: enabled），reasoning_content 通过 result.reasoning 获取
 * - reasoningEffort 经 providerOptions.openai 传递（SDK 映射为请求体 reasoning_effort）
 * - thinking 参数无 SDK 映射，经 AsyncLocalStorage + DeepSeek fetch 拦截器注入请求体
 * - 思考模式 reasoning_content 契约错误（422）自动关闭思考模式重试
 * - 缓存命中统计通过 providerMetadata.openai.cachedPromptTokens 获取
 * - 推理 token 统计通过 providerMetadata.openai.reasoningTokens 获取
 * - stream_options.include_usage 开启以获取流式模式下的准确用量
 * - 客户端令牌桶限流（globalRateLimiter）防止并发请求触发 429
 * - 429 重试尊重服务端 Retry-After 响应头
 */

import { APICallError, type LanguageModel, streamText } from 'ai'
import type { CostTracker } from '../router/CostTracker'
import { parseDeepSeekError } from '../router/providers/deepseekErrors'
import { withDeepSeekThinking } from '../router/providers/deepseekFetch'
import { globalRateLimiter } from '../router/RateLimiter'
import { callWithRetry } from '../utils'
import { logLLMRequest, logLLMResponse } from '../utils/debugLog'
import type { ModelRole, NexusEvent } from './types'

/** streamText 已知的顶层参数键，其余键收进 providerOptions.openai 透传 */
const KNOWN_TOP_LEVEL_PARAMS = new Set(['temperature', 'topP', 'maxTokens'])

/**
 * 拆分 provider 模型参数：
 * - temperature/topP/maxTokens 为 AI SDK streamText 的合法顶层参数
 * - thinking 单独提取：@ai-sdk/openai 无此映射，由 DeepSeek fetch 拦截器
 *   （配合 AsyncLocalStorage）注入请求体
 * - 其余键（reasoningEffort 等）收入 providerOptions.openai，由 SDK 做固定映射
 *   （顶层注入未知键会被 SDK 静默丢弃）
 */
export function splitModelParameters(modelParameters?: Record<string, unknown>): {
  topLevel: Record<string, unknown>
  providerOptions: Record<string, Record<string, unknown>> | undefined
  thinking?: unknown
} {
  const topLevel: Record<string, unknown> = {}
  const openaiExtras: Record<string, unknown> = {}
  let thinking: unknown
  for (const [key, value] of Object.entries(modelParameters ?? {})) {
    if (key === 'thinking') {
      thinking = value
    } else if (KNOWN_TOP_LEVEL_PARAMS.has(key)) {
      topLevel[key] = value
    } else {
      openaiExtras[key] = value
    }
  }
  return {
    topLevel,
    providerOptions: Object.keys(openaiExtras).length > 0 ? { openai: openaiExtras } : undefined,
    thinking,
  }
}

/** 解析 Retry-After 响应头计算退避延迟（429/503 场景） */
function getRetryAfterDelay(error: Error): number | undefined {
  if (!APICallError.isInstance(error) || !error.responseHeaders) return undefined
  const headers = error.responseHeaders as Record<string, string | undefined>
  const header = headers['retry-after'] ?? headers['Retry-After']
  if (!header) return undefined
  // 秒数格式
  const seconds = Number.parseFloat(header)
  if (!Number.isNaN(seconds) && seconds >= 0) return Math.min(Math.ceil(seconds * 1000), 60_000)
  // HTTP 日期格式
  const date = Date.parse(header)
  if (!Number.isNaN(date)) return Math.max(0, Math.min(date - Date.now(), 60_000))
  return undefined
}

export interface LLMCallConfig {
  model: LanguageModel
  system: string
  messages: Array<
    | { role: 'user' | 'assistant'; content: string; reasoning?: string }
    | {
        role: 'assistant'
        content: string
        reasoning?: string
        toolCalls: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>
      }
    | {
        role: 'tool'
        content: Array<{
          type: 'tool-result'
          toolCallId: string
          toolName: string
          result: string
        }>
      }
  >
  tools: Record<string, { description: string; parameters: unknown }>
  maxSteps: number
  abortSignal?: AbortSignal
  /**
   * Provider 特定的模型参数（temperature, topP, maxTokens 等）
   * 由 ProviderAdapter.getModelParameters() 生成，DeepSeek 深度适配使用。
   * 为 undefined 时使用 SDK 默认值。
   */
  modelParameters?: Record<string, unknown>
}

export interface LLMCallResult {
  streamedText: string
  usage?: { promptTokens: number; completionTokens: number }
  toolCalls: Array<{ toolName: string; args: Record<string, unknown> }>
  /** 推理内容（思维链），DeepSeek 思考模式下返回 */
  reasoning?: string
  /** 缓存命中的 prompt token 数 */
  cacheHitTokens?: number
  /** 缓存未命中的 prompt token 数 */
  cacheMissTokens?: number
  /** 推理 token 数 */
  reasoningTokens?: number
}

export interface CostRecordConfig {
  costTracker: CostTracker
  modelRole: ModelRole
  providerName: string
  modelName: string
  costPer1kInput: number
  costPer1kOutput: number
  /** 缓存命中输入单价（每 1k），DeepSeek 分级计费用 */
  costPer1kInputCached?: number
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
  const { model, system, messages, tools, maxSteps, abortSignal, modelParameters } = config
  const { onEvent, costConfig } = callbacks

  /**
   * @param thinkingOverride 422 自愈时传入 { type: 'disabled' }，
   *   覆盖 modelParameters 中的 thinking 值，并剔除失效的 reasoningEffort
   */
  const doCall = (m: LanguageModel, thinkingOverride?: unknown) =>
    callWithRetry(
      async () => {
        // 客户端限流：防止并发请求（含子 Agent）触发 429
        const estimatedTokens =
          Math.ceil((system.length + messages.reduce((s, msg) => s + msg.content.length, 0)) / 4) +
          2000
        await globalRateLimiter.acquire(costConfig.modelName, estimatedTokens)

        // 调试日志：记录 LLM 请求
        logLLMRequest(m, system, messages, tools).catch(() => {})

        // 拆分 provider 参数：顶层合法键 + providerOptions.openai 映射键 + thinking
        const { topLevel, providerOptions, thinking } = splitModelParameters(modelParameters)
        // 自愈覆盖优先；undefined 表示不注入（用 API 默认思考模式）
        const effectiveThinking = thinkingOverride ?? thinking
        let mergedProviderOptions = providerOptions
        if (thinkingOverride) {
          const openai: Record<string, unknown> = { ...(providerOptions?.openai ?? {}) }
          // 关闭思考模式后推理深度控制不再适用，避免额外报错
          delete openai.reasoningEffort
          mergedProviderOptions = Object.keys(openai).length > 0 ? { openai } : undefined
        }

        // 构建 streamText 参数：合并 provider 特定参数
        const streamOptions: Record<string, unknown> = {
          model: m,
          system,
          messages,
          tools,
          maxSteps,
          abortSignal,
          // 启用流式用量统计，确保在流式结束前获取完整 usage（含缓存命中/推理 token）
          streamOptions: { include_usage: true },
          ...topLevel,
        }
        if (mergedProviderOptions) {
          streamOptions.providerOptions = mergedProviderOptions
        }

        // 用 ALS 携带 thinking 参数包裹整个调用（含流式消费触发的延迟 fetch），
        // DeepSeek fetch 拦截器会将 thinking 注入请求体
        return withDeepSeekThinking(effectiveThinking, async () => {
          const result = streamText(streamOptions as Parameters<typeof streamText>[0])

          // 流式消费文本
          let streamedText = ''
          for await (const chunk of result.textStream) {
            streamedText += chunk
            onEvent({ type: 'llm_chunk', text: chunk })
          }

          // 流式结束后获取完整结果（含 toolCalls、usage、reasoning、providerMetadata）
          const finalResult = await result
          const usage = await finalResult.usage
          const rawToolCalls = await finalResult.toolCalls
          const reasoning = await finalResult.reasoning

          // 提取 provider 元数据中的缓存/推理 token 统计（DeepSeek v4 支持）
          // providerMetadata.openai.cachedPromptTokens 来自 prompt_tokens_details.cached_tokens
          // providerMetadata.openai.reasoningTokens 来自 completion_tokens_details.reasoning_tokens
          // DeepSeek API 还返回 prompt_cache_miss_tokens，但 OpenAI 格式不直接映射，
          // 我们通过 usage.promptTokens - cacheHitTokens 计算得出。
          let cacheHitTokens: number | undefined
          let cacheMissTokens: number | undefined
          let reasoningTokens: number | undefined
          try {
            const providerMetadata = await finalResult.providerMetadata
            if (providerMetadata?.openai) {
              const openaiMeta = providerMetadata.openai as Record<string, unknown>
              if (typeof openaiMeta.cachedPromptTokens === 'number') {
                cacheHitTokens = openaiMeta.cachedPromptTokens as number
              }
              if (typeof openaiMeta.reasoningTokens === 'number') {
                reasoningTokens = openaiMeta.reasoningTokens as number
              }
            }
          } catch {
            // providerMetadata 可能不可用，忽略
          }
          // 根据 usage 计算 cacheMissTokens（prompt_tokens = cache_hit + cache_miss）
          if (cacheHitTokens !== undefined && usage) {
            const miss = usage.promptTokens - cacheHitTokens
            cacheMissTokens = miss >= 0 ? miss : 0
          }

          // 发射推理内容事件（DeepSeek 思考模式下可用）
          if (reasoning) {
            onEvent({ type: 'llm_reasoning', text: reasoning })
          }

          return {
            streamedText,
            usage,
            toolCalls: rawToolCalls ?? [],
            reasoning,
            cacheHitTokens,
            cacheMissTokens,
            reasoningTokens,
          }
        })
      },
      {
        // 429/503 尊重服务端 Retry-After 响应头，无则回退指数退避
        getDelay: (error) => getRetryAfterDelay(error),
        onRetry: ({ attempt, delay, error }) => {
          onEvent({
            type: 'error',
            message: `流式请求重试 #${attempt}（${delay}ms 后）: ${error.message}`,
            recoverable: true,
          })
        },
      },
    )

  // 主模型调用
  let result: {
    streamedText: string
    usage?: { promptTokens: number; completionTokens: number }
    toolCalls: unknown[]
    reasoning?: string
    cacheHitTokens?: number
    cacheMissTokens?: number
    reasoningTokens?: number
  }
  try {
    result = await doCall(model)
  } catch (primaryError) {
    // DeepSeek 422 自愈：思考模式 reasoning_content 契约错误 → 关闭思考模式重试一次
    const parsed = parseDeepSeekError(primaryError as Error, costConfig.modelName)
    if (parsed.disableThinking) {
      onEvent({
        type: 'error',
        message: `${parsed.message}，自动关闭思考模式重试`,
        recoverable: true,
      })
      try {
        result = await doCall(model, { type: 'disabled' })
      } catch (retryError) {
        throw new Error(
          `LLM 调用失败：思考模式自愈重试仍失败。\n原错误: ${(primaryError as Error).message}\n重试错误: ${(retryError as Error).message}`,
        )
      }
    } else if (fallbackModel) {
      // 降级到备用模型（如果提供）
      onEvent({
        type: 'error',
        message: `主模型不可用 (${(primaryError as Error).message})，降级到备用模型`,
        recoverable: true,
      })
      try {
        result = await doCall(fallbackModel)
      } catch (fallbackError) {
        throw new Error(
          `LLM 调用失败：主模型和备用模型均不可用。\n主模型错误: ${(primaryError as Error).message}\n备用模型错误: ${(fallbackError as Error).message}`,
        )
      }
    } else {
      throw primaryError
    }
  }

  const { streamedText, usage, reasoning, cacheHitTokens, cacheMissTokens, reasoningTokens } =
    result
  const toolCalls = (result.toolCalls ?? []) as Array<{
    toolName: string
    args: Record<string, unknown>
  }>

  // 调试日志：记录 LLM 响应
  logLLMResponse(streamedText, toolCalls, usage).catch(() => {})

  // 记录 token 用量（含 DeepSeek 缓存命中/推理 token 统计）
  if (usage) {
    costConfig.costTracker.record({
      role: costConfig.modelRole,
      provider: costConfig.providerName,
      model: costConfig.modelName,
      inputTokens: usage.promptTokens,
      outputTokens: usage.completionTokens,
      costPer1kInput: costConfig.costPer1kInput,
      costPer1kOutput: costConfig.costPer1kOutput,
      costPer1kInputCached: costConfig.costPer1kInputCached,
      cacheHitTokens,
      cacheMissTokens,
      reasoningTokens,
    })
    onEvent({
      type: 'cost_update',
      inputTokens: usage.promptTokens,
      outputTokens: usage.completionTokens,
      cost: costConfig.costTracker.getTotalCost(),
    })
  }

  return {
    streamedText,
    usage,
    toolCalls,
    reasoning,
    cacheHitTokens,
    cacheMissTokens,
    reasoningTokens,
  }
}

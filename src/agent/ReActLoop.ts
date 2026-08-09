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

import { APICallError, type LanguageModel, stepCountIs, streamText } from 'ai'
import type { CostTracker } from '../router/CostTracker'
import { parseDeepSeekError } from '../router/providers/deepseekErrors'
import { withDeepSeekThinking } from '../router/providers/deepseekFetch'
import { globalRateLimiter } from '../router/RateLimiter'
import { callWithRetry } from '../utils'
import { logLLMRequest, logLLMResponse } from '../utils/debugLog'
import type { ModelRole, NexusEvent } from './types'

/** streamText 已知的顶层参数键，其余键收进 providerOptions.openai 透传（v6: maxTokens 已改名 maxOutputTokens） */
const KNOWN_TOP_LEVEL_PARAMS = new Set(['temperature', 'topP', 'maxOutputTokens'])

/** 流停滞看门狗：连续无 chunk 超过该时长判定为连接挂起，中止并交由重试兜底 */
const STREAM_STALL_TIMEOUT_MS =
  Number.parseInt(process.env.NEXUS_STALL_TIMEOUT_MS ?? '', 10) || 90_000
/** 单次 LLM 调用总超时（含建连+生成），防止服务端静默挂起导致 Agent 永久卡死 */
const LLM_CALL_TIMEOUT_MS = Number.parseInt(process.env.NEXUS_LLM_TIMEOUT_MS ?? '', 10) || 600_000
/**
 * 流结束后 await usage/toolCalls 等的保护超时。
 * 背景: @ai-sdk 对非流式错误响应（如 401）会静默吞错，textStream 空结束且
 * result 正常 resolve，但 result.usage 等 Promise 永远不 settle。
 * 独立脚本中事件循环空了进程直接退出，TUI 中则永久挂起。超时后降级为 undefined。
 */
const POST_STREAM_AWAIT_TIMEOUT_MS = 10_000

/** 超时保护版 await：超时返回 undefined 而非永久挂起 */
async function awaitWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 规范化消息为 AI SDK v4 输入格式。
 * 内部历史用顶层 toolCalls 字段记录助手工具调用（streamText 返回值形状），
 * 但 SDK 输入要求 tool-call 位于 content 部件数组中——否则发出的 assistant
 * 消息不含 tool_calls，后续的 tool 消息会被 DeepSeek 以 400 拒绝
 * （“Messages with role 'tool' must be a response to a preceding message with 'tool_calls'”）。
 *
 * @param options.anthropicCacheBreakpoint 为 true 时给第一条 system 消息附
 *   providerOptions.anthropic.cacheControl（Anthropic 显式前缀缓存断点，
 *   API 已按 AI SDK v4 官方文档验证：stable 段按缓存读取价计费）
 */
export function normalizeMessagesForSDK(
  messages: LLMCallConfig['messages'],
  options?: { anthropicCacheBreakpoint?: boolean },
): unknown[] {
  let cacheAttached = false
  return messages.map((m) => {
    const withCalls = m as {
      role: string
      content?: string
      reasoning?: string
      toolCalls?: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>
    }
    // Anthropic 缓存断点：附在第一条 system 消息（stable 段）上，
    // 断点前的前缀（system 参数 + stable）跨轮命中缓存
    if (
      options?.anthropicCacheBreakpoint &&
      !cacheAttached &&
      withCalls.role === 'system' &&
      typeof withCalls.content === 'string'
    ) {
      cacheAttached = true
      return {
        role: 'system',
        content: withCalls.content,
        providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
      }
    }
    if (withCalls.role === 'assistant' && Array.isArray(withCalls.toolCalls)) {
      return {
        role: 'assistant',
        content: [
          ...(withCalls.content ? [{ type: 'text', text: withCalls.content }] : []),
          ...(withCalls.reasoning ? [{ type: 'reasoning', text: withCalls.reasoning }] : []),
          ...withCalls.toolCalls.map((tc) => ({
            type: 'tool-call',
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            input: tc.args,
          })),
        ],
      }
    }
    // tool 消息：v6 部件字段 result → output（判别联合 {type:'text'|'json', value}）
    if (withCalls.role === 'tool' && Array.isArray(withCalls.content)) {
      return {
        role: 'tool',
        content: (withCalls.content as unknown as Array<Record<string, unknown>>).map((part) => ({
          type: 'tool-result',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          // v6 要求 output 为判别联合：字符串结果走 text，非字符串走 json
          output:
            typeof part.result === 'string'
              ? { type: 'text', value: part.result }
              : { type: 'json', value: part.result },
        })),
      }
    }
    return m
  })
}

/**
 * 组合外部中断信号（用户 Ctrl+C）与调用级超时信号。
 * 超时/停滞触发的 AbortError 消息带有明确关键词，isRetryable 会将其识别为可重试。
 */
function createTimeoutSignal(outer?: AbortSignal): {
  controller: AbortController
  signal: AbortSignal
  dispose: () => void
} {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new Error(`LLM 请求超时（${Math.round(LLM_CALL_TIMEOUT_MS / 1000)}s 未完成）`))
  }, LLM_CALL_TIMEOUT_MS)
  const onOuterAbort = () => controller.abort(outer?.reason)
  outer?.addEventListener('abort', onOuterAbort, { once: true })
  if (outer?.aborted) controller.abort(outer.reason)
  return {
    controller,
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      outer?.removeEventListener('abort', onOuterAbort)
    },
  }
}

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
    } else if (key === 'maxTokens') {
      // v6: 旧键名 maxTokens 映射为顶层 maxOutputTokens（provider 层无需改键）
      topLevel.maxOutputTokens = value
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
  /** 模型上下文窗口大小（token），随 cost_update 事件上报供利用率观测 */
  contextWindow?: number
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
        // Anthropic 前缀缓存：provider 为 anthropic 时给第一条 system 消息（stable 段）
        // 附 cacheControl 断点；DeepSeek/OpenAI 为自动前缀缓存，无需显式标记
        const anthropicCache = costConfig.providerName === 'anthropic'
        // v6: 工具定义字段 parameters → inputSchema（resolveToolParameters 已统一 zod/jsonSchema 包装）
        const toolsForSDK: Record<string, unknown> = {}
        for (const [name, t] of Object.entries(tools)) {
          toolsForSDK[name] = { description: t.description, inputSchema: t.parameters }
        }
        const streamOptions: Record<string, unknown> = {
          model: m,
          system,
          messages: normalizeMessagesForSDK(messages, { anthropicCacheBreakpoint: anthropicCache }),
          tools: toolsForSDK,
          // v6: maxSteps 移除，改用 stopWhen: stepCountIs(n)（单步循环仍由外层审批/checkpoint 控制）
          stopWhen: stepCountIs(Math.max(1, maxSteps)),
          abortSignal,
          ...topLevel,
        }
        if (mergedProviderOptions) {
          streamOptions.providerOptions = mergedProviderOptions
        }

        // 用 ALS 携带 thinking 参数包裹整个调用（含流式消费触发的延迟 fetch），
        // DeepSeek fetch 拦截器会将 thinking 注入请求体
        return withDeepSeekThinking(effectiveThinking, async () => {
          // 组合用户中断信号 + 调用总超时，防止任一方缺失时永久挂起
          const {
            controller: callController,
            signal: callSignal,
            dispose: disposeSignal,
          } = createTimeoutSignal(abortSignal)

          // 流停滞看门狗：连接建立后服务端不再发送任何数据（半开连接/代理静默丢弃）
          // 时，for-await 会无限等待。每收到一个 chunk 重置计时；到期 abort 触发重试。
          let stallTimer: ReturnType<typeof setTimeout> | undefined
          const armStallWatchdog = () => {
            if (stallTimer) clearTimeout(stallTimer)
            stallTimer = setTimeout(() => {
              callController.abort(
                new Error(
                  `LLM 流停滞超过 ${Math.round(STREAM_STALL_TIMEOUT_MS / 1000)}s 无任何响应，连接可能已挂起`,
                ),
              )
            }, STREAM_STALL_TIMEOUT_MS)
          }
          // 首个 chunk 之前即启用看门狗（覆盖建连+首 token 全程静默挂起的场景）
          armStallWatchdog()

          try {
            const result = streamText({
              ...(streamOptions as Parameters<typeof streamText>[0]),
              abortSignal: callSignal,
            })

            // 流式消费文本
            let streamedText = ''
            for await (const chunk of result.textStream) {
              streamedText += chunk
              armStallWatchdog()
              onEvent({ type: 'llm_chunk', text: chunk })
            }

            // 流式结束后获取完整结果（含 toolCalls、usage、reasoning、providerMetadata）
            // 注意: 每个 await 都带超时保护——SDK 在吞掉非流式错误后这些 Promise 可能永不 settle。
            // 并发等待共享单个超时预算（串行会叠加成 3 倍等待）；v6 返回 PromiseLike，Promise.resolve 包装
            const finalResult = await result
            const [usage, rawToolCalls, reasoning] = await Promise.all([
              awaitWithTimeout(Promise.resolve(finalResult.usage), POST_STREAM_AWAIT_TIMEOUT_MS),
              awaitWithTimeout(
                Promise.resolve(finalResult.toolCalls),
                POST_STREAM_AWAIT_TIMEOUT_MS,
              ),
              awaitWithTimeout(
                Promise.resolve(finalResult.reasoning),
                POST_STREAM_AWAIT_TIMEOUT_MS,
              ),
            ])
            // v6 字段映射：usage inputTokens/outputTokens → 内部 promptTokens/completionTokens；
            // toolCall args → input；reasoning ReasoningOutput[] → 拼接文本（保持下游形状不变）
            const mappedUsage = usage
              ? {
                  promptTokens: (usage as { inputTokens?: number }).inputTokens ?? 0,
                  completionTokens: (usage as { outputTokens?: number }).outputTokens ?? 0,
                }
              : undefined
            const toolCallList = (rawToolCalls ?? []).map((tc) => ({
              toolName: (tc as { toolName: string }).toolName,
              args: ((tc as { input?: Record<string, unknown> }).input ?? {}) as Record<
                string,
                unknown
              >,
            }))
            const reasoningText = Array.isArray(reasoning)
              ? (reasoning as Array<{ text?: string }>)
                  .map((p) => (typeof p.text === 'string' ? p.text : ''))
                  .join('') || undefined
              : undefined

            // 空响应检测: 无文本 + 无工具调用 + 无用量 = 请求实际失败或被服务端静默挂起
            // （典型: 认证失败/服务端瞬时停滞）。抛错激活重试/降级/报错链路。
            if (!streamedText && toolCallList.length === 0 && mappedUsage === undefined) {
              throw new Error(
                'LLM 返回空响应且无用量信息（通常为认证失败或服务端瞬时停滞），请通过 /config 检查 API Key 配置',
              )
            }

            // 提取 provider 元数据中的缓存/推理 token 统计（DeepSeek v4 / Anthropic 支持）
            // providerMetadata.openai.cachedPromptTokens 来自 prompt_tokens_details.cached_tokens
            // providerMetadata.openai.reasoningTokens 来自 completion_tokens_details.reasoning_tokens
            // providerMetadata.anthropic.cacheReadInputTokens 来自 Anthropic 缓存读取 token
            // DeepSeek API 还返回 prompt_cache_miss_tokens，但 OpenAI 格式不直接映射，
            // 我们通过 usage.promptTokens - cacheHitTokens 计算得出。
            let cacheHitTokens: number | undefined
            let cacheMissTokens: number | undefined
            let reasoningTokens: number | undefined
            try {
              const providerMetadata = await awaitWithTimeout(
                Promise.resolve(finalResult.providerMetadata),
                POST_STREAM_AWAIT_TIMEOUT_MS,
              )
              if (providerMetadata?.openai) {
                const openaiMeta = providerMetadata.openai as Record<string, unknown>
                if (typeof openaiMeta.cachedPromptTokens === 'number') {
                  cacheHitTokens = openaiMeta.cachedPromptTokens as number
                }
                if (typeof openaiMeta.reasoningTokens === 'number') {
                  reasoningTokens = openaiMeta.reasoningTokens as number
                }
              }
              if (providerMetadata?.anthropic) {
                const anthropicMeta = providerMetadata.anthropic as Record<string, unknown>
                if (typeof anthropicMeta.cacheReadInputTokens === 'number') {
                  cacheHitTokens = anthropicMeta.cacheReadInputTokens as number
                }
                // cacheCreationInputTokens（写入，1.25x 计费）不单独建模：
                // 其 token 计入 cacheMissTokens 按标准输入价结算，轻微高估可接受
              }
            } catch {
              // providerMetadata 可能不可用，忽略
            }
            // 根据 usage 计算 cacheMissTokens（prompt_tokens = cache_hit + cache_miss）
            if (cacheHitTokens !== undefined && mappedUsage) {
              const miss = mappedUsage.promptTokens - cacheHitTokens
              cacheMissTokens = miss >= 0 ? miss : 0
            }
            // v6 usage 自带 reasoningTokens 时作为兜底（providerMetadata 未提供时）
            if (reasoningTokens === undefined) {
              const rt = (usage as { reasoningTokens?: number } | undefined)?.reasoningTokens
              if (typeof rt === 'number') reasoningTokens = rt
            }

            // 发射推理内容事件（DeepSeek 思考模式下可用）
            if (reasoningText) {
              onEvent({ type: 'llm_reasoning', text: reasoningText })
            }

            return {
              streamedText,
              usage: mappedUsage,
              toolCalls: toolCallList,
              reasoning: reasoningText,
              cacheHitTokens,
              cacheMissTokens,
              reasoningTokens,
            }
          } finally {
            if (stallTimer) clearTimeout(stallTimer)
            disposeSignal()
          }
        })
      },
      {
        // 429/503 尊重服务端 Retry-After 响应头，无则回退指数退避
        getDelay: (error) => getRetryAfterDelay(error),
        onRetry: ({ attempt, delay, error }) => {
          // 用 system_info 而非 error：重试时操作仍在继续，
          // error 事件会解除 TUI 的 busy 锁导致误判为已结束
          onEvent({
            type: 'system_info',
            message: `流式请求重试 #${attempt}（${delay}ms 后）: ${error.message}`,
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
        type: 'system_info',
        message: `${parsed.message}，自动关闭思考模式重试`,
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
        type: 'system_info',
        message: `主模型不可用 (${(primaryError as Error).message})，降级到备用模型`,
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
      // 上下文利用率观测：本次 prompt token 与模型窗口大小
      promptTokens: usage.promptTokens,
      windowTokens: costConfig.contextWindow,
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

/**
 * DeepSeek fetch 拦截器（思考模式参数注入）
 *
 * 背景: @ai-sdk/openai@1.3 对 chat 模型的 providerOptions.openai 只做固定字段映射
 * （reasoningEffort/store/metadata 等），不会泛型展开；DeepSeek 的 `thinking`
 * 参数没有任何映射路径。因此通过 createOpenAI 的自定义 fetch 钩子，
 * 在请求体中注入 `thinking` 字段。
 *
 * 传递机制: AsyncLocalStorage 在调用方（ReActLoop/SubAgent）与 fetch 拦截器之间
 * 传递本次调用的 thinking 值，跨 async 边界安全（子 Agent 并行互不干扰）。
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { logError } from '../../utils/debugLog'

/** 当前调用链携带的 thinking 参数（如 { type: 'disabled' }） */
const thinkingStore = new AsyncLocalStorage<unknown>()

/**
 * DeepSeek 思考模式契约变换（2026-08 官方 Agent 集成文档 + 社区交叉验证）：
 * 1. reasoning part → 顶层 reasoning_content：assistant 消息 content 中的
 *    {type:'reasoning'} part 必须转换为消息顶层的 reasoning_content 字段，
 *    否则多轮工具调用必 400（opencode #24104/#24442、AstrBot #7906 同因）；
 * 2. 空串兜底：带 tool_calls 的 assistant 消息缺 reasoning_content 时注入 ""
 *    （社区验证的 200 修复路径）；
 * 3. tool_choice 剥离：thinking 模式不支持 tool_choice（supportsToolChoice: false）。
 * 导出供单元测试直接验证变换逻辑。
 */
export function transformDeepSeekBody(
  body: Record<string, unknown>,
  thinking: unknown,
): Record<string, unknown> {
  const messages = body.messages
  if (!Array.isArray(messages)) return body

  const thinkingDisabled =
    thinking !== undefined &&
    typeof thinking === 'object' &&
    (thinking as { type?: string }).type === 'disabled'

  const transformed = messages.map((m) => {
    const msg = m as Record<string, unknown>
    if (msg.role !== 'assistant') return msg

    const content = msg.content
    let reasoningText: string | undefined
    let nextContent = content
    if (Array.isArray(content)) {
      const reasoningParts = content.filter(
        (p) => (p as Record<string, unknown> | null)?.type === 'reasoning',
      )
      if (reasoningParts.length > 0) {
        reasoningText = reasoningParts
          .map((p) => String((p as Record<string, unknown>).text ?? ''))
          .join('')
        nextContent = content.filter(
          (p) => (p as Record<string, unknown> | null)?.type !== 'reasoning',
        )
      }
    }

    const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0
    const hasReasoningContent = typeof msg.reasoning_content === 'string'
    const next: Record<string, unknown> = { ...msg }

    if (reasoningText !== undefined) {
      // part 文本为空且已有 reasoning_content 时保留原值（幂等：SDK 已正确序列化时不变）
      next.reasoning_content = reasoningText || (hasReasoningContent ? msg.reasoning_content : '')
      next.content = nextContent
    } else if (hasToolCalls && !hasReasoningContent && !thinkingDisabled) {
      // 空串兜底：思考模式下工具调用轮必须有该字段，空串被 API 接受（社区验证）
      next.reasoning_content = ''
    }
    return next
  })

  const next: Record<string, unknown> = { ...body, messages: transformed }
  if (thinking !== undefined) next.thinking = thinking
  // thinking 模式不接受 tool_choice，防御性剥离（官方 supportsToolChoice: false）
  if ('tool_choice' in next) delete next.tool_choice
  return next
}

/**
 * 在 fn 的执行范围内携带 thinking 参数。
 * fn 内部发起的 LLM 请求（含流式消费触发的延迟 fetch）都会被
 * createDeepSeekFetch 拦截并注入该参数。
 */
export function withDeepSeekThinking<T>(thinking: unknown, fn: () => T): T {
  return thinkingStore.run(thinking, fn)
}

/**
 * 创建 DeepSeek 专用 fetch：将 AsyncLocalStorage 中的 thinking 参数
 * 注入 chat completion 请求体。未携带参数或非 JSON 请求时原样透传。
 */
export function createDeepSeekFetch(baseFetch?: typeof fetch): typeof fetch {
  const underlying = baseFetch ?? fetch
  const wrappedFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const thinking = thinkingStore.getStore()
    if (init?.body && typeof init.body === 'string') {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>
        // 仅对 chat completion 请求变换（有 messages 字段）
        if (body && typeof body === 'object' && Array.isArray(body.messages)) {
          init = { ...init, body: JSON.stringify(transformDeepSeekBody(body, thinking)) }
        }
      } catch {
        // body 非 JSON（不应发生），原样透传
      }
    }
    const response = await underlying(input, init)
    // 非 2xx 快速失败：@ai-sdk 的 streamText 对非流式错误响应（如 401）会静默吞掉错误，
    // 导致后续 await result.usage 永远挂起（TUI 表现为永久卡在“规划中”）。
    // 在 fetch 层抛出带状态码的错误，让重试/降级/报错链路正常激活。
    if (!response.ok) {
      let detail = ''
      try {
        detail = (await response.clone().text()).slice(0, 300)
      } catch {
        // 读取错误体失败不影响主流程
      }
      // 记录到调试日志：SDK 会吞掉 fetch 层错误，没有这条日志 400/401 等原因将无法追查
      logError('deepseek-non-ok', new Error(`${response.status} ${detail}`)).catch(() => {})
      throw new Error(`${response.status} ${response.statusText} ${detail}`.trim())
    }
    return response
  }
  // Bun 的 fetch 类型额外要求 preconnect 属性，透传底层实现（若存在）
  const preconnect = (underlying as { preconnect?: (...args: unknown[]) => unknown }).preconnect
  return Object.assign(wrappedFetch, {
    preconnect: preconnect ?? (() => {}),
  }) as typeof fetch
}

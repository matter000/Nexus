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

/** 当前调用链携带的 thinking 参数（如 { type: 'disabled' }） */
const thinkingStore = new AsyncLocalStorage<unknown>()

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
    if (thinking !== undefined && init?.body && typeof init.body === 'string') {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>
        // 仅对 chat completion 请求注入（有 messages 字段）
        if (body && typeof body === 'object' && Array.isArray(body.messages)) {
          body.thinking = thinking
          init = { ...init, body: JSON.stringify(body) }
        }
      } catch {
        // body 非 JSON（不应发生），原样透传
      }
    }
    return underlying(input, init)
  }
  // Bun 的 fetch 类型额外要求 preconnect 属性，透传底层实现（若存在）
  const preconnect = (underlying as { preconnect?: (...args: unknown[]) => unknown }).preconnect
  return Object.assign(wrappedFetch, {
    preconnect: preconnect ?? (() => {}),
  }) as typeof fetch
}

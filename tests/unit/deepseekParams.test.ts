/**
 * 单元测试: DeepSeek 参数透传（P0 修复验证）
 *
 * 背景: AI SDK v4 会静默丢弃 streamText 顶层的未知参数:
 * - reasoningEffort 必须经 providerOptions.openai 传递（SDK 映射为请求体 reasoning_effort）
 * - thinking 参数无任何 SDK 映射，经 AsyncLocalStorage + createDeepSeekFetch 拦截器注入请求体
 *
 * 验证方式: Bun.serve 模拟 OpenAI 兼容端点，捕获实际发出的请求体并断言字段存在。
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createOpenAI } from '@ai-sdk/openai'
import { streamText } from 'ai'
import { splitModelParameters } from '../../src/agent/ReActLoop'
import { createDeepSeekFetch, withDeepSeekThinking } from '../../src/router/providers/deepseekFetch'
import { deepseekAdapter } from '../../src/router/providers/index'

// ─── mock OpenAI 兼容端点 ─────────────────────────────────────────────────────

let lastRequestBody: Record<string, unknown> | null = null
let server: ReturnType<typeof Bun.serve> | null = null
let baseURL = ''

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      lastRequestBody = (await req.json()) as Record<string, unknown>
      const sse = [
        'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"deepseek-v4-flash","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}',
        '',
        'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"deepseek-v4-flash","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n')
      return new Response(sse, {
        headers: { 'content-type': 'text/event-stream' },
      })
    },
  })
  baseURL = `http://localhost:${server.port}/v1`
})

afterAll(() => {
  server?.stop()
})

/** 与生产一致的 provider 构造（含 DeepSeek fetch 拦截器） */
function createDeepSeekProvider() {
  return createOpenAI({ baseURL, apiKey: 'sk-test', fetch: createDeepSeekFetch() })
}

// ─── splitModelParameters 单元测试 ────────────────────────────────────────────

describe('splitModelParameters', () => {
  it('顶层已知键保留，thinking 单独提取，其余键收入 providerOptions.openai', () => {
    const { topLevel, providerOptions, thinking } = splitModelParameters({
      temperature: 0.1,
      topP: 0.9,
      maxTokens: 4096,
      reasoningEffort: 'max',
      thinking: { type: 'disabled' },
    })
    expect(topLevel).toEqual({ temperature: 0.1, topP: 0.9, maxTokens: 4096 })
    expect(providerOptions).toEqual({ openai: { reasoningEffort: 'max' } })
    expect(thinking).toEqual({ type: 'disabled' })
  })

  it('无 provider 特定键时 providerOptions 为 undefined', () => {
    const { topLevel, providerOptions, thinking } = splitModelParameters({
      temperature: 0,
    })
    expect(topLevel).toEqual({ temperature: 0 })
    expect(providerOptions).toBeUndefined()
    expect(thinking).toBeUndefined()
  })

  it('undefined 输入返回空结果', () => {
    const { topLevel, providerOptions, thinking } = splitModelParameters(undefined)
    expect(topLevel).toEqual({})
    expect(providerOptions).toBeUndefined()
    expect(thinking).toBeUndefined()
  })
})

// ─── 端到端: 请求体确实携带 reasoning_effort 与 thinking ────────────────────

describe('DeepSeek 参数注入到请求体（mock server 验证）', () => {
  it('reasoningEffort 经 providerOptions.openai 映射为请求体 reasoning_effort', async () => {
    const model = createDeepSeekProvider()('deepseek-v4-pro')

    const adapterParams = deepseekAdapter.getModelParameters?.('deepseek-v4-pro', 'verifier')
    const { topLevel, providerOptions, thinking } = splitModelParameters(adapterParams)
    expect(providerOptions?.openai.reasoningEffort).toBe('max') // verifier 必有

    // streamText() 调用即发起请求，必须整体处于 ALS 作用域内
    let text = ''
    await withDeepSeekThinking(thinking, async () => {
      const result = streamText({
        model,
        messages: [{ role: 'user', content: 'hello' }],
        ...topLevel,
        ...(providerOptions ? { providerOptions } : {}),
      } as Parameters<typeof streamText>[0])
      for await (const chunk of result.textStream) {
        text += chunk
      }
    })
    expect(text).toBe('ok')

    // 核心断言: 请求体包含 SDK 映射后的 reasoning_effort 字段
    expect(lastRequestBody).not.toBeNull()
    expect(lastRequestBody?.reasoning_effort).toBe('max')
    // 顶层参数也应正常映射（maxTokens → max_tokens）
    expect(lastRequestBody?.max_tokens).toBe(4096)
    // verifier 保持思考模式，不注入 thinking 字段
    expect(lastRequestBody?.thinking).toBeUndefined()
  })

  it('executor 的 thinking: disabled 经 fetch 拦截器注入请求体', async () => {
    const model = createDeepSeekProvider()('deepseek-v4-flash')

    const adapterParams = deepseekAdapter.getModelParameters?.('deepseek-v4-flash', 'executor')
    const { topLevel, providerOptions, thinking } = splitModelParameters(adapterParams)
    expect(thinking).toEqual({ type: 'disabled' })

    // ALS 包裹 streamText 调用与流消费：fetch 拦截器在请求发出时读取 thinking 值
    await withDeepSeekThinking(thinking, async () => {
      const result = streamText({
        model,
        messages: [{ role: 'user', content: 'hello' }],
        ...topLevel,
        ...(providerOptions ? { providerOptions } : {}),
      } as Parameters<typeof streamText>[0])
      for await (const _chunk of result.textStream) {
        // 消费流以触发请求
      }
    })

    expect(lastRequestBody).not.toBeNull()
    expect(lastRequestBody?.thinking).toEqual({ type: 'disabled' })
    // executor 不应携带 reasoning_effort
    expect(lastRequestBody?.reasoning_effort).toBeUndefined()
    // 关闭思考模式后 temperature 应生效并出现在请求体
    expect(lastRequestBody?.temperature).toBe(0)
  })

  it('未携带 thinking 时拦截器不修改请求体（其他 provider 安全）', async () => {
    const model = createDeepSeekProvider()('deepseek-v4-flash')
    const result = streamText({
      model,
      messages: [{ role: 'user', content: 'hello' }],
    })
    for await (const _chunk of result.textStream) {
      // 消费流以触发请求
    }
    expect(lastRequestBody).not.toBeNull()
    expect(lastRequestBody?.thinking).toBeUndefined()
  })
})

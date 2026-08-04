/**
 * 单元测试: Provider 适配器层
 * 验证 isAvailable 正确合并环境变量与 secrets 配置
 *
 * 复现 bug: anthropicAdapter.isAvailable() 仅检查 process.env.ANTHROPIC_API_KEY，
 * 当用户只在 ~/.nexus/secrets.toml 配置了 key 时误判为不可用。
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { SecretsConfig } from '../../src/config-secrets'
import { parseDeepSeekError } from '../../src/router/providers/deepseekErrors'
import {
  anthropicAdapter,
  deepseekAdapter,
  getAvailableProviders,
  getProvider,
  openaiAdapter,
} from '../../src/router/providers/index'

// ─── 测试用 secrets 配置 ───────────────────────────────────────────────────────

const secretsWithAnthropic: SecretsConfig = {
  providers: { anthropic: { apiKey: 'sk-test-anthropic' } },
}

const secretsWithOpenAI: SecretsConfig = {
  providers: { openai: { apiKey: 'sk-test-openai' } },
}

const secretsWithDeepSeek: SecretsConfig = {
  providers: { deepseek: { apiKey: 'sk-test-deepseek' } },
}

// ─── 环境变量清理 ──────────────────────────────────────────────────────────────

const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'CUSTOM_API_KEY',
  'CUSTOM_BASE_URL',
  'CUSTOM_DEFAULT_MODEL',
]

let savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv = {}
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

describe('Provider 适配器 isAvailable 与 secrets 一致性', () => {
  it('anthropicAdapter: 仅 secrets 有 key 时应报告可用', () => {
    // bug 复现：旧实现只查 process.env，secrets 配置的 key 被忽略
    expect(anthropicAdapter.isAvailable()).toBe(false) // 无 env 无 secrets
    expect(anthropicAdapter.isAvailable(secretsWithAnthropic)).toBe(true)
  })

  it('anthropicAdapter: env 优先于 secrets', () => {
    process.env.ANTHROPIC_API_KEY = 'env-key'
    expect(anthropicAdapter.isAvailable()).toBe(true)
    expect(anthropicAdapter.isAvailable(secretsWithAnthropic)).toBe(true)
  })

  it('openaiAdapter: 仅 secrets 有 key 时应报告可用', () => {
    expect(openaiAdapter.isAvailable()).toBe(false)
    expect(openaiAdapter.isAvailable(secretsWithOpenAI)).toBe(true)
  })

  it('deepseekAdapter: 仅 secrets 有 key 时应报告可用', () => {
    expect(deepseekAdapter.isAvailable()).toBe(false)
    expect(deepseekAdapter.isAvailable(secretsWithDeepSeek)).toBe(true)
  })

  it('getProvider("anthropic", secrets) 返回的适配器感知 secrets', () => {
    const adapter = getProvider('anthropic', secretsWithAnthropic)
    expect(adapter).toBeDefined()
    expect(adapter!.isAvailable(secretsWithAnthropic)).toBe(true)
  })

  it('getAvailableProviders(secrets) 包含 secrets 中配置的内置 provider', () => {
    // secrets 配置了 anthropic 但未设环境变量时，应出现在可用列表中
    const available = getAvailableProviders(secretsWithAnthropic)
    const names = available.map((p) => p.name)
    expect(names).toContain('anthropic')
  })

  it('getAvailableProviders(secrets) 同时包含 env 和 secrets 来源的 provider', () => {
    process.env.OPENAI_API_KEY = 'env-openai'
    const secrets: SecretsConfig = {
      providers: {
        anthropic: { apiKey: 'secret-anthropic' },
      },
    }
    const available = getAvailableProviders(secrets)
    const names = available.map((p) => p.name)
    expect(names).toContain('anthropic') // 来自 secrets
    expect(names).toContain('openai') // 来自 env
  })
})

// ─── DeepSeek 思考模式角色策略（深度适配） ─────────────────────────────

describe('deepseekAdapter.getModelParameters 思考模式角色策略', () => {
  it('planner/executor 关闭思考模式（SDK 不回传 reasoning_content，避免 422）', () => {
    for (const role of ['planner', 'executor'] as const) {
      for (const model of ['deepseek-v4-flash', 'deepseek-v4-pro']) {
        const params = deepseekAdapter.getModelParameters!(model, role)!
        expect(params.thinking).toEqual({ type: 'disabled' })
        // 关闭思考模式后不应再携带推理深度控制
        expect(params.reasoningEffort).toBeUndefined()
      }
    }
  })

  it('summarizer/verifier 保持思考模式（单轮无工具，无 422 风险）', () => {
    for (const role of ['summarizer', 'verifier'] as const) {
      const params = deepseekAdapter.getModelParameters!('deepseek-v4-flash', role)!
      expect(params.thinking).toBeUndefined()
    }
  })

  it('v4-pro verifier 使用 reasoningEffort: max，summarizer 使用 high（驼峰键供 SDK 映射）', () => {
    const verifier = deepseekAdapter.getModelParameters!('deepseek-v4-pro', 'verifier')!
    expect(verifier.reasoningEffort).toBe('max')
    expect(verifier.thinking).toBeUndefined()

    const summarizer = deepseekAdapter.getModelParameters!('deepseek-v4-pro', 'summarizer')!
    expect(summarizer.reasoningEffort).toBe('high')
  })
})

// ─── DeepSeek 422 自愈标记 ─────────────────────────────────────────────

describe('parseDeepSeekError reasoning_content 契约错误', () => {
  it('reasoning_content 错误标记为可恢复且需关闭思考模式', () => {
    const parsed = parseDeepSeekError(
      new Error('422 Please carry back reasoning_content in multi-turn'),
      'deepseek-v4-flash',
    )
    expect(parsed.parsed).toBe(true)
    expect(parsed.recoverable).toBe(true)
    expect(parsed.disableThinking).toBe(true)
  })

  it('普通错误不携带 disableThinking 标记', () => {
    const parsed = parseDeepSeekError(new Error('429 Too Many Requests'))
    expect(parsed.disableThinking).toBeUndefined()
    expect(parsed.recoverable).toBe(true)
  })
})

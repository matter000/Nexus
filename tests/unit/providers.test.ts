/**
 * 单元测试: Provider 适配器层
 * 验证 isAvailable 正确合并环境变量与 secrets 配置
 *
 * 复现 bug: anthropicAdapter.isAvailable() 仅检查 process.env.ANTHROPIC_API_KEY，
 * 当用户只在 ~/.nexus/secrets.toml 配置了 key 时误判为不可用。
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  anthropicAdapter,
  openaiAdapter,
  deepseekAdapter,
  getProvider,
  getAvailableProviders,
} from '../../src/router/providers/index'
import type { SecretsConfig } from '../../src/config-secrets'

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

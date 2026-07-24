/**
 * Provider 适配层
 * 各 LLM provider 的特定适配逻辑
 * Vercel AI SDK 已处理大半,这里补充边界情况
 */

import type { ProviderName } from '../../agent/types'
import type { ProviderSecret, SecretsConfig } from '../../config-secrets'
import { isCustomProviderName } from '../../config-secrets'

export interface ProviderAdapter {
  /** provider 名称（内置为 ProviderName，自定义条目为任意键名） */
  name: string
  /** 检查 provider 是否可用(API key 已配置等) */
  isAvailable(): boolean
  /** 获取默认模型 */
  getDefaultModel(): string
  /** 获取上下文窗口大小 */
  getContextWindow(model: string): number
  /** 是否支持 tool calling */
  supportsTools(model: string): boolean
}

/** Anthropic 适配器 */
export const anthropicAdapter: ProviderAdapter = {
  name: 'anthropic',
  isAvailable: () => !!process.env.ANTHROPIC_API_KEY,
  getDefaultModel: () => 'claude-sonnet-4-20250514',
  getContextWindow: () => 200000,
  supportsTools: () => true,
}

/** OpenAI 适配器 */
export const openaiAdapter: ProviderAdapter = {
  name: 'openai',
  isAvailable: () => !!process.env.OPENAI_API_KEY,
  getDefaultModel: () => 'gpt-4o',
  getContextWindow: (model) => {
    // mini 系列上下文窗口与标准模型一致（128k）
    return 128000
  },
  supportsTools: () => true,
}

/** DeepSeek 适配器(兼容 OpenAI 接口) */
export const deepseekAdapter: ProviderAdapter = {
  name: 'deepseek',
  isAvailable: () => !!process.env.DEEPSEEK_API_KEY,
  getDefaultModel: () => 'deepseek-chat',
  getContextWindow: () => 65536,
  supportsTools: (model) => model === 'deepseek-chat', // reasoner 不支持 tool calling
}

/** 通用 OpenAI 兼容适配器(自定义 base URL) */
export function createCustomAdapter(secrets?: SecretsConfig): ProviderAdapter {
  return {
    name: 'custom',
    isAvailable: () => {
      // 优先级: 环境变量 > secrets 文件
      const apiKey = process.env.CUSTOM_API_KEY || secrets?.providers.custom?.apiKey
      const baseUrl = process.env.CUSTOM_BASE_URL || secrets?.providers.custom?.baseUrl
      return !!(apiKey && baseUrl)
    },
    getDefaultModel: () =>
      process.env.CUSTOM_DEFAULT_MODEL
      ?? secrets?.providers.custom?.defaultModel
      ?? 'default',
    getContextWindow: () => 128000, // 默认假设
    supportsTools: () => true, // 大多数 OpenAI 兼容接口支持
  }
}

/**
 * 为命名自定义条目创建动态适配器。
 * 支持任意键名（如 custom-openai-1、custom-anthropic-1），按 compatibility 区分协议。
 */
export function createDynamicCustomAdapter(name: string, secret: ProviderSecret): ProviderAdapter {
  return {
    name,
    isAvailable: () => !!(secret.apiKey && secret.baseUrl),
    getDefaultModel: () => secret.defaultModel ?? 'default',
    getContextWindow: () => 128000, // 默认假设
    supportsTools: () => true, // OpenAI/Anthropic 兼容接口通常都支持 tool calling
  }
}

/** 收集 secrets 中所有自定义条目适配器（含旧 custom 键） */
function collectCustomAdapters(secrets?: SecretsConfig): ProviderAdapter[] {
  if (!secrets) {
    // 无 secrets 时仍尝试旧 custom 环境变量兼容
    return [createCustomAdapter(secrets)]
  }
  const adapters: ProviderAdapter[] = []
  for (const [key, secret] of Object.entries(secrets.providers)) {
    if (!isCustomProviderName(key)) continue
    if (!secret.apiKey) continue
    adapters.push(createDynamicCustomAdapter(key, secret))
  }
  return adapters
}

/** 获取所有可用 provider */
export function getAvailableProviders(secrets?: SecretsConfig): ProviderAdapter[] {
  const staticAdapters = [anthropicAdapter, openaiAdapter, deepseekAdapter]
  const customAdapters = collectCustomAdapters(secrets)
  return [...staticAdapters, ...customAdapters].filter((p) => p.isAvailable())
}

/** 按名称获取 provider */
export function getProvider(name: string, secrets?: SecretsConfig): ProviderAdapter | undefined {
  // 内置静态 provider
  const staticMap: Record<string, ProviderAdapter> = {
    anthropic: anthropicAdapter,
    openai: openaiAdapter,
    deepseek: deepseekAdapter,
  }
  if (staticMap[name]) return staticMap[name]

  // 自定义条目（命名键或旧 custom 键）
  if (name === 'custom') return createCustomAdapter(secrets)
  if (secrets && isCustomProviderName(name)) {
    const secret = secrets.providers[name]
    if (secret) return createDynamicCustomAdapter(name, secret)
  }
  return undefined
}

/**
 * Provider 适配层
 * 各 LLM provider 的特定适配逻辑
 * Vercel AI SDK 已处理大半,这里补充边界情况
 */

import type { ProviderName } from '../../agent/types'

export interface ProviderAdapter {
  name: ProviderName
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
    if (model.includes('mini')) return 128000
    return 128000
  },
  supportsTools: () => true,
}

/** Ollama 适配器(本地模型) */
export const ollamaAdapter: ProviderAdapter = {
  name: 'ollama',
  isAvailable: () => true, // 本地服务,假设可用
  getDefaultModel: () => 'llama3',
  getContextWindow: () => 8192,
  supportsTools: () => false, // 大多数本地模型不支持 tool calling
}

/** DeepSeek 适配器(兼容 OpenAI 接口) */
export const deepseekAdapter: ProviderAdapter = {
  name: 'deepseek',
  isAvailable: () => !!process.env.DEEPSEEK_API_KEY,
  getDefaultModel: () => 'deepseek-chat',
  getContextWindow: (model) => {
    if (model === 'deepseek-reasoner') return 65536
    return 65536
  },
  supportsTools: (model) => model === 'deepseek-chat', // reasoner 不支持 tool calling
}

/** 通用 OpenAI 兼容适配器(自定义 base URL) */
export const customAdapter: ProviderAdapter = {
  name: 'custom',
  isAvailable: () => !!(process.env.CUSTOM_API_KEY && process.env.CUSTOM_BASE_URL),
  getDefaultModel: () => process.env.CUSTOM_DEFAULT_MODEL ?? 'default',
  getContextWindow: () => 128000, // 默认假设
  supportsTools: () => true, // 大多数 OpenAI 兼容接口支持
}

/** 获取所有可用 provider */
export function getAvailableProviders(): ProviderAdapter[] {
  const all = [anthropicAdapter, openaiAdapter, deepseekAdapter, ollamaAdapter, customAdapter]
  return all.filter((p) => p.isAvailable())
}

/** 按名称获取 provider */
export function getProvider(name: ProviderName): ProviderAdapter | undefined {
  const all = [anthropicAdapter, openaiAdapter, deepseekAdapter, ollamaAdapter, customAdapter]
  return all.find((p) => p.name === name)
}

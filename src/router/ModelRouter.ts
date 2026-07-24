/**
 * 模型路由器
 * 不同任务用不同模型,平衡能力与成本
 * 支持降级、重试、多 provider
 */

import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModel } from 'ai'
import type { ModelRole, ModelRoute, NexusConfig, ProviderName } from '../agent/types'
import { CostTracker } from './CostTracker'

/** 已知模型的能力与成本数据 */
const MODEL_CATALOG: Record<string, Omit<ModelRoute, 'role'>> = {
  // Anthropic
  'claude-sonnet-4-20250514': {
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    costPer1kInput: 0.003,
    costPer1kOutput: 0.015,
    contextWindow: 200000,
    supportsTools: true,
    supportsStreaming: true,
  },
  'claude-haiku-3-5': {
    provider: 'anthropic',
    model: 'claude-haiku-3-5',
    costPer1kInput: 0.0008,
    costPer1kOutput: 0.004,
    contextWindow: 200000,
    supportsTools: true,
    supportsStreaming: true,
  },
  // OpenAI
  'gpt-4o': {
    provider: 'openai',
    model: 'gpt-4o',
    costPer1kInput: 0.0025,
    costPer1kOutput: 0.01,
    contextWindow: 128000,
    supportsTools: true,
    supportsStreaming: true,
  },
  'gpt-4o-mini': {
    provider: 'openai',
    model: 'gpt-4o-mini',
    costPer1kInput: 0.00015,
    costPer1kOutput: 0.0006,
    contextWindow: 128000,
    supportsTools: true,
    supportsStreaming: true,
  },
  // Ollama (本地,成本为 0)
  'llama3': {
    provider: 'ollama',
    model: 'llama3',
    costPer1kInput: 0,
    costPer1kOutput: 0,
    contextWindow: 8192,
    supportsTools: false,
    supportsStreaming: true,
  },
  // DeepSeek (兼容 OpenAI 接口)
  'deepseek-chat': {
    provider: 'deepseek',
    model: 'deepseek-chat',
    costPer1kInput: 0.00027,
    costPer1kOutput: 0.0011,
    contextWindow: 65536,
    supportsTools: true,
    supportsStreaming: true,
  },
  'deepseek-reasoner': {
    provider: 'deepseek',
    model: 'deepseek-reasoner',
    costPer1kInput: 0.00055,
    costPer1kOutput: 0.00219,
    contextWindow: 65536,
    supportsTools: false,
    supportsStreaming: true,
  },
}

/** 各角色的默认模型选择 */
const DEFAULT_ROLE_MODELS: Record<ModelRole, string> = {
  planner: 'claude-sonnet-4-20250514',
  executor: 'claude-sonnet-4-20250514',
  summarizer: 'claude-haiku-3-5',
  verifier: 'claude-haiku-3-5',
}

/** 降级链:高档 → 中档 → 低档 */
const FALLBACK_CHAIN: Record<string, string> = {
  'claude-sonnet-4-20250514': 'deepseek-chat',
  'deepseek-chat': 'gpt-4o-mini',
  'gpt-4o': 'deepseek-chat',
  'gpt-4o-mini': 'claude-haiku-3-5',
}

export class ModelRouter {
  private config: NexusConfig
  private costTracker: CostTracker
  private providers: Map<ProviderName, ReturnType<typeof createAnthropic> | ReturnType<typeof createOpenAI>>
  private currentModels: Record<ModelRole, string>

  constructor(config: NexusConfig, costTracker: CostTracker) {
    this.config = config
    this.costTracker = costTracker
    this.providers = new Map()
    this.currentModels = { ...DEFAULT_ROLE_MODELS }
    this.initProviders()
    this.applyConfigModels()
  }

  /** 初始化各 provider */
  private initProviders(): void {
    const providersConfig = this.config.models.providers

    // Anthropic
    if (providersConfig.anthropic) {
      const apiKey = process.env[providersConfig.anthropic.apiKeyEnv ?? 'ANTHROPIC_API_KEY']
      if (apiKey) {
        this.providers.set('anthropic', createAnthropic({ apiKey }))
      }
    }

    // OpenAI
    if (providersConfig.openai) {
      const apiKey = process.env[providersConfig.openai.apiKeyEnv ?? 'OPENAI_API_KEY']
      if (apiKey) {
        this.providers.set('openai', createOpenAI({ apiKey }))
      }
    }

    // Ollama (OpenAI 兼容接口)
    if (providersConfig.ollama) {
      this.providers.set('ollama', createOpenAI({
        baseURL: providersConfig.ollama.baseUrl ?? 'http://localhost:11434/v1',
        apiKey: 'ollama', // Ollama 不需要真实 key
      }))
    }

    // DeepSeek (OpenAI 兼容接口)
    if (providersConfig.deepseek) {
      const apiKey = process.env[providersConfig.deepseek.apiKeyEnv ?? 'DEEPSEEK_API_KEY']
      if (apiKey) {
        this.providers.set('deepseek', createOpenAI({
          baseURL: providersConfig.deepseek.baseUrl ?? 'https://api.deepseek.com',
          apiKey,
        }))
      }
    }

    // Custom (通用 OpenAI 兼容接口,支持任意厂商)
    if (providersConfig.custom) {
      const apiKey = process.env[providersConfig.custom.apiKeyEnv ?? 'CUSTOM_API_KEY']
      const baseURL = providersConfig.custom.baseUrl ?? process.env.CUSTOM_BASE_URL
      if (apiKey && baseURL) {
        this.providers.set('custom', createOpenAI({ baseURL, apiKey }))
      }
    }
  }

  /** 应用配置文件中的模型选择 */
  private applyConfigModels(): void {
    const roles: ModelRole[] = ['planner', 'executor', 'summarizer', 'verifier']
    for (const role of roles) {
      const configured = this.config.models[role]
      if (configured && configured !== 'auto') {
        this.currentModels[role] = configured
      }
    }
  }

  /** 获取指定角色的 LanguageModel 实例 */
  getModel(role: ModelRole): LanguageModel {
    const modelName = this.currentModels[role]
    const catalog = MODEL_CATALOG[modelName]

    if (!catalog) {
      // 未知模型,尝试直接用默认 provider
      const defaultProvider = this.providers.get('anthropic') ?? this.providers.get('openai')
      if (defaultProvider) {
        return defaultProvider(modelName) as LanguageModel
      }
      throw new Error(`模型 ${modelName} 不在已知目录中,且无可用 provider`)
    }

    const provider = this.providers.get(catalog.provider)
    if (!provider) {
      // Provider 不可用,尝试降级
      const fallback = this.getFallback(role)
      if (fallback) return fallback
      throw new Error(`Provider ${catalog.provider} 未配置或 API key 缺失`)
    }

    return provider(catalog.model) as LanguageModel
  }

  /** 获取降级模型 */
  private getFallback(role: ModelRole): LanguageModel | null {
    const currentModel = this.currentModels[role]
    const fallbackName = FALLBACK_CHAIN[currentModel]

    if (!fallbackName) return null

    const catalog = MODEL_CATALOG[fallbackName]
    if (!catalog) return null

    const provider = this.providers.get(catalog.provider)
    if (!provider) return null

    return provider(catalog.model) as LanguageModel
  }

  /** 获取模型路由信息(用于成本计算) */
  getRouteInfo(role: ModelRole): ModelRoute {
    const modelName = this.currentModels[role]
    const catalog = MODEL_CATALOG[modelName]
    if (catalog) {
      return { ...catalog, role }
    }
    // 未知模型,返回默认值
    return {
      provider: 'anthropic',
      model: modelName,
      role,
      costPer1kInput: 0.003,
      costPer1kOutput: 0.015,
      contextWindow: 200000,
      supportsTools: true,
      supportsStreaming: true,
    }
  }

  /** 切换模型 */
  setModel(role: ModelRole, modelName: string): void {
    this.currentModels[role] = modelName
  }

  /** 获取当前模型名 */
  getCurrentModel(role: ModelRole): string {
    return this.currentModels[role]
  }

  /** 获取所有可用 provider */
  getAvailableProviders(): ProviderName[] {
    return Array.from(this.providers.keys())
  }

  /** 获取上下文窗口大小 */
  getContextWindow(role: ModelRole): number {
    const route = this.getRouteInfo(role)
    return route.contextWindow
  }

  getCostTracker(): CostTracker {
    return this.costTracker
  }
}

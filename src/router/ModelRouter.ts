/**
 * 模型路由器
 * 不同任务用不同模型,平衡能力与成本
 * 支持降级、重试、多 provider
 */

import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModel } from 'ai'
import type { ModelRole, ModelRoute, NexusConfig, ProviderName } from '../agent/types'
import { getEffectiveApiKey, isCustomProviderName, type SecretsConfig } from '../config-secrets'
import type { CostTracker } from './CostTracker'
import { createDeepSeekFetch } from './providers/deepseekFetch'
import { getAvailableProviders, getProvider } from './providers/index'

/** 已知模型的成本与角色信息（Nexus 特有的路由逻辑）
 *
 * DeepSeek 深度适配说明（v4 系列）:
 * - deepseek-v4-flash: 主力模型，高速低成本，支持 tool calling 和思考模式，适合 planner/executor
 * - deepseek-v4-pro: 高性能模型，支持深度推理和 tool calling，适合 verifier/复杂分析
 * - 注意: deepseek-chat / deepseek-reasoner 已于 2026/07/24 弃用
 * - 优先级: deepseek > anthropic > openai（当 DeepSeek 可用时优先使用）
 */
const MODEL_COST_DATA: Record<
  string,
  { costPer1kInput: number; costPer1kOutput: number; costPer1kInputCached?: number }
> = {
  // DeepSeek v4 系列（最新定价，单位: 美元）
  // 价格参考（百万 tokens）:
  //   v4-flash: 输入(缓存命中)=0.02元, 输入(缓存未命中)=1元, 输出=2元
  //   v4-pro:   输入(缓存命中)=0.025元, 输入(缓存未命中)=3元, 输出=6元
  // 按 7.3 汇率估算 USD/1K:
  //   v4-flash: 缓存命中输入≈$0.0000027/1K, 缓存未命中输入≈$0.000137/1K, 输出≈$0.000274/1K
  //   v4-pro:   缓存命中输入≈$0.0000034/1K, 缓存未命中输入≈$0.000411/1K, 输出≈$0.000822/1K
  // 注意: 缓存命中价格远低于未命中（v4-flash 约 50x 差异，v4-pro 约 120x 差异）
  // costPer1kInput 记录"未命中"价格，costPer1kInputCached 记录"命中"价格，
  // CostTracker 按命中/未命中 token 数分级计费
  'deepseek-v4-flash': {
    costPer1kInput: 0.000137,
    costPer1kOutput: 0.000274,
    costPer1kInputCached: 0.0000027,
  },
  'deepseek-v4-pro': {
    costPer1kInput: 0.000411,
    costPer1kOutput: 0.000822,
    costPer1kInputCached: 0.0000034,
  },
  // Anthropic 系列
  'claude-sonnet-4-20250514': { costPer1kInput: 0.003, costPer1kOutput: 0.015 },
  'claude-haiku-3-5': { costPer1kInput: 0.0008, costPer1kOutput: 0.004 },
  // OpenAI 系列
  'gpt-4o': { costPer1kInput: 0.0025, costPer1kOutput: 0.01 },
  'gpt-4o-mini': { costPer1kInput: 0.00015, costPer1kOutput: 0.0006 },
}

/** 模型 → 所属 provider 的映射 */
const MODEL_PROVIDER_MAP: Record<string, ProviderName> = {
  // DeepSeek v4 系列
  'deepseek-v4-flash': 'deepseek',
  'deepseek-v4-pro': 'deepseek',
  // Anthropic
  'claude-sonnet-4-20250514': 'anthropic',
  'claude-haiku-3-5': 'anthropic',
  // OpenAI
  'gpt-4o': 'openai',
  'gpt-4o-mini': 'openai',
}

/** 各角色的默认模型选择
 *
 * 深度适配策略（v4 系列）:
 * - planner: 用 deepseek-v4-flash（高速低成本，支持 tool calling）
 * - executor: 用 deepseek-v4-flash（主力执行，支持 tool calling）
 * - summarizer: 用 deepseek-v4-flash（轻量摘要，成本极低）
 * - verifier: 用 deepseek-v4-pro（高性能推理，支持思考模式，适合复杂分析）
 */
const DEFAULT_ROLE_MODELS: Record<ModelRole, string> = {
  planner: 'deepseek-v4-flash',
  executor: 'deepseek-v4-flash',
  summarizer: 'deepseek-v4-flash',
  verifier: 'deepseek-v4-pro',
}

/** 降级链: 跨 provider 容灾策略
 *  deepseek-v4-flash → claude-haiku-3-5 → gpt-4o-mini（同生态内降级无意义，flash 失败通常是服务端问题）
 *  deepseek-v4-pro → deepseek-v4-flash → claude-haiku-3-5 → gpt-4o-mini
 */
export const FALLBACK_CHAIN: Record<string, string> = {
  // DeepSeek 降级链（优先切到更便宜的 flash，再跨 provider 容灾）
  'deepseek-v4-flash': 'claude-haiku-3-5',
  'deepseek-v4-pro': 'deepseek-v4-flash',
  // Anthropic 降级链
  'claude-sonnet-4-20250514': 'deepseek-v4-flash',
  'claude-haiku-3-5': 'gpt-4o-mini',
  // OpenAI 降级链
  'gpt-4o': 'deepseek-v4-flash',
  'gpt-4o-mini': 'claude-haiku-3-5',
}

export class ModelRouter {
  private config: NexusConfig
  private costTracker: CostTracker
  private providers: Map<
    string,
    ReturnType<typeof createAnthropic> | ReturnType<typeof createOpenAI>
  >
  private currentModels: Record<ModelRole, string>
  private secrets: SecretsConfig

  constructor(config: NexusConfig, costTracker: CostTracker, secrets?: SecretsConfig) {
    this.config = config
    this.costTracker = costTracker
    this.providers = new Map()
    this.currentModels = { ...DEFAULT_ROLE_MODELS }
    this.secrets = secrets ?? { providers: {} }
    this.initProviders()
    this.applyConfigModels()
  }

  /** 初始化各 provider，使用适配器检查可用性 */
  private initProviders(): void {
    const providersConfig = this.config.models.providers

    // 内置 provider（anthropic/openai/deepseek）：沿用配置中的 apiKeyEnv 与默认值
    const builtin: Array<{ name: 'anthropic' | 'openai' | 'deepseek' }> = [
      { name: 'anthropic' },
      { name: 'openai' },
      { name: 'deepseek' },
    ]
    for (const { name } of builtin) {
      const providerConfig = providersConfig[name]
      if (!providerConfig) continue
      const apiKey = getEffectiveApiKey(
        name,
        providerConfig.apiKeyEnv ?? `${name.toUpperCase()}_API_KEY`,
        this.secrets,
      )
      if (!apiKey) continue

      if (name === 'anthropic') {
        this.providers.set('anthropic', createAnthropic({ apiKey }))
      } else if (name === 'openai') {
        this.providers.set('openai', createOpenAI({ apiKey }))
      } else if (name === 'deepseek') {
        this.providers.set(
          'deepseek',
          createOpenAI({
            baseURL:
              this.secrets.providers.deepseek?.baseUrl ??
              providerConfig.baseUrl ??
              'https://api.deepseek.com',
            apiKey,
            // DeepSeek 深度适配: fetch 拦截器注入 thinking 参数（SDK 无此映射）
            fetch: createDeepSeekFetch(),
          }),
        )
      }
    }

    // 自定义条目（任意命名键，含旧 custom）：按 compatibility 选择 OpenAI/Anthropic 协议
    for (const [name, secret] of Object.entries(this.secrets.providers)) {
      if (!isCustomProviderName(name)) continue
      const apiKey =
        secret.apiKey ?? process.env[`${name.toUpperCase().replace(/-/g, '_')}_API_KEY`]
      const baseURL = secret.baseUrl
      if (!apiKey || !baseURL) continue

      if (secret.compatibility === 'anthropic') {
        this.providers.set(name, createAnthropic({ apiKey, baseURL }))
      } else {
        // openai 兼容（含旧 custom 与缺省情况）
        // 代理 DeepSeek 端点时挂载 fetch 拦截器，使 thinking 参数注入生效
        this.providers.set(
          name,
          createOpenAI({
            baseURL,
            apiKey,
            ...(baseURL.includes('api.deepseek.com') ? { fetch: createDeepSeekFetch() } : {}),
          }),
        )
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
      } else {
        // auto 模式: 根据实际可用的 provider 选择最佳模型
        this.currentModels[role] = this.resolveAutoModel(role)
      }
    }
  }

  /** auto 模式: 按优先级选择第一个可用 provider 的最佳模型（委托给适配器）
   *
   * DeepSeek 深度适配: 优先级改为 deepseek > anthropic > openai
   * 当 DeepSeek API Key 已配置时，自动优先使用 DeepSeek 模型
   */
  private resolveAutoModel(role: ModelRole): string {
    // 内置 provider 优先级: deepseek > anthropic > openai（DeepSeek 深度适配）
    const builtinPriority: string[] = ['deepseek', 'anthropic', 'openai']
    const isHighRole = role === 'planner' || role === 'executor'

    for (const providerName of builtinPriority) {
      if (this.providers.has(providerName)) {
        const adapter = getProvider(providerName, this.secrets)
        if (adapter) {
          // 高能力角色用默认高端模型，低能力角色用轻量模型
          const defaultModel = adapter.getDefaultModel()
          if (isHighRole) return defaultModel
          // 低端角色尝试降级：deepseek 用 deepseek-v4-flash，anthropic 用 haiku，openai 用 mini
          if (providerName === 'deepseek') return 'deepseek-v4-flash'
          if (providerName === 'anthropic') return 'claude-haiku-3-5'
          if (providerName === 'openai') return 'gpt-4o-mini'
          return defaultModel
        }
      }
    }

    // 回退到任意自定义条目（按 secrets.providers 顺序）
    for (const [name] of Object.entries(this.secrets.providers)) {
      if (!isCustomProviderName(name)) continue
      if (this.providers.has(name)) {
        const adapter = getProvider(name, this.secrets)
        if (adapter) return adapter.getDefaultModel()
      }
    }

    // 无任何可用 provider,保留默认值(运行时会报错提示配置)
    return DEFAULT_ROLE_MODELS[role]
  }

  /** 构建模型的路由信息（合并适配器能力数据 + 成本数据） */
  private buildModelRoute(modelName: string, role: ModelRole): ModelRoute | null {
    const providerName = this.resolveProviderName(modelName)
    if (!providerName) return null

    const adapter = getProvider(providerName, this.secrets)
    if (!adapter) return null

    const costData = this.config.models.costOverrides?.[modelName] ??
      MODEL_COST_DATA[modelName] ?? { costPer1kInput: 0.003, costPer1kOutput: 0.015 }

    return {
      provider: providerName,
      model: modelName,
      role,
      costPer1kInput: costData.costPer1kInput,
      costPer1kOutput: costData.costPer1kOutput,
      costPer1kInputCached: costData.costPer1kInputCached,
      contextWindow: adapter.getContextWindow(modelName),
      supportsTools: adapter.supportsTools(modelName),
      supportsStreaming: true,
    }
  }

  /**
   * 统一 provider 解析优先级:
   * 1. 自定义条目显式声明该模型为 defaultModel（用户经自定义端点代理模型的典型场景）
   * 2. 内置模型目录映射（MODEL_PROVIDER_MAP）
   * 3. secrets 推断（defaultProvider / defaultModel 匹配）
   */
  private resolveProviderName(modelName: string): string | null {
    for (const [name, secret] of Object.entries(this.secrets.providers)) {
      if (secret.defaultModel === modelName && this.providers.has(name)) return name
    }
    return MODEL_PROVIDER_MAP[modelName] ?? this.resolveProviderForModel(modelName)
  }

  /** 为未知模型推断 provider（基于 secrets 配置） */
  private resolveProviderForModel(modelName: string): string | null {
    // 如果用户设置了默认 provider，使用该 provider
    if (this.secrets.defaultProvider && this.providers.has(this.secrets.defaultProvider)) {
      return this.secrets.defaultProvider
    }
    // 检查哪个 provider 配置了该模型作为 defaultModel
    for (const [name, secret] of Object.entries(this.secrets.providers)) {
      if (secret.defaultModel === modelName && this.providers.has(name)) {
        return name
      }
    }
    return null
  }

  /** 获取指定角色的 LanguageModel 实例 */
  getModel(role: ModelRole): LanguageModel {
    const modelName = this.currentModels[role]
    const providerName = this.resolveProviderName(modelName)

    if (!providerName) {
      // 未知模型,尝试直接用默认 provider
      const defaultProvider = this.providers.get('anthropic') ?? this.providers.get('openai')
      if (defaultProvider) {
        return defaultProvider(modelName) as LanguageModel
      }
      throw new Error(`模型 ${modelName} 不在已知目录中,且无可用 provider`)
    }

    const provider = this.providers.get(providerName)
    if (!provider) {
      // Provider 不可用,尝试降级
      const fallback = this.getFallback(role)
      if (fallback) return fallback
      throw new Error(`Provider ${providerName} 未配置或 API key 缺失`)
    }

    return provider(modelName) as LanguageModel
  }

  /** 获取降级模型 */
  private getFallback(role: ModelRole): LanguageModel | null {
    const currentModel = this.currentModels[role]
    const fallbackName = FALLBACK_CHAIN[currentModel]

    if (!fallbackName) return null

    const providerName = MODEL_PROVIDER_MAP[fallbackName]
    if (!providerName) return null

    const provider = this.providers.get(providerName)
    if (!provider) return null

    return provider(fallbackName) as LanguageModel
  }

  /**
   * 获取主模型或降级后的备用模型（公开接口，供 Executor/Planner 使用）
   * 优先返回主模型；若主模型 provider 不可用，沿 FALLBACK_CHAIN 逐级降级
   */
  getModelWithFallback(role: ModelRole): LanguageModel | null {
    try {
      return this.getModel(role)
    } catch {
      // 主模型不可用，沿降级链逐级尝试
      let modelName = this.currentModels[role]
      const visited = new Set<string>([modelName])

      while (true) {
        const fallbackName = FALLBACK_CHAIN[modelName]
        if (!fallbackName || visited.has(fallbackName)) return null
        visited.add(fallbackName)

        const providerName = MODEL_PROVIDER_MAP[fallbackName]
        if (!providerName) {
          modelName = fallbackName
          continue
        }

        const provider = this.providers.get(providerName)
        if (provider) return provider(fallbackName) as LanguageModel

        // 该降级的 provider 也不可用，继续往下一级
        modelName = fallbackName
      }
    }
  }

  /** 获取降级模型名称（公开接口，供 Executor 发出降级事件时使用） */
  getFallbackModelName(role: ModelRole): string | null {
    const currentModel = this.currentModels[role]
    return FALLBACK_CHAIN[currentModel] ?? null
  }

  /**
   * 获取异于主模型的降级模型。
   * getModelWithFallback 会先返回主模型本身，导致“降级”变成对同一模型的无意义重试；
   * 此方法沿 FALLBACK_CHAIN 跳过主模型，返回第一个 provider 可用的不同模型。
   */
  getDistinctFallbackModel(role: ModelRole): LanguageModel | null {
    let modelName = this.currentModels[role]
    const visited = new Set<string>([modelName])
    while (true) {
      const fallbackName = FALLBACK_CHAIN[modelName]
      if (!fallbackName || visited.has(fallbackName)) return null
      visited.add(fallbackName)
      const providerName =
        MODEL_PROVIDER_MAP[fallbackName] ?? this.resolveProviderName(fallbackName)
      if (providerName) {
        const provider = this.providers.get(providerName)
        if (provider) return provider(fallbackName) as LanguageModel
      }
      modelName = fallbackName
    }
  }

  /** 获取模型路由信息(用于成本计算) */
  getRouteInfo(role: ModelRole): ModelRoute {
    const modelName = this.currentModels[role]
    const route = this.buildModelRoute(modelName, role)
    if (route) return route
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

  /** 按模型名获取 LanguageModel（子智能体引擎指定模型时使用） */
  getModelByName(modelName: string): LanguageModel {
    const providerName = this.resolveProviderName(modelName)
    if (!providerName) {
      // 未知模型,尝试直接用默认 provider
      const defaultProvider = this.providers.get('anthropic') ?? this.providers.get('openai')
      if (defaultProvider) {
        return defaultProvider(modelName) as LanguageModel
      }
      throw new Error(`模型 ${modelName} 不在已知目录中,且无可用 provider`)
    }

    const provider = this.providers.get(providerName)
    if (!provider) {
      throw new Error(`Provider ${providerName} 未配置或 API key 缺失`)
    }

    return provider(modelName) as LanguageModel
  }

  /** 按模型名获取路由信息（引擎差异化模型的成本追踪），role 记为 'executor' */
  getRouteInfoForModel(modelName: string): ModelRoute {
    const route = this.buildModelRoute(modelName, 'executor')
    if (route) return route
    // 未知模型,返回默认值
    return {
      provider: 'anthropic',
      model: modelName,
      role: 'executor',
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

  /** 获取所有已知模型（含未配置 provider 的），用于 /model 命令展示 */
  getAllKnownModels(): Array<{
    name: string
    provider: string
    configured: boolean
    current: boolean
  }> {
    const currentExecutor = this.currentModels.executor
    return Object.entries(MODEL_PROVIDER_MAP).map(([name, provider]) => ({
      name,
      provider,
      configured: this.providers.has(provider),
      current: name === currentExecutor,
    }))
  }

  /** 检查指定 provider 是否已配置 API Key 并初始化 */
  isProviderConfigured(providerName: string): boolean {
    return this.providers.has(providerName)
  }

  /** 检查指定模型是否支持 tool calling（用于防止 toolless 模型被选为 executor） */
  modelSupportsTools(modelName: string): boolean {
    const providerName = MODEL_PROVIDER_MAP[modelName] ?? this.resolveProviderForModel(modelName)
    if (!providerName) return true // 未知模型保守返回 true，避免误拦
    const adapter = getProvider(providerName, this.secrets)
    if (!adapter) return true
    return adapter.supportsTools(modelName)
  }

  /** 获取所有可用 provider */
  getAvailableProviders(): string[] {
    return Array.from(this.providers.keys())
  }

  /** 获取当前可用的模型列表(基于已初始化的 provider + 适配器数据) */
  getAvailableModels(): Array<{ name: string; provider: string; current: boolean }> {
    const models: Array<{ name: string; provider: string; current: boolean }> = []
    const currentExecutor = this.currentModels.executor

    // 已知模型
    for (const [modelName, providerName] of Object.entries(MODEL_PROVIDER_MAP)) {
      if (this.providers.has(providerName)) {
        models.push({
          name: modelName,
          provider: providerName,
          current: modelName === currentExecutor,
        })
      }
    }

    // 自定义 provider 的用户配置模型
    for (const [name, secret] of Object.entries(this.secrets.providers)) {
      if (secret.defaultModel && this.providers.has(name)) {
        const alreadyListed = models.some((m) => m.name === secret.defaultModel)
        if (!alreadyListed) {
          models.push({
            name: secret.defaultModel,
            provider: name,
            current: secret.defaultModel === currentExecutor,
          })
        }
      }
    }

    return models
  }

  /** 获取上下文窗口大小（委托给适配器） */
  getContextWindow(role: ModelRole): number {
    const modelName = this.currentModels[role]
    const providerName = MODEL_PROVIDER_MAP[modelName] ?? this.resolveProviderForModel(modelName)
    if (providerName) {
      const adapter = getProvider(providerName, this.secrets)
      if (adapter) return adapter.getContextWindow(modelName)
    }
    return 200000 // fallback
  }

  getCostTracker(): CostTracker {
    return this.costTracker
  }

  /** 检查是否有至少一个可用 provider */
  hasAvailableProvider(): boolean {
    return this.providers.size > 0
  }

  /** 重新初始化 providers（用于用户在 TUI 中保存 API Key 后重新加载） */
  reinit(secrets: SecretsConfig): void {
    this.secrets = secrets
    this.providers.clear()
    this.initProviders()
    this.applyConfigModels()
  }
}

/**
 * 单元测试: ModelRouter 模型路由
 * 验证 provider 初始化、模型降级、FALLBACK_CHAIN 完整性
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test'
import type { NexusConfig } from '../../src/agent/types'

// ─── mock 外部依赖 ────────────────────────────────────────────────────────────

// 控制 provider 可用性
let availableProviderNames: string[] = ['anthropic']

;(mock as any).module('../../src/router/providers/index', () => ({
  getAvailableProviders: () => {
    const all = [
      {
        name: 'anthropic',
        isAvailable: () => availableProviderNames.includes('anthropic'),
        getDefaultModel: () => 'claude-sonnet-4-20250514',
        getContextWindow: () => 200000,
        supportsTools: () => true,
      },
      {
        name: 'openai',
        isAvailable: () => availableProviderNames.includes('openai'),
        getDefaultModel: () => 'gpt-4o',
        getContextWindow: () => 128000,
        supportsTools: () => true,
      },
      {
        name: 'deepseek',
        isAvailable: () => availableProviderNames.includes('deepseek'),
        getDefaultModel: () => 'deepseek-chat',
        getContextWindow: () => 65536,
        supportsTools: (m: string) => m === 'deepseek-chat',
      },
      {
        name: 'custom',
        isAvailable: () => availableProviderNames.includes('custom'),
        getDefaultModel: () => 'default',
        getContextWindow: () => 128000,
        supportsTools: () => true,
      },
    ]
    return all.filter((p) => p.isAvailable())
  },
  getProvider: (name: string) => {
    const adapters: Record<string, any> = {
      anthropic: {
        name: 'anthropic',
        getDefaultModel: () => 'claude-sonnet-4-20250514',
        getContextWindow: () => 200000,
        supportsTools: () => true,
      },
      openai: {
        name: 'openai',
        getDefaultModel: () => 'gpt-4o',
        getContextWindow: () => 128000,
        supportsTools: () => true,
      },
      deepseek: {
        name: 'deepseek',
        getDefaultModel: () => 'deepseek-chat',
        getContextWindow: () => 65536,
        supportsTools: (m: string) => m === 'deepseek-chat',
      },
      custom: {
        name: 'custom',
        getDefaultModel: () => 'default',
        getContextWindow: () => 128000,
        supportsTools: () => true,
      },
    }
    return adapters[name]
  },
}))
// Mock AI SDK - 让 createAnthropic/createOpenAI 返回可调用工厂
;(mock as any).module('@ai-sdk/anthropic', () => ({
  createAnthropic: (_opts: any) => {
    const factory = (model: string) => ({ modelId: model, provider: 'anthropic.mock' })
    return factory
  },
}))

;(mock as any).module('@ai-sdk/openai', () => ({
  createOpenAI: (_opts: any) => {
    const factory = (model: string) => ({ modelId: model, provider: 'openai.mock' })
    return factory
  },
}))
// Mock config-secrets
;(mock as any).module('../../src/config-secrets', () => ({
  getEffectiveApiKey: (providerName: string, _envVarName: string, secrets: any) => {
    if (availableProviderNames.includes(providerName)) return 'mock-api-key'
    return secrets?.providers?.[providerName]?.apiKey || undefined
  },
}))

import { CostTracker } from '../../src/router/CostTracker'
import { FALLBACK_CHAIN, ModelRouter } from '../../src/router/ModelRouter'

function createDefaultConfig(): NexusConfig {
  return {
    models: {
      planner: 'auto',
      executor: 'auto',
      summarizer: 'auto',
      verifier: 'auto',
      providers: {
        anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY', defaultModel: 'claude-sonnet-4-20250514' },
        openai: { apiKeyEnv: 'OPENAI_API_KEY', defaultModel: 'gpt-4o' },
        deepseek: {
          apiKeyEnv: 'DEEPSEEK_API_KEY',
          baseUrl: 'https://api.deepseek.com',
          defaultModel: 'deepseek-chat',
        },
        custom: { apiKeyEnv: 'CUSTOM_API_KEY', defaultModel: '' },
      },
    },
    permissions: { mode: 'ask' },
    limits: {
      maxSessionCost: 5,
      bashTimeout: 30,
      maxReadLines: 2000,
      maxIterations: 50,
      maxOutputBytes: 102400,
    },
    context: { budgetRatio: 0.8, recentTurnsKeep: 5 },
    checkpoint: { autoCheckpoint: true, branch: 'nexus/checkpoints' },
  }
}

describe('ModelRouter', () => {
  beforeEach(() => {
    availableProviderNames = ['anthropic']
  })

  it('初始化时正确加载 providers', () => {
    availableProviderNames = ['anthropic', 'openai', 'deepseek']
    const router = new ModelRouter(createDefaultConfig(), new CostTracker())
    const providers = router.getAvailableProviders()

    expect(providers).toContain('anthropic')
    expect(providers).toContain('openai')
    expect(providers).toContain('deepseek')
  })

  it('getModel("planner") 返回有效的 LanguageModel', () => {
    availableProviderNames = ['anthropic']
    const router = new ModelRouter(createDefaultConfig(), new CostTracker())
    const model = router.getModel('planner')
    expect(model).toBeDefined()
    expect((model as any).modelId).toBeDefined()
  })

  it('getModel("executor") 返回有效的 LanguageModel', () => {
    availableProviderNames = ['anthropic']
    const router = new ModelRouter(createDefaultConfig(), new CostTracker())
    const model = router.getModel('executor')
    expect(model).toBeDefined()
    expect((model as any).modelId).toBeDefined()
  })

  it('FALLBACK_CHAIN 包含合理的降级路径', () => {
    // claude-sonnet 应降级到 deepseek-chat
    expect(FALLBACK_CHAIN['claude-sonnet-4-20250514']).toBe('deepseek-chat')
    // deepseek-chat 应降级到 gpt-4o-mini
    expect(FALLBACK_CHAIN['deepseek-chat']).toBe('gpt-4o-mini')
    // gpt-4o 应降级到 deepseek-chat
    expect(FALLBACK_CHAIN['gpt-4o']).toBe('deepseek-chat')
    // 所有降级目标应是已知模型
    const knownModels = [
      'claude-sonnet-4-20250514',
      'claude-haiku-3-5',
      'gpt-4o',
      'gpt-4o-mini',
      'deepseek-chat',
      'deepseek-reasoner',
    ]
    for (const fallback of Object.values(FALLBACK_CHAIN)) {
      expect(knownModels).toContain(fallback)
    }
  })

  it('getAvailableProviders() 基于可用 adapter 返回正确的 provider 列表', () => {
    availableProviderNames = ['deepseek'] // 只有 deepseek
    const router = new ModelRouter(createDefaultConfig(), new CostTracker())
    const providers = router.getAvailableProviders()
    expect(providers).toContain('deepseek')
    expect(providers).not.toContain('anthropic')
    expect(providers).not.toContain('openai')
  })

  it('不存在的 provider 时 getModel 抛异常', () => {
    availableProviderNames = [] // 无任何 provider
    const router = new ModelRouter(createDefaultConfig(), new CostTracker())
    router.setModel('executor', 'unknown-model-xyz')
    expect(() => router.getModel('executor')).toThrow()
  })

  it('setModel/getCurrentModel 正确切换模型', () => {
    availableProviderNames = ['anthropic', 'openai']
    const router = new ModelRouter(createDefaultConfig(), new CostTracker())

    router.setModel('executor', 'gpt-4o')
    expect(router.getCurrentModel('executor')).toBe('gpt-4o')
  })

  it('getRouteInfo() 返回正确的路由信息', () => {
    availableProviderNames = ['anthropic']
    const router = new ModelRouter(createDefaultConfig(), new CostTracker())

    const route = router.getRouteInfo('executor')
    expect(route).toBeDefined()
    expect(route.provider).toBeDefined()
    expect(route.model).toBeDefined()
    expect(typeof route.costPer1kInput).toBe('number')
    expect(typeof route.costPer1kOutput).toBe('number')
    expect(typeof route.contextWindow).toBe('number')
  })

  it('getRouteInfo() 成本参数随实际模型动态变化（非硬编码）', () => {
    availableProviderNames = ['deepseek'] // 只有 deepseek，executor 从 claude 降级到 deepseek-chat
    const router = new ModelRouter(createDefaultConfig(), new CostTracker())

    const route = router.getRouteInfo('executor')
    expect(route.model).toBe('deepseek-chat')
    expect(route.provider).toBe('deepseek')
    // 应为 deepseek-chat 的成本，而非硬编码的 anthropic 价格（0.003 / 0.015）
    expect(route.costPer1kInput).toBe(0.00027)
    expect(route.costPer1kOutput).toBe(0.0011)
  })

  it('getContextWindow() 返回有效数值', () => {
    availableProviderNames = ['anthropic']
    const router = new ModelRouter(createDefaultConfig(), new CostTracker())
    const ctx = router.getContextWindow('executor')
    expect(ctx).toBeGreaterThan(0)
  })

  it('getModelWithFallback() 在主 provider 不可用时降级', () => {
    availableProviderNames = ['deepseek'] // 只有 deepseek
    const router = new ModelRouter(createDefaultConfig(), new CostTracker())
    // planner 默认 auto，会选 deepseek-chat（第一个可用高能力 provider）
    const model = router.getModelWithFallback('planner')
    expect(model).not.toBeNull()
    if (model) {
      expect((model as any).modelId).toBeDefined()
    }
  })

  it('getFallbackModelName() 返回降级模型名', () => {
    availableProviderNames = ['anthropic']
    const router = new ModelRouter(createDefaultConfig(), new CostTracker())
    const fallback = router.getFallbackModelName('executor')
    // executor 默认 claude-sonnet-4-20250514，降级到 deepseek-chat
    expect(fallback).toBe('deepseek-chat')
  })

  it('使用 secrets 配置初始化 provider', () => {
    availableProviderNames = ['anthropic']
    const secrets = {
      providers: {
        anthropic: { apiKey: 'secret-anthropic-key' },
      },
    }
    const router = new ModelRouter(createDefaultConfig(), new CostTracker(), secrets)
    const providers = router.getAvailableProviders()
    expect(providers).toContain('anthropic')
  })

  it('getAvailableModels() 返回模型列表', () => {
    availableProviderNames = ['anthropic']
    const router = new ModelRouter(createDefaultConfig(), new CostTracker())
    const models = router.getAvailableModels()
    expect(Array.isArray(models)).toBe(true)
    // anthropic 可用时应有 claude 模型
    const claudeModels = models.filter((m) => m.provider === 'anthropic')
    expect(claudeModels.length).toBeGreaterThan(0)
  })

  it('getCostTracker() 返回 CostTracker 实例', () => {
    const ct = new CostTracker()
    availableProviderNames = ['anthropic']
    const router = new ModelRouter(createDefaultConfig(), ct)
    expect(router.getCostTracker()).toBe(ct)
  })
})

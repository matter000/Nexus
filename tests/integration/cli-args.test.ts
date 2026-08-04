/**
 * 集成测试: CLI --model 和 --provider 参数覆盖
 * 验证 args.model 和 args.provider 正确应用到 config 中
 */

import { describe, it, expect } from 'bun:test'
import { parseArgs } from '../../src/cli/args'
import { loadConfig } from '../../src/config'

describe('CLI args --model / --provider 覆盖逻辑', () => {
  // 复用 index.ts 中的覆盖逻辑，提取为可测试函数
  function applyCliOverrides(
    config: ReturnType<typeof getDefaultConfig>,
    args: { model?: string; provider?: string }
  ) {
    if (args.model) {
      config.models.executor = args.model
      config.models.planner = args.model
    }
    if (args.provider) {
      const providerName = args.provider as keyof typeof config.models.providers
      const providerConf = config.models.providers[providerName]
      if (providerConf) {
        if (!args.model) {
          const providerDefaultModel = providerConf.defaultModel
          if (providerDefaultModel) {
            config.models.executor = providerDefaultModel
            config.models.planner = providerDefaultModel
          }
        }
      }
    }
    return config
  }

  function getDefaultConfig() {
    // 使用与 config.ts 一致的默认结构（简化版）
    return {
      models: {
        planner: 'auto',
        executor: 'auto',
        summarizer: 'auto',
        verifier: 'auto',
        providers: {
          anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY', defaultModel: 'claude-sonnet-4-20250514' },
          openai: { apiKeyEnv: 'OPENAI_API_KEY', defaultModel: 'gpt-4o' },
          deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-v4-flash' },
          custom: { apiKeyEnv: 'CUSTOM_API_KEY', baseUrl: '', defaultModel: '' },
        },
      },
      permissions: { mode: 'ask' as const },
      limits: { maxSessionCost: 5.0, bashTimeout: 30, maxReadLines: 2000, maxIterations: 50, maxOutputBytes: 102400 },
      context: { budgetRatio: 0.8, recentTurnsKeep: 5 },
      checkpoint: { autoCheckpoint: true, branch: 'nexus/checkpoints' },
    }
  }

  describe('--model 参数', () => {
    it('--model gpt-4o 覆盖 executor 和 planner', () => {
      const args = parseArgs(['--model', 'gpt-4o'])
      expect(args.model).toBe('gpt-4o')

      const config = getDefaultConfig()
      applyCliOverrides(config, args)
      expect(config.models.executor).toBe('gpt-4o')
      expect(config.models.planner).toBe('gpt-4o')
    })

    it('-m 简写形式生效', () => {
      const args = parseArgs(['-m', 'deepseek-chat'])
      expect(args.model).toBe('deepseek-chat')

      const config = getDefaultConfig()
      applyCliOverrides(config, args)
      expect(config.models.executor).toBe('deepseek-chat')
      expect(config.models.planner).toBe('deepseek-chat')
    })

    it('未提供 --model 时 config 保持 auto 默认值', () => {
      const args = parseArgs([])
      expect(args.model).toBeUndefined()

      const config = getDefaultConfig()
      applyCliOverrides(config, args)
      expect(config.models.executor).toBe('auto')
      expect(config.models.planner).toBe('auto')
    })
  })

  describe('--provider 参数', () => {
    it('--provider openai 使用 openai 默认模型', () => {
      const args = parseArgs(['--provider', 'openai'])
      expect(args.provider).toBe('openai')

      const config = getDefaultConfig()
      applyCliOverrides(config, args)
      expect(config.models.executor).toBe('gpt-4o')
      expect(config.models.planner).toBe('gpt-4o')
    })

    it('--provider deepseek 使用 deepseek 默认模型', () => {
      const args = parseArgs(['--provider', 'deepseek'])
      expect(args.provider).toBe('deepseek')

      const config = getDefaultConfig()
      applyCliOverrides(config, args)
      expect(config.models.executor).toBe('deepseek-v4-flash')
      expect(config.models.planner).toBe('deepseek-v4-flash')
    })

    it('-p 简写形式生效', () => {
      const args = parseArgs(['-p', 'anthropic'])
      expect(args.provider).toBe('anthropic')

      const config = getDefaultConfig()
      applyCliOverrides(config, args)
      expect(config.models.executor).toBe('claude-sonnet-4-20250514')
      expect(config.models.planner).toBe('claude-sonnet-4-20250514')
    })

    it('未提供 --provider 时 config 保持 auto 默认值', () => {
      const args = parseArgs([])
      expect(args.provider).toBeUndefined()

      const config = getDefaultConfig()
      applyCliOverrides(config, args)
      expect(config.models.executor).toBe('auto')
      expect(config.models.planner).toBe('auto')
    })

    it('未知 provider 不修改 config', () => {
      const args = parseArgs(['--provider', 'unknown-provider'])
      const config = getDefaultConfig()
      applyCliOverrides(config, args)
      // 未知 provider 不在 providers 中，不触发覆盖
      expect(config.models.executor).toBe('auto')
      expect(config.models.planner).toBe('auto')
    })
  })

  describe('--model 与 --provider 同时使用', () => {
    it('--model 优先级高于 --provider 默认模型', () => {
      const args = parseArgs(['--model', 'gpt-4o-mini', '--provider', 'openai'])
      expect(args.model).toBe('gpt-4o-mini')
      expect(args.provider).toBe('openai')

      const config = getDefaultConfig()
      applyCliOverrides(config, args)
      // --model 覆盖了 executor/planner，--provider 不再用默认模型覆盖
      expect(config.models.executor).toBe('gpt-4o-mini')
      expect(config.models.planner).toBe('gpt-4o-mini')
    })
  })
})

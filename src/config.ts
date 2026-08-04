/**
 * Nexus 配置加载器
 * 从 .nexus/config.toml 加载配置,合并默认值
 */

import { readFile } from 'fs/promises'
import { join } from 'path'
import { parse } from 'smol-toml'
import type { NexusConfig } from './agent/types'

const DEFAULT_CONFIG: NexusConfig = {
  models: {
    planner: 'auto',
    executor: 'auto',
    summarizer: 'auto',
    verifier: 'auto',
    providers: {
      anthropic: {
        apiKeyEnv: 'ANTHROPIC_API_KEY',
        defaultModel: 'claude-sonnet-4-20250514',
      },
      openai: {
        apiKeyEnv: 'OPENAI_API_KEY',
        defaultModel: 'gpt-4o',
      },
      deepseek: {
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        baseUrl: 'https://api.deepseek.com',
        defaultModel: 'deepseek-v4-flash',
      },
      custom: {
        apiKeyEnv: 'CUSTOM_API_KEY',
        baseUrl: '',
        defaultModel: '',
      },
    },
  },
  permissions: {
    mode: 'ask',
  },
  limits: {
    maxSessionCost: 5.0,
    bashTimeout: 30,
    maxReadLines: 2000,
    maxIterations: 50,
    maxOutputBytes: 102400,
    maxAutoRetries: 0,
  },
  context: {
    budgetRatio: 0.8,
    recentTurnsKeep: 5,
  },
  checkpoint: {
    autoCheckpoint: true,
    branch: 'nexus/checkpoints',
  },
}

/** 加载 .nexus/config.toml 并合并默认值 */
export async function loadConfig(projectRoot: string): Promise<NexusConfig> {
  const configPath = join(projectRoot, '.nexus', 'config.toml')

  try {
    const content = await readFile(configPath, 'utf-8')
    const raw = parse(content) as Record<string, unknown>
    const config = mergeConfig(raw)
    validateConfig(config)
    return config
  } catch {
    // 配置文件不存在,使用默认值
    return { ...DEFAULT_CONFIG }
  }
}

/** 配置验证：检查关键字段合法性 */
function validateConfig(config: NexusConfig): void {
  const warnings: string[] = []

  // limits 检查
  if (config.limits.maxSessionCost <= 0) {
    warnings.push('limits.max_session_cost 必须大于 0，已重置为默认值 5.0')
    config.limits.maxSessionCost = 5.0
  }
  if (config.limits.bashTimeout < 5) {
    warnings.push('limits.bash_timeout 不能小于 5 秒，已重置为默认值 30')
    config.limits.bashTimeout = 30
  }
  if (config.limits.maxIterations < 1) {
    warnings.push('limits.max_iterations 必须至少为 1，已重置为默认值 50')
    config.limits.maxIterations = 50
  }
  if (config.limits.maxReadLines < 100) {
    warnings.push('limits.max_read_lines 不能小于 100，已重置为默认值 2000')
    config.limits.maxReadLines = 2000
  }

  // context 检查
  if (config.context.budgetRatio <= 0 || config.context.budgetRatio > 1) {
    warnings.push('context.budget_ratio 必须在 0~1 之间，已重置为默认值 0.8')
    config.context.budgetRatio = 0.8
  }
  if (config.context.recentTurnsKeep < 1) {
    warnings.push('context.recent_turns_keep 必须至少为 1，已重置为默认值 5')
    config.context.recentTurnsKeep = 5
  }

  // permissions 检查
  const validModes = ['ask', 'auto-edit', 'auto-all', 'yolo']
  if (!validModes.includes(config.permissions.mode)) {
    warnings.push(`permissions.mode 无效: "${config.permissions.mode}"，已重置为 "ask"`)
    config.permissions.mode = 'ask'
  }

  // provider 配置检查
  for (const [name, provider] of Object.entries(config.models.providers)) {
    if (!provider.apiKeyEnv) {
      warnings.push(`Provider "${name}" 缺少 api_key_env 配置`)
    }
    if (!provider.defaultModel) {
      warnings.push(`Provider "${name}" 缺少 default_model 配置`)
    }
  }

  if (warnings.length > 0) {
    console.warn('[配置警告] 检测到以下配置问题：')
    for (const w of warnings) {
      console.warn(`  - ${w}`)
    }
  }
}

/** 将 TOML 原始数据合并到默认配置 */
function mergeConfig(raw: Record<string, unknown>): NexusConfig {
  const config = structuredClone(DEFAULT_CONFIG)

  // models
  const models = raw.models as Record<string, unknown> | undefined
  if (models) {
    if (typeof models.planner === 'string') config.models.planner = models.planner
    if (typeof models.executor === 'string') config.models.executor = models.executor
    if (typeof models.summarizer === 'string') config.models.summarizer = models.summarizer
    if (typeof models.verifier === 'string') config.models.verifier = models.verifier

    const providers = models.providers as Record<string, Record<string, string>> | undefined
    if (providers) {
      for (const [name, pConfig] of Object.entries(providers)) {
        const existing = config.models.providers[name]
        config.models.providers[name] = {
          // 保留默认值回退：TOML 省略字段时不覆盖为 undefined
          apiKeyEnv: pConfig.api_key_env ?? existing?.apiKeyEnv,
          baseUrl: pConfig.base_url ?? existing?.baseUrl,
          defaultModel: pConfig.default_model ?? existing?.defaultModel ?? '',
        }
      }
    }

    // 模型成本覆盖（新增/自定义模型的成本声明，优先于内置成本表）
    const costOverrides = models.cost_overrides as
      | Record<string, Record<string, number>>
      | undefined
    if (costOverrides) {
      config.models.costOverrides = {}
      for (const [modelName, cost] of Object.entries(costOverrides)) {
        if (
          typeof cost.cost_per_1k_input === 'number' &&
          typeof cost.cost_per_1k_output === 'number'
        ) {
          config.models.costOverrides[modelName] = {
            costPer1kInput: cost.cost_per_1k_input,
            costPer1kOutput: cost.cost_per_1k_output,
          }
        }
      }
    }
  }

  // permissions
  const permissions = raw.permissions as Record<string, string> | undefined
  if (permissions?.mode) {
    config.permissions.mode = permissions.mode as NexusConfig['permissions']['mode']
  }

  // limits
  const limits = raw.limits as Record<string, number> | undefined
  if (limits) {
    if (limits.max_session_cost) config.limits.maxSessionCost = limits.max_session_cost
    if (limits.bash_timeout) config.limits.bashTimeout = limits.bash_timeout
    if (limits.max_read_lines) config.limits.maxReadLines = limits.max_read_lines
    if (limits.max_iterations) config.limits.maxIterations = limits.max_iterations
    if (limits.max_output_bytes) config.limits.maxOutputBytes = limits.max_output_bytes
    if (limits.max_auto_retries !== undefined)
      config.limits.maxAutoRetries = limits.max_auto_retries
  }

  // context
  const context = raw.context as Record<string, number> | undefined
  if (context) {
    if (context.budget_ratio) config.context.budgetRatio = context.budget_ratio
    if (context.recent_turns_keep) config.context.recentTurnsKeep = context.recent_turns_keep
  }

  // checkpoint
  const checkpoint = raw.checkpoint as Record<string, unknown> | undefined
  if (checkpoint) {
    if (typeof checkpoint.auto_checkpoint === 'boolean')
      config.checkpoint.autoCheckpoint = checkpoint.auto_checkpoint
    if (typeof checkpoint.branch === 'string') config.checkpoint.branch = checkpoint.branch
  }

  return config
}

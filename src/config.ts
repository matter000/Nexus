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
      ollama: {
        baseUrl: 'http://localhost:11434',
        defaultModel: 'llama3',
      },
      deepseek: {
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        baseUrl: 'https://api.deepseek.com',
        defaultModel: 'deepseek-chat',
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
    return mergeConfig(raw)
  } catch {
    // 配置文件不存在,使用默认值
    return { ...DEFAULT_CONFIG }
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
        config.models.providers[name] = {
          apiKeyEnv: pConfig.api_key_env,
          baseUrl: pConfig.base_url,
          defaultModel: pConfig.default_model ?? config.models.providers[name]?.defaultModel ?? '',
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
    if (typeof checkpoint.auto_checkpoint === 'boolean') config.checkpoint.autoCheckpoint = checkpoint.auto_checkpoint
    if (typeof checkpoint.branch === 'string') config.checkpoint.branch = checkpoint.branch
  }

  return config
}

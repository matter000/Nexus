/**
 * API 密钥持久化管理
 * 存储于 .nexus/secrets.toml（已被 .gitignore 排除）
 * 优先级: 环境变量 > secrets.toml
 */

import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { parse, stringify } from 'smol-toml'

export interface ProviderSecret {
  apiKey: string
  baseUrl?: string
  defaultModel?: string
}

export interface SecretsConfig {
  providers: Record<string, ProviderSecret>
  /** 用户选择的默认 provider */
  defaultProvider?: string
  /** 用户选择的默认模型 */
  defaultModel?: string
}

const EMPTY_SECRETS: SecretsConfig = { providers: {} }

/** 获取 secrets 文件路径 */
function getSecretsPath(projectRoot: string): string {
  return join(projectRoot, '.nexus', 'secrets.toml')
}

/** 加载 secrets 配置 */
export async function loadSecrets(projectRoot: string): Promise<SecretsConfig> {
  try {
    const content = await readFile(getSecretsPath(projectRoot), 'utf-8')
    const raw = parse(content) as Record<string, unknown>
    return parseSecretsRaw(raw)
  } catch {
    return { ...EMPTY_SECRETS }
  }
}

/** 保存 secrets 配置 */
export async function saveSecrets(projectRoot: string, secrets: SecretsConfig): Promise<void> {
  const nexusDir = join(projectRoot, '.nexus')
  await mkdir(nexusDir, { recursive: true })

  const tomlObj: Record<string, unknown> = {}

  if (secrets.defaultProvider) tomlObj.default_provider = secrets.defaultProvider
  if (secrets.defaultModel) tomlObj.default_model = secrets.defaultModel

  for (const [name, provider] of Object.entries(secrets.providers)) {
    if (!provider.apiKey) continue
    tomlObj[`providers.${name}`] = {
      api_key: provider.apiKey,
      ...(provider.baseUrl ? { base_url: provider.baseUrl } : {}),
      ...(provider.defaultModel ? { default_model: provider.defaultModel } : {}),
    }
  }

  const content = `# Nexus API 密钥配置（此文件已被 .gitignore 排除，不会提交到版本控制）
# 优先级: 环境变量 > 此文件
${stringify(tomlObj)}`

  await writeFile(getSecretsPath(projectRoot), content, 'utf-8')
}

/** 解析 TOML 原始数据 */
function parseSecretsRaw(raw: Record<string, unknown>): SecretsConfig {
  const secrets: SecretsConfig = { providers: {} }

  if (typeof raw.default_provider === 'string') secrets.defaultProvider = raw.default_provider
  if (typeof raw.default_model === 'string') secrets.defaultModel = raw.default_model

  // smol-toml 会将 [providers.anthropic] 解析为嵌套对象
  const providers = raw.providers as Record<string, Record<string, string>> | undefined
  if (providers && typeof providers === 'object') {
    for (const [name, config] of Object.entries(providers)) {
      if (config && typeof config === 'object' && config.api_key) {
        secrets.providers[name] = {
          apiKey: config.api_key,
          baseUrl: config.base_url || undefined,
          defaultModel: config.default_model || undefined,
        }
      }
    }
  }

  return secrets
}

/**
 * 获取有效的 API Key（优先级: 环境变量 > secrets 文件）
 */
export function getEffectiveApiKey(
  providerName: string,
  envVarName: string,
  secrets: SecretsConfig
): string | undefined {
  // 环境变量优先
  const envKey = process.env[envVarName]
  if (envKey) return envKey

  // fallback 到 secrets 文件
  return secrets.providers[providerName]?.apiKey || undefined
}

/** 检测是否有任何可用的 API Key */
export function hasAnyApiKey(secrets: SecretsConfig): boolean {
  const envVars = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'CUSTOM_API_KEY']
  if (envVars.some((v) => !!process.env[v])) return true
  return Object.values(secrets.providers).some((p) => !!p.apiKey)
}

/** 获取所有 provider 的可用状态 */
export function getProviderStatus(secrets: SecretsConfig): Array<{
  name: string
  label: string
  envVar: string
  hasKey: boolean
  source: 'env' | 'secrets' | 'none'
}> {
  const providerDefs = [
    { name: 'anthropic', label: 'Anthropic (Claude)', envVar: 'ANTHROPIC_API_KEY' },
    { name: 'openai', label: 'OpenAI (GPT)', envVar: 'OPENAI_API_KEY' },
    { name: 'deepseek', label: 'DeepSeek', envVar: 'DEEPSEEK_API_KEY' },
    { name: 'custom', label: '自定义 (OpenAI 兼容)', envVar: 'CUSTOM_API_KEY' },
  ]

  return providerDefs.map((def) => {
    if (process.env[def.envVar]) {
      return { ...def, hasKey: true, source: 'env' as const }
    }
    if (secrets.providers[def.name]?.apiKey) {
      return { ...def, hasKey: true, source: 'secrets' as const }
    }
    return { ...def, hasKey: false, source: 'none' as const }
  })
}

/** 掩码显示 API Key */
export function maskApiKey(key: string): string {
  if (key.length <= 8) return '****'
  return `${key.slice(0, 4)}****${key.slice(-4)}`
}

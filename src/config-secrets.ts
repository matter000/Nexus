/**
 * API 密钥持久化管理
 * 存储于 .nexus/secrets.toml（已被 .gitignore 排除）
 * 优先级: 环境变量 > secrets.toml
 */

import { readFile, writeFile, mkdir, rename, chmod } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import { parse, stringify } from 'smol-toml'

export interface ProviderSecret {
  apiKey: string
  baseUrl?: string
  defaultModel?: string
  /** 兼容模式：自定义 provider 走 OpenAI 还是 Anthropic 协议（缺省视为 openai） */
  compatibility?: 'openai' | 'anthropic'
  /** 可选显示名（用户在添加流程中未输入则为 undefined，面板用 key 兜底） */
  label?: string
}

export interface SecretsConfig {
  providers: Record<string, ProviderSecret>
  /** 用户选择的默认 provider */
  defaultProvider?: string
  /** 用户选择的默认模型 */
  defaultModel?: string
  /** 上次退出前使用的模型（启动时恢复） */
  lastModel?: string
}

const EMPTY_SECRETS: SecretsConfig = { providers: {} }

/**
 * 获取全局 secrets 文件路径
 * API Key 是用户级配置,存储在 ~/.nexus/secrets.toml,所有项目共享
 */
function getGlobalSecretsPath(): string {
  return join(homedir(), '.nexus', 'secrets.toml')
}

/** 获取项目级 secrets 文件路径(兼容旧配置) */
function getProjectSecretsPath(projectRoot: string): string {
  return join(projectRoot, '.nexus', 'secrets.toml')
}

/** 加载 secrets 配置(优先全局,回退项目级) */
export async function loadSecrets(projectRoot: string): Promise<SecretsConfig> {
  // 优先读取全局配置
  try {
    const content = await readFile(getGlobalSecretsPath(), 'utf-8')
    const raw = parse(content) as Record<string, unknown>
    const secrets = parseSecretsRaw(raw)
    if (Object.keys(secrets.providers).length > 0) return secrets
  } catch { /* 全局配置不存在,继续 */ }

  // 回退到项目级配置(兼容旧版本)
  try {
    const content = await readFile(getProjectSecretsPath(projectRoot), 'utf-8')
    const raw = parse(content) as Record<string, unknown>
    return parseSecretsRaw(raw)
  } catch {
    return { ...EMPTY_SECRETS }
  }
}

/** 保存 secrets 配置(写入全局路径 ~/.nexus/secrets.toml) */
export async function saveSecrets(_projectRoot: string, secrets: SecretsConfig): Promise<void> {
  const globalPath = getGlobalSecretsPath()
  const nexusDir = join(homedir(), '.nexus')
  await mkdir(nexusDir, { recursive: true })

  const tomlObj: Record<string, unknown> = {}

  if (secrets.defaultProvider) tomlObj.default_provider = secrets.defaultProvider
  if (secrets.defaultModel) tomlObj.default_model = secrets.defaultModel
  if (secrets.lastModel) tomlObj.last_model = secrets.lastModel

  // 使用嵌套对象结构,确保 TOML 输出为 [providers.anthropic] 格式
  const providersObj: Record<string, unknown> = {}
  for (const [name, provider] of Object.entries(secrets.providers)) {
    if (!provider.apiKey) continue
    providersObj[name] = {
      api_key: provider.apiKey,
      ...(provider.baseUrl ? { base_url: provider.baseUrl } : {}),
      ...(provider.defaultModel ? { default_model: provider.defaultModel } : {}),
      ...(provider.compatibility ? { compatibility: provider.compatibility } : {}),
      ...(provider.label ? { label: provider.label } : {}),
    }
  }
  if (Object.keys(providersObj).length > 0) {
    tomlObj.providers = providersObj
  }

  const content = `# Nexus API 密钥配置（全局配置,所有项目共享）
# 优先级: 环境变量 > 此文件
${stringify(tomlObj)}`

  // 原子写入：先写临时文件再 rename，避免中断导致 secrets 文件损坏
  const tmpPath = `${globalPath}.tmp-${Date.now()}`
  await writeFile(tmpPath, content, 'utf-8')
  // 设置 0600 权限（仅所有者可读写），防止 API Key 泄露
  await chmod(tmpPath, 0o600)
  await rename(tmpPath, globalPath)
}

/** 解析 TOML 原始数据 */
function parseSecretsRaw(raw: Record<string, unknown>): SecretsConfig {
  const secrets: SecretsConfig = { providers: {} }

  if (typeof raw.default_provider === 'string') secrets.defaultProvider = raw.default_provider
  if (typeof raw.default_model === 'string') secrets.defaultModel = raw.default_model
  if (typeof raw.last_model === 'string') secrets.lastModel = raw.last_model

  // smol-toml 会将 [providers.anthropic] 解析为嵌套对象
  const providers = raw.providers as Record<string, Record<string, unknown>> | undefined
  if (providers && typeof providers === 'object') {
    for (const [name, config] of Object.entries(providers)) {
      if (config && typeof config === 'object' && config.api_key) {
        const compatRaw = config.compatibility
        const compatibility =
          compatRaw === 'openai' || compatRaw === 'anthropic' ? compatRaw : undefined
        secrets.providers[name] = {
          apiKey: config.api_key as string,
          baseUrl: (config.base_url as string) || undefined,
          defaultModel: (config.default_model as string) || undefined,
          compatibility,
          label: typeof config.label === 'string' ? config.label : undefined,
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

/** 内置 provider 名称集合（不可作为自定义条目键） */
const BUILTIN_PROVIDER_NAMES = new Set(['anthropic', 'openai', 'deepseek', 'google', 'openrouter'])

/**
 * 判断 provider 键名是否为"自定义"条目（非内置 provider）。
 * 旧 `custom` 键也视为自定义（按 openai 兼容处理）。
 */
export function isCustomProviderName(name: string): boolean {
  return !BUILTIN_PROVIDER_NAMES.has(name)
}

/** 自定义模型条目（用于面板列出可切换/可删除项） */
export interface CustomModelEntry {
  /** secrets.providers 中的键名 */
  key: string
  /** 显示名（label 优先，否则用 key） */
  label: string
  apiKey: string
  baseUrl?: string
  defaultModel?: string
  compatibility: 'openai' | 'anthropic'
}

/**
 * 获取所有自定义模型条目（排除内置 provider）。
 * 仅返回有 apiKey 的条目。
 */
export function getCustomModelEntries(secrets: SecretsConfig): CustomModelEntry[] {
  const entries: CustomModelEntry[] = []
  for (const [key, secret] of Object.entries(secrets.providers)) {
    if (!isCustomProviderName(key)) continue
    if (!secret.apiKey) continue
    entries.push({
      key,
      label: secret.label || key,
      apiKey: secret.apiKey,
      baseUrl: secret.baseUrl,
      defaultModel: secret.defaultModel,
      compatibility: secret.compatibility ?? 'openai',
    })
  }
  return entries
}

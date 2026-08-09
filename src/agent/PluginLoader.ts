/**
 * 插件加载器（能力分发层）
 *
 * 插件 = skills + MCP server 配置的打包单元（对齐 2026 年 Agent 生态共识：
 * MCP 管"连接外部系统"，Skill 管"传授做事方法"，Plugin 管"打包分发"）。
 *
 * 目录约定（convention over configuration）：
 * ```
 * .nexus/plugins/<plugin-name>/
 * ├── plugin.toml          # 清单：[plugin] 元数据 + 可选 [[mcp_servers]]
 * └── skills/              # 可选：插件技能（目录式 SKILL.md 或扁平 .md）
 *     └── <skill-name>/SKILL.md
 * ```
 *
 * plugin.toml 示例：
 * ```toml
 * [plugin]
 * name = "my-toolkit"
 * description = "团队工具包"
 * version = "1.0.0"
 *
 * [[mcp_servers]]
 * name = "sqlite"
 * command = "npx"
 * args = ["-y", "@modelcontextprotocol/server-sqlite", "./data.db"]
 * ```
 *
 * 容错：清单缺失/损坏的插件跳过并告警，绝不阻塞启动。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { parse } from 'smol-toml'
import type { ExternalServerConfig } from '../tools/external'

export interface PluginManifest {
  name: string
  description: string
  version: string
  /** 插件目录绝对路径 */
  dir: string
  /** 插件技能目录绝对路径（不存在时为 undefined） */
  skillsDir?: string
  /** 插件声明的 MCP server 配置 */
  mcpServers: ExternalServerConfig[]
}

export interface LoadedPlugins {
  plugins: PluginManifest[]
  /** 所有插件的技能目录（供 SkillLibrary.addSkillsDir） */
  skillsDirs: string[]
  /** 所有插件的 MCP server 配置（合并进 ExternalMCPManager） */
  mcpServers: ExternalServerConfig[]
}

/** 插件名清洗：仅保留字母数字连字符，防路径穿越 */
function sanitizePluginName(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'unnamed-plugin'
  )
}

/**
 * 扫描 .nexus/plugins/ 加载全部插件。
 * 单个插件损坏不影响其他插件与主流程。
 */
export function loadPlugins(projectRoot: string): LoadedPlugins {
  const pluginsRoot = join(projectRoot, '.nexus', 'plugins')
  const result: LoadedPlugins = { plugins: [], skillsDirs: [], mcpServers: [] }

  if (!existsSync(pluginsRoot)) return result

  let entries: string[]
  try {
    entries = readdirSync(pluginsRoot)
  } catch {
    return result
  }

  const seenServerNames = new Set<string>()

  for (const entry of entries) {
    const pluginDir = join(pluginsRoot, entry)
    try {
      if (!statSync(pluginDir).isDirectory()) continue
    } catch {
      continue
    }

    const manifest = loadPluginManifest(pluginDir, entry)
    if (!manifest) continue

    // MCP server 命名冲突：先加载的插件优先，冲突项跳过并告警
    const uniqueServers = manifest.mcpServers.filter((s) => {
      if (seenServerNames.has(s.name)) {
        console.warn(
          `[Plugin] 插件 "${manifest.name}" 的 MCP server "${s.name}" 与已有配置重名，已跳过`,
        )
        return false
      }
      seenServerNames.add(s.name)
      return true
    })
    manifest.mcpServers = uniqueServers

    result.plugins.push(manifest)
    if (manifest.skillsDir) result.skillsDirs.push(manifest.skillsDir)
    result.mcpServers.push(...uniqueServers)
  }

  return result
}

/** 解析单个插件清单；损坏时返回 null（调用方跳过） */
function loadPluginManifest(pluginDir: string, dirName: string): PluginManifest | null {
  const manifestPath = join(pluginDir, 'plugin.toml')
  if (!existsSync(manifestPath)) {
    console.warn(`[Plugin] "${dirName}" 缺少 plugin.toml，已跳过`)
    return null
  }

  let raw: Record<string, unknown>
  try {
    raw = parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>
  } catch (err) {
    console.warn(
      `[Plugin] "${dirName}" 的 plugin.toml 解析失败，已跳过: ${err instanceof Error ? err.message : String(err)}`,
    )
    return null
  }

  const meta = (raw.plugin ?? {}) as Record<string, unknown>
  const name = sanitizePluginName(typeof meta.name === 'string' ? meta.name : dirName)
  const description = typeof meta.description === 'string' ? meta.description : ''
  const version = typeof meta.version === 'string' ? meta.version : '0.0.0'

  // [[mcp_servers]]：与 config.toml 同构（stdio 用 command/args/env，远程用 url）
  const mcpServers: ExternalServerConfig[] = []
  const servers = raw.mcp_servers
  if (Array.isArray(servers)) {
    for (const s of servers) {
      const server = normalizeServerConfig(s)
      if (server) mcpServers.push(server)
    }
  }

  // skills/ 目录：存在才登记
  const skillsDir = join(pluginDir, 'skills')
  const manifest: PluginManifest = {
    name,
    description,
    version,
    dir: pluginDir,
    mcpServers,
  }
  if (existsSync(skillsDir)) {
    try {
      if (statSync(skillsDir).isDirectory()) manifest.skillsDir = skillsDir
    } catch {
      /* 不可读则不登记 */
    }
  }

  return manifest
}

/** 规范化 MCP server 条目：command(stdio) 或 url(HTTP) 至少一个 */
function normalizeServerConfig(s: unknown): ExternalServerConfig | null {
  if (typeof s !== 'object' || s === null) return null
  const cfg = s as Record<string, unknown>
  if (typeof cfg.name !== 'string' || cfg.name.trim() === '') return null

  const hasStdio = typeof cfg.command === 'string' && cfg.command.trim() !== ''
  const hasHttp = typeof cfg.url === 'string' && cfg.url.trim() !== ''
  if (!hasStdio && !hasHttp) return null

  return {
    name: cfg.name,
    ...(hasStdio ? { command: cfg.command as string } : {}),
    args: Array.isArray(cfg.args) ? cfg.args.filter((a): a is string => typeof a === 'string') : [],
    ...(cfg.env && typeof cfg.env === 'object' ? { env: cfg.env as Record<string, string> } : {}),
    ...(hasHttp ? { url: cfg.url as string } : {}),
  }
}

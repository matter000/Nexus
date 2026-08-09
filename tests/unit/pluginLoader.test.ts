/**
 * 单元测试: PluginLoader 插件加载器
 * 覆盖：plugin.toml 解析（元数据 + stdio/HTTP MCP 配置）、skills 目录发现、
 * 损坏插件跳过、空目录容错、MCP server 重名去重。
 */

import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadPlugins } from '../../src/agent/PluginLoader'

// 注意：本文件依赖真实 smol-toml，而 orchestrator.test.ts 的 mock.module 会跨文件泄漏
// （bun 已知限制 oven-sh/bun#7823），因此本文件必须独立进程运行（见 package.json test:unit:skillplugin），
// 聚合套件通过测试名前缀 "SkillPlugin" 排除。

const tmpRoot = mkdtempSync(join(tmpdir(), 'nexus-plugin-'))

function writePlugin(
  name: string,
  toml: string,
  opts: { skills?: Record<string, string> } = {},
): void {
  const dir = join(tmpRoot, '.nexus', 'plugins', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'plugin.toml'), toml, 'utf-8')
  for (const [skillName, content] of Object.entries(opts.skills ?? {})) {
    const skillDir = join(dir, 'skills', skillName)
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), content, 'utf-8')
  }
}

function safeRm(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    /* Windows 残留无害 */
  }
}

afterAll(() => {
  safeRm(tmpRoot)
})

describe('SkillPlugin: PluginLoader', () => {
  it('无 plugins 目录时返回空结果', () => {
    const result = loadPlugins(join(tmpRoot, 'empty-proj'))
    expect(result.plugins).toEqual([])
    expect(result.skillsDirs).toEqual([])
    expect(result.mcpServers).toEqual([])
  })

  it('解析清单元数据 + stdio/HTTP MCP 配置 + skills 目录', () => {
    writePlugin(
      'my-toolkit',
      [
        '[plugin]',
        'name = "my-toolkit"',
        'description = "团队工具包"',
        'version = "1.2.0"',
        '',
        '[[mcp_servers]]',
        'name = "sqlite"',
        'command = "npx"',
        'args = ["-y", "@modelcontextprotocol/server-sqlite"]',
        '',
        '[[mcp_servers]]',
        'name = "remote-api"',
        'url = "https://mcp.example.com/sse"',
      ].join('\n'),
      {
        skills: {
          'commit-flow':
            '---\nname: commit-flow\ndescription: 提交流程\nstatus: active\n---\n\n正文',
        },
      },
    )

    const result = loadPlugins(tmpRoot)
    expect(result.plugins.length).toBe(1)

    const plugin = result.plugins[0]
    expect(plugin.name).toBe('my-toolkit')
    expect(plugin.description).toBe('团队工具包')
    expect(plugin.version).toBe('1.2.0')
    expect(plugin.skillsDir).toBeDefined()

    // stdio server
    const stdio = plugin.mcpServers.find((s) => s.name === 'sqlite')
    expect(stdio?.command).toBe('npx')
    expect(stdio?.args).toEqual(['-y', '@modelcontextprotocol/server-sqlite'])

    // HTTP server
    const http = plugin.mcpServers.find((s) => s.name === 'remote-api')
    expect(http?.url).toBe('https://mcp.example.com/sse')

    // 技能目录汇入
    expect(result.skillsDirs.length).toBe(1)
    expect(result.mcpServers.length).toBe(2)
  })

  it('缺少 plugin.toml 的目录被跳过，不影响其他插件', () => {
    const root = join(tmpRoot, 'broken-proj')
    // 无清单的坏插件
    mkdirSync(join(root, '.nexus', 'plugins', 'bad-plugin'), { recursive: true })
    // 正常插件
    const goodDir = join(root, '.nexus', 'plugins', 'good-plugin')
    mkdirSync(goodDir, { recursive: true })
    writeFileSync(
      join(goodDir, 'plugin.toml'),
      '[plugin]\nname = "good-plugin"\ndescription = ""\nversion = "0.1.0"\n',
      'utf-8',
    )

    const result = loadPlugins(root)
    expect(result.plugins.length).toBe(1)
    expect(result.plugins[0].name).toBe('good-plugin')
  })

  it('跨插件 MCP server 重名时先加载者优先', () => {
    const root = join(tmpRoot, 'dup-proj')
    const mk = (plugin: string, serverName: string) => {
      const dir = join(root, '.nexus', 'plugins', plugin)
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'plugin.toml'),
        [
          '[plugin]',
          `name = "${plugin}"`,
          'version = "0.1.0"',
          '',
          '[[mcp_servers]]',
          `name = "${serverName}"`,
          'command = "echo"',
        ].join('\n'),
        'utf-8',
      )
    }
    mk('aaa-first', 'shared-server')
    mk('zzz-second', 'shared-server')

    const result = loadPlugins(root)
    expect(result.plugins.length).toBe(2)
    // 重名 server 只保留一份
    const shared = result.mcpServers.filter((s) => s.name === 'shared-server')
    expect(shared.length).toBe(1)
  })
})

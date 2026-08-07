/**
 * 单元测试: 子智能体引擎注册表
 * 验证内置引擎完整性、用户配置合并（覆盖/新增/告警）
 *
 * 注意：本文件不 mock 任何模块（ModelRouter 相关测试见 router.test.ts，
 * 模块级 mock 会污染同进程其他测试文件）。
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import {
  BUILTIN_ENGINES,
  AgentEngineRegistry,
  type AgentEngineDef,
} from '../../src/agent/AgentEngine'

describe('BUILTIN_ENGINES 内置引擎', () => {
  it('包含 4 个默认引擎且名字唯一', () => {
    const names = BUILTIN_ENGINES.map((e) => e.name)
    expect(names).toEqual(['explorer', 'coder', 'reviewer', 'researcher'])
    expect(new Set(names).size).toBe(names.length)
  })

  it('每个引擎字段合法：描述与提示词非空、写权限与迭代上限明确', () => {
    for (const engine of BUILTIN_ENGINES) {
      expect(engine.description.length).toBeGreaterThan(0)
      expect(engine.systemPrompt.length).toBeGreaterThan(0)
      expect(typeof engine.writable).toBe('boolean')
      expect(engine.maxIterations).toBeGreaterThan(0)
      // 只读引擎不允许出现在白名单之外
      if (!engine.writable) {
        expect(engine.tools).not.toContain('edit_file')
        expect(engine.tools).not.toContain('create_file')
      }
    }
  })

  it('coder 引擎声明可写且工具白名单含编辑类工具', () => {
    const coder = BUILTIN_ENGINES.find((e) => e.name === 'coder')!
    expect(coder.writable).toBe(true)
    expect(coder.tools).toContain('edit_file')
    expect(coder.tools).toContain('bash')
  })
})

describe('AgentEngineRegistry 注册表', () => {
  let registry: AgentEngineRegistry

  beforeEach(() => {
    registry = new AgentEngineRegistry()
  })

  it('默认注册全部内置引擎', () => {
    expect(registry.getNames()).toHaveLength(4)
    expect(registry.has('explorer')).toBe(true)
    expect(registry.get('reviewer')).toBeDefined()
  })

  it('register 整体替换同名引擎', () => {
    registry.register({
      name: 'explorer',
      description: '自定义',
      systemPrompt: '自定义提示词',
      writable: true,
      maxIterations: 3,
    })
    const engine = registry.get('explorer')!
    expect(engine.maxIterations).toBe(3)
    expect(engine.writable).toBe(true)
  })

  it('mergeUserConfig 同名引擎字段级覆盖：未配置字段沿用内置值', () => {
    const warnings = registry.mergeUserConfig([
      { name: 'explorer', description: '改描述', systemPrompt: '改提示词', model: 'gpt-4o-mini' },
    ])
    expect(warnings).toEqual([])
    const engine = registry.get('explorer')!
    expect(engine.model).toBe('gpt-4o-mini')
    expect(engine.description).toBe('改描述')
    expect(engine.tools).toContain('read_file')
    expect(engine.tools).toContain('grep') // tools 未配置，沿用内置
    expect(engine.writable).toBe(false)
    expect(engine.maxIterations).toBe(8)
  })

  it('mergeUserConfig 新增自定义引擎', () => {
    const custom: AgentEngineDef = {
      name: 'translator',
      description: '翻译引擎',
      systemPrompt: '你是翻译引擎',
      writable: false,
    }
    registry.mergeUserConfig([custom])
    expect(registry.has('translator')).toBe(true)
    expect(registry.get('translator')!.systemPrompt).toBe('你是翻译引擎')
  })

  it('mergeUserConfig 未知工具名产生告警（不阻塞）', () => {
    const knownTools = new Set(['read_file', 'grep'])
    const warnings = registry.mergeUserConfig(
      [{ name: 'explorer', description: '', systemPrompt: '', tools: ['read_file', 'magic_tool'] }],
      knownTools,
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('magic_tool')
    // 引擎仍被注册
    expect(registry.has('explorer')).toBe(true)
  })
})

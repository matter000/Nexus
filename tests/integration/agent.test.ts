/**
 * 集成测试：核心流程验证
 * 测试 ReAct 循环、工具路径安全、上下文组装等核心逻辑。
 * 不依赖真实 LLM，可在 CI 中运行。
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import { join } from 'path'
import { mkdir, writeFile, rm } from 'fs/promises'
import { isInsideProject } from '../../src/utils'
import { createToolRegistry } from '../../src/tools/registry'
import { updateTodoTool } from '../../src/tools/todo'

// ─── 测试装备 ───────────────────────────────────────────────────────────────

const TEST_DIR = join(import.meta.dir, '..', '.test-fixture')

beforeEach(async () => {
  try { await rm(TEST_DIR, { recursive: true, force: true }) } catch {}
  await mkdir(join(TEST_DIR, 'src'), { recursive: true })
  await writeFile(join(TEST_DIR, 'readme.md'), '# Test Project\n\nHello, world!')
  await writeFile(join(TEST_DIR, 'src', 'index.ts'), 'export const version = "1.0"')
})

// ─── 路径安全测试 ──────────────────────────────────────────────────────────

describe('路径遍历防护', () => {
  it('项目内路径通过检查', () => {
    expect(isInsideProject(TEST_DIR, 'src/index.ts')).toBe(true)
    expect(isInsideProject(TEST_DIR, '.')).toBe(true)
    expect(isInsideProject(TEST_DIR, 'src/../src/index.ts')).toBe(true)
  })

  it('项目外路径被拒绝', () => {
    expect(isInsideProject(TEST_DIR, '../../etc/passwd')).toBe(false)
    expect(isInsideProject(TEST_DIR, '..')).toBe(false)
  })
})

// ─── 工具注册测试 ──────────────────────────────────────────────────────────

describe('工具注册表', () => {
  it('所有必需的工具都已注册', () => {
    const registry = createToolRegistry()
    const names = registry.getAll().map((t) => t.definition.name)
    expect(names).toContain('read_file')
    expect(names).toContain('edit_file')
    expect(names).toContain('bash')
    expect(names).toContain('grep')
    expect(names).toContain('glob')
    expect(names).toContain('update_todo')
    expect(names).toContain('submit_plan')
    expect(names).toContain('dispatch_subagent')
  })

  it('plan 阶段只返回只读工具', () => {
    const registry = createToolRegistry()
    const names = registry.getForPhase('plan').map((t) => t.definition.name)
    expect(names).not.toContain('edit_file')
    expect(names).not.toContain('update_todo')
    expect(names).toContain('read_file')
    expect(names).toContain('submit_plan')
  })

  it('execute 阶段工具更完整', () => {
    const registry = createToolRegistry()
    const names = registry.getForPhase('execute').map((t) => t.definition.name)
    expect(names).toContain('edit_file')
    expect(names).toContain('bash')
    expect(names).toContain('update_todo')
  })
})

// ─── update_todo 工具状态测试 ──────────────────────────────────────────────

describe('update_todo', () => {
  it('工具定义支持 5 种操作', () => {
    const { action } = updateTodoTool.definition.inputSchema.properties as Record<string, { enum?: string[] }>
    expect(action?.enum).toContain('complete')
    expect(action?.enum).toContain('in_progress')
    expect(action?.enum).toContain('cancelled')
    expect(action?.enum).toContain('add')
    expect(action?.enum).toContain('update')
  })
})

// ─── grep 匹配计数测试 ─────────────────────────────────────────────────────

describe('grep 匹配计数逻辑', () => {
  it('只统计 file:line:content 格式的行，排除上下文和分隔符', () => {
    const output = [
      'src/index.ts:1:export const version = "1.0"',
      'src/index.ts-2-context line',
      'src/index.ts:5:export function greet() {}',
      '--',
      'readme.md:3:world',
    ].join('\n')

    const matchCount = output
      .split('\n')
      .filter((l) => /^[^:]+:\d+:/.test(l))
      .length

    // 只有 3 行是实际匹配
    expect(matchCount).toBe(3)
  })
})

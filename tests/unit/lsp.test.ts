/**
 * 单元测试: lsp 语义工具（TypeScript LanguageService）
 * definition / references / diagnostics 三 action + 非 TS 拒绝
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createToolRegistry, type ToolContext } from '../../src/tools/registry'

describe('lsp 语义工具', () => {
  let projectRoot: string
  let registry: ReturnType<typeof createToolRegistry>
  let context: ToolContext

  beforeAll(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'nexus-lsp-test-'))
    await mkdir(join(projectRoot, 'src'), { recursive: true })
    await writeFile(
      join(projectRoot, 'src', 'math.ts'),
      `export function add(a: number, b: number): number {\n  return a + b\n}\n\nexport function double(x: number): number {\n  return add(x, x)\n}\n`,
    )
    await writeFile(
      join(projectRoot, 'src', 'user.ts'),
      `import { add } from './math'\n\nexport function inc(n: number): number {\n  return add(n, 1)\n}\n`,
    )
    await writeFile(
      join(projectRoot, 'src', 'broken.ts'),
      `export function bad(): number {\n  const x: string = 123\n  return x\n}\n`,
    )
    registry = createToolRegistry()
    context = {
      projectRoot,
      callId: 'lsp-test',
      maxReadLines: 2000,
      maxOutputBytes: 102400,
      bashTimeout: 10,
      todos: [],
    }
  })

  afterAll(async () => {
    await rm(projectRoot, { recursive: true, force: true })
  })

  it('definition 精确定位符号定义', async () => {
    const result = await registry.execute(
      'lsp',
      { action: 'definition', path: 'src/user.ts', symbol: 'add' },
      context,
    )
    expect(result.error).toBeUndefined()
    expect(result.result).toContain('src/math.ts')
  })

  it('references 找到跨文件引用', async () => {
    const result = await registry.execute(
      'lsp',
      { action: 'references', path: 'src/math.ts', symbol: 'add' },
      context,
    )
    expect(result.error).toBeUndefined()
    // 引用应包含 user.ts（跨文件）与 math.ts 内部使用
    expect(result.result).toContain('src/user.ts')
  })

  it('diagnostics 报告类型错误', async () => {
    const result = await registry.execute(
      'lsp',
      { action: 'diagnostics', path: 'src/broken.ts' },
      context,
    )
    expect(result.error).toBeUndefined()
    expect(result.result).toContain('[错误]')
  })

  it('diagnostics 无问题时返回明确提示', async () => {
    const result = await registry.execute(
      'lsp',
      { action: 'diagnostics', path: 'src/math.ts' },
      context,
    )
    expect(result.result).toContain('无诊断问题')
  })

  it('非 TS/JS 文件拒绝并引导 grep/search_symbol', async () => {
    const result = await registry.execute(
      'lsp',
      { action: 'definition', path: 'src/app.py', symbol: 'foo' },
      context,
    )
    expect(result.error).toContain('暂不支持')
  })

  it('definition 未提供 symbol/line 时报错', async () => {
    const result = await registry.execute(
      'lsp',
      { action: 'definition', path: 'src/math.ts' },
      context,
    )
    expect(result.error).toContain('symbol')
  })

  it('schema 校验拒绝未知 action', async () => {
    const result = await registry.execute(
      'lsp',
      { action: 'rename', path: 'src/math.ts' },
      context,
    )
    expect(result.error).toBeDefined()
  })
})

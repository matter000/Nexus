/**
 * 集成测试: 工具层端到端测试
 * 测试 read_file + edit_file + grep 的完整工作流
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { createToolRegistry, type ToolContext } from '../../src/tools/registry'

describe('Tools Integration', () => {
  let tempDir: string
  let registry: ReturnType<typeof createToolRegistry>
  let context: ToolContext

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'nexus-test-'))
    registry = createToolRegistry()
    context = {
      projectRoot: tempDir,
      callId: 'test-1',
      maxReadLines: 2000,
      maxOutputBytes: 102400,
      bashTimeout: 10,
    }

    // 创建测试文件
    await writeFile(join(tempDir, 'hello.ts'), 'export function hello(): string {\n  return "world"\n}\n')
  })

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('read_file 能读取文件', async () => {
    const result = await registry.execute('read_file', { path: 'hello.ts' }, context)
    expect(result.error).toBeUndefined()
    expect(result.result).toContain('hello')
    expect(result.result).toContain('world')
  })

  it('edit_file 能精准替换', async () => {
    const result = await registry.execute('edit_file', {
      path: 'hello.ts',
      old_string: 'return "world"',
      new_string: 'return "nexus"',
    }, context)
    expect(result.error).toBeUndefined()
    expect(result.result).toContain('已编辑')

    // 验证文件内容
    const content = await readFile(join(tempDir, 'hello.ts'), 'utf-8')
    expect(content).toContain('nexus')
    expect(content).not.toContain('world')
  })

  it('edit_file 匹配不唯一时报错', async () => {
    // 先写入有重复内容的文件
    await writeFile(join(tempDir, 'dup.ts'), 'const x = 1\nconst x = 1\n')
    const result = await registry.execute('edit_file', {
      path: 'dup.ts',
      old_string: 'const x = 1',
      new_string: 'const x = 2',
    }, context)
    expect(result.error).toContain('不唯一')
  })

  it('edit_file 未找到匹配时报错', async () => {
    const result = await registry.execute('edit_file', {
      path: 'hello.ts',
      old_string: 'this does not exist',
      new_string: 'replacement',
    }, context)
    expect(result.error).toContain('未找到')
  })

  it('read_file 路径越界被拒绝', async () => {
    const result = await registry.execute('read_file', { path: '../../etc/passwd' }, context)
    expect(result.error).toContain('越界')
  })

  it('工具注册表正确过滤阶段', () => {
    const planTools = registry.getForPhase('plan')
    const execTools = registry.getForPhase('execute')

    // Plan 阶段只有只读工具
    const planNames = planTools.map((t) => t.definition.name)
    expect(planNames).toContain('read_file')
    expect(planNames).toContain('grep')
    expect(planNames).not.toContain('edit_file')
    expect(planNames).not.toContain('bash')

    // Execute 阶段有全部工具
    const execNames = execTools.map((t) => t.definition.name)
    expect(execNames).toContain('edit_file')
    expect(execNames).toContain('bash')
  })
})

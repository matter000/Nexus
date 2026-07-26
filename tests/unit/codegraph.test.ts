/**
 * 单元测试: CodeGraph 增量更新
 * 复现 bug: updateCodeGraph 创建新引擎实例，丢失所有未变更文件的图谱
 */

import { describe, it, expect } from 'bun:test'
import {
  buildCodeGraph,
  updateCodeGraph,
  formatGraphForContext,
  type CodeGraph,
} from '../../src/context/CodeGraph'
import { join } from 'path'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'

async function createTempProject(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nexus-graph-test-'))
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = join(dir, relPath)
    await mkdir(join(fullPath, '..'), { recursive: true })
    await writeFile(fullPath, content, 'utf-8')
  }
  return dir
}

describe('CodeGraph 增量更新', () => {
  it('updateCodeGraph 保留未变更文件的图谱', async () => {
    const projectDir = await createTempProject({
      'src/a.ts': 'export function funcA() { return 1 }',
      'src/b.ts': 'export function funcB() { return 2 }',
    })

    try {
      // 1. 构建初始图谱
      const originalGraph: CodeGraph = await buildCodeGraph(projectDir)
      expect(originalGraph.files.size).toBe(2)
      expect(originalGraph.files.has('src/a.ts')).toBe(true)
      expect(originalGraph.files.has('src/b.ts')).toBe(true)

      // 2. 修改 a.ts，触发增量更新
      await writeFile(join(projectDir, 'src/a.ts'), 'export function funcAUpdated() { return 10 }', 'utf-8')
      const updatedGraph = await updateCodeGraph(originalGraph, ['src/a.ts'], projectDir)

      // 3. 关键断言：b.ts 的图谱应保留（bug 复现时 updatedGraph 只含 a.ts）
      expect(updatedGraph.files.size).toBe(2)
      expect(updatedGraph.files.has('src/a.ts')).toBe(true)
      expect(updatedGraph.files.has('src/b.ts')).toBe(true)

      // 4. a.ts 的符号应更新
      const aSymbols = updatedGraph.files.get('src/a.ts')!.symbols
      expect(aSymbols.some((s) => s.name === 'funcAUpdated')).toBe(true)
      expect(aSymbols.some((s) => s.name === 'funcA')).toBe(false)

      // 5. b.ts 的符号应不变
      const bSymbols = updatedGraph.files.get('src/b.ts')!.symbols
      expect(bSymbols.some((s) => s.name === 'funcB')).toBe(true)
    } finally {
      await rm(projectDir, { recursive: true, force: true })
    }
  })

  it('updateCodeGraph 后 formatGraphForContext 输出完整地图', async () => {
    const projectDir = await createTempProject({
      'src/utils.ts': 'export function helper() {}',
      'src/main.ts': 'export function main() {}',
    })

    try {
      const graph = await buildCodeGraph(projectDir)
      const beforeUpdate = formatGraphForContext(graph)

      // 修改 utils.ts
      await writeFile(join(projectDir, 'src/utils.ts'), 'export function helperUpdated() {}', 'utf-8')
      const updatedGraph = await updateCodeGraph(graph, ['src/utils.ts'], projectDir)
      const afterUpdate = formatGraphForContext(updatedGraph)

      // bug 复现时：增量更新后只剩 utils.ts，main.ts 消失
      expect(afterUpdate).toContain('main.ts')
      expect(afterUpdate).toContain('helperUpdated')
    } finally {
      await rm(projectDir, { recursive: true, force: true })
    }
  })

  it('updateCodeGraph 处理文件删除', async () => {
    const projectDir = await createTempProject({
      'src/keep.ts': 'export function keep() {}',
      'src/delete-me.ts': 'export function removeMe() {}',
    })

    try {
      const graph = await buildCodeGraph(projectDir)
      expect(graph.files.size).toBe(2)

      // 删除文件后触发增量更新（updateCodeGraph 应感知到文件消失）
      await rm(join(projectDir, 'src/delete-me.ts'))

      // 增量更新传入被删除的文件路径，引擎应尝试重解析发现文件不存在并移除
      const updatedGraph = await updateCodeGraph(graph, ['src/delete-me.ts'], projectDir)

      // keep.ts 必须保留
      expect(updatedGraph.files.has('src/keep.ts')).toBe(true)
      expect(updatedGraph.files.size).toBe(1)
    } finally {
      await rm(projectDir, { recursive: true, force: true })
    }
  })
})

/**
 * 单元测试: LoopState 循环状态文件（L3 事件驱动，/loop）
 * 验证：初始读取、读-改-写合并、停止信号、损坏重置、format 往返
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { LoopState, type LoopStateFile } from '../../src/agent/LoopState'

describe('LoopState 状态文件', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'nexus-loopstate-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('文件不存在 → 返回初始状态（round=0，未停止）', async () => {
    const state = new LoopState(tempDir)
    const result = await state.read()
    expect(result.round).toBe(0)
    expect(result.stopRequested).toBe(false)
    expect(result.lastResultSummary).toBe('')
  })

  it('update 后写盘并可重新读取（轮次递增 + 结果摘要）', async () => {
    const state = new LoopState(tempDir)
    const updated = await state.update({
      round: 3,
      lastRunAt: 1_752_000_000_000,
      lastResultSummary: '第 3 轮完成：更新了依赖',
    })
    expect(updated.round).toBe(3)
    expect(updated.lastResultSummary).toBe('第 3 轮完成：更新了依赖')

    const reread = await state.read()
    expect(reread.round).toBe(3)
    expect(reread.lastRunAt).toBe(1_752_000_000_000)
  })

  it('update 为读-改-写合并：只改部分字段不丢其他', async () => {
    const state = new LoopState(tempDir)
    await state.update({ todos: ['任务 A', '任务 B'] })
    await state.update({ round: 2 })
    const result = await state.read()
    expect(result.round).toBe(2)
    expect(result.todos).toEqual(['任务 A', '任务 B'])
  })

  it('停止信号可读写（外部修改 stop_requested 控制循环）', async () => {
    const state = new LoopState(tempDir)
    await state.update({ stopRequested: true })
    const result = await state.read()
    expect(result.stopRequested).toBe(true)
  })

  it('损坏文件（无 meta）→ 重置并告警', async () => {
    const dir = join(tempDir, '.nexus')
    const { mkdir } = await import('fs/promises')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'loop-state.md'), '# 这不是合法状态文件\n', 'utf-8')

    const state = new LoopState(tempDir)
    const result = await state.read()
    expect(result.round).toBe(0)
    // 重置后文件被重写为合法格式（含 meta）
    const content = await readFile(join(dir, 'loop-state.md'), 'utf-8')
    expect(content).toContain('loop-state-meta')
  })

  it('format 输出可被 parse 完整往返（机器可读 meta）', async () => {
    const state: LoopStateFile = {
      loopName: 'main',
      round: 7,
      lastRunAt: 1_752_000_000_000,
      lastResultSummary: '摘要文本',
      todos: ['a', 'b'],
      stopRequested: false,
      findings: { urgent: ['CI 失败'], thisWeek: [], watch: ['依赖过期'] },
    }
    const rendered = LoopState.format(state)
    expect(rendered).toContain('# Loop State: main')
    expect(rendered).toContain('## 状态')
    expect(rendered).toContain('loop-state-meta')

    // 写入后读取验证 roundtrip
    const { mkdir } = await import('fs/promises')
    await mkdir(join(tempDir, '.nexus'), { recursive: true })
    await writeFile(join(tempDir, '.nexus', 'loop-state.md'), rendered, 'utf-8')
    const reread = await new LoopState(tempDir).read()
    expect(reread).toEqual(state)
  })

  it('按名分文件：非 main 名称使用 loop-state-<name>.md，互不干扰', async () => {
    const { mkdir } = await import('fs/promises')
    await mkdir(join(tempDir, '.nexus'), { recursive: true })

    const a = new LoopState(tempDir, 'ci-triage')
    await a.update({ round: 3, lastResultSummary: 'CI 已修复' })
    const b = new LoopState(tempDir, 'daily')
    await b.update({ round: 1, lastResultSummary: '日报生成' })

    expect(a.getFilePath()).toContain('loop-state-ci-triage.md')
    expect(b.getFilePath()).toContain('loop-state-daily.md')
    expect((await a.read()).round).toBe(3)
    expect((await b.read()).round).toBe(1)
    // main 保持默认文件名（兼容）
    expect(new LoopState(tempDir).getFilePath()).toContain('loop-state.md')
  })

  it('parseFindings 宽松解析 [紧急]/[本周]/[观察] 标记行', async () => {
    const findings = LoopState.parseFindings(
      [
        '[紧急] CI 管道连续失败 3 次',
        '普通结果行',
        '[本周] 依赖漏洞待升级',
        '[观察] 测试偶发超时',
      ].join('\n'),
    )
    expect(findings.urgent).toEqual(['CI 管道连续失败 3 次'])
    expect(findings.thisWeek).toEqual(['依赖漏洞待升级'])
    expect(findings.watch).toEqual(['测试偶发超时'])
    // 无标记 → 全空
    expect(LoopState.parseFindings('一切正常')).toEqual({ urgent: [], thisWeek: [], watch: [] })
  })
})

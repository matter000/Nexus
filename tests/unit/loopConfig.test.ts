/**
 * 单元测试: LoopConfigLoader 本地 Automations 配置解析（.nexus/loops.toml）
 * 验证：schedule 解析、字段默认值、单条损坏跳过、文件缺失静默
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { LoopConfigLoader } from '../../src/agent/LoopConfigLoader'

describe('LoopConfigLoader.parseSchedule', () => {
  it('"10m" → 10', () => {
    expect(LoopConfigLoader.parseSchedule('10m')).toBe(10)
  })
  it('"1h" → 60、"2h" → 120', () => {
    expect(LoopConfigLoader.parseSchedule('1h')).toBe(60)
    expect(LoopConfigLoader.parseSchedule('2h')).toBe(120)
  })
  it('非法（负数/零/未知单位/非数字）→ null', () => {
    expect(LoopConfigLoader.parseSchedule('0m')).toBeNull()
    expect(LoopConfigLoader.parseSchedule('30s')).toBeNull()
    expect(LoopConfigLoader.parseSchedule('abc')).toBeNull()
    expect(LoopConfigLoader.parseSchedule('')).toBeNull()
  })
})

describe('LoopConfigLoader.load', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'nexus-loopconfig-'))
    await mkdir(join(tempDir, '.nexus'), { recursive: true })
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('文件缺失 → 返回 []（静默降级）', async () => {
    const loops = await LoopConfigLoader.load(tempDir)
    expect(loops).toEqual([])
  })

  it('正确解析完整配置（schedule/gates/max_cost/worktree/enabled 默认值）', async () => {
    await writeFile(
      join(tempDir, '.nexus', 'loops.toml'),
      `
[loops.ci-triage]
schedule = "2h"
prompt = "检查 CI 失败并修复"
gates = ["lint", "test"]
max_cost = 5
worktree = true

[loops.daily]
schedule = "10m"
prompt = "整理今日变更"
`,
      'utf-8',
    )
    const loops = await LoopConfigLoader.load(tempDir)
    expect(loops).toHaveLength(2)

    const ci = loops.find((l) => l.name === 'ci-triage')!
    expect(ci.scheduleMin).toBe(120)
    expect(ci.prompt).toBe('检查 CI 失败并修复')
    expect(ci.gates).toEqual(['lint', 'test'])
    expect(ci.maxCost).toBe(5)
    expect(ci.worktree).toBe(true)
    expect(ci.enabled).toBe(true)

    const daily = loops.find((l) => l.name === 'daily')!
    expect(daily.scheduleMin).toBe(10)
    expect(daily.gates).toBeUndefined()
    expect(daily.maxCost).toBe(2) // 默认 $2
    expect(daily.worktree).toBeUndefined()
    expect(daily.enabled).toBe(true)
  })

  it('单条损坏（非法 schedule / 缺 prompt / 非法 gates）→ 跳过并保留其余', async () => {
    await writeFile(
      join(tempDir, '.nexus', 'loops.toml'),
      `
[loops.bad-schedule]
schedule = "30s"
prompt = "x"

[loops.bad-prompt]
schedule = "10m"

[loops.bad-gates]
schedule = "10m"
prompt = "y"
gates = ["lint", "hack"]

[loops.good]
schedule = "1h"
prompt = "z"
enabled = false
`,
      'utf-8',
    )
    const loops = await LoopConfigLoader.load(tempDir)
    expect(loops.map((l) => l.name)).toEqual(['good'])
    expect(loops[0].enabled).toBe(false)
  })

  it('TOML 语法错误 → 返回 [] 并告警（不抛错）', async () => {
    await writeFile(
      join(tempDir, '.nexus', 'loops.toml'),
      '[loops.broken\nschedule = "10m"',
      'utf-8',
    )
    const loops = await LoopConfigLoader.load(tempDir)
    expect(loops).toEqual([])
  })
})

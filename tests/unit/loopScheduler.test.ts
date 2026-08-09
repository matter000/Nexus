/**
 * 单元测试: LoopScheduler 本地 Automations 会话内调度
 * 验证：启动补跑、到点触发（tick 注入）、runNow、enable/disable、list、成本超限暂停
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { LoopConfig } from '../../src/agent/LoopConfigLoader'
import { LoopScheduler, type LoopSchedulerOptions } from '../../src/agent/LoopScheduler'
import { LoopState } from '../../src/agent/LoopState'
import type { NexusEvent } from '../../src/agent/types'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function createLoop(name = 'ci-triage', overrides: Partial<LoopConfig> = {}): LoopConfig {
  return {
    name,
    scheduleMin: 10,
    prompt: `检查 ${name} 状态`,
    enabled: true,
    ...overrides,
  }
}

function createScheduler(
  tempDir: string,
  opts: Partial<LoopSchedulerOptions> = {},
): {
  scheduler: LoopScheduler
  runLoopCalls: Array<{ prompt: string; opts?: unknown }>
  events: NexusEvent[]
} {
  const runLoopCalls: Array<{ prompt: string; opts?: unknown }> = []
  const events: NexusEvent[] = []
  const scheduler = new LoopScheduler({
    projectRoot: tempDir,
    loops: opts.loops ?? [createLoop()],
    runLoop: async (prompt, loopOpts) => {
      runLoopCalls.push({ prompt, opts: loopOpts })
      return `第 ${runLoopCalls.length} 轮完成`
    },
    getTotalCost: opts.getTotalCost ?? (() => 0),
    sessionMaxCost: 5,
    onEvent: (e) => events.push(e),
    tickMs: 50, // 测试注入：50ms 触发（实际间隔 = min(scheduleMin*60s, 50ms)）
    ...opts,
  })
  return { scheduler, runLoopCalls, events }
}

describe('LoopScheduler 调度', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'nexus-loopsched-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('start 启动补跑：无状态文件（从未运行）→ 立即执行一轮', async () => {
    const { scheduler, runLoopCalls } = createScheduler(tempDir)
    await scheduler.start()
    await sleep(100)
    expect(runLoopCalls.length).toBeGreaterThanOrEqual(1) // 补跑（可能已进入下一轮 tick）
    expect(runLoopCalls[0].prompt).toContain('检查 ci-triage 状态')
    const loopOpts = runLoopCalls[0].opts as { loopName?: string; maxRounds?: number }
    expect(loopOpts.loopName).toBe('ci-triage')
    expect(loopOpts.maxRounds).toBe(1)
    scheduler.stop()
  })

  it('正常调度：近期运行过（不补跑）→ 等待 tick 后触发一轮并写状态文件', async () => {
    // 预写状态文件（lastRunAt = now，不触发补跑）
    const state = new LoopState(tempDir, 'ci-triage')
    await state.update({ round: 1, lastRunAt: Date.now(), lastResultSummary: '上轮完成' })

    const { scheduler, runLoopCalls } = createScheduler(tempDir)
    await scheduler.start()
    expect(runLoopCalls).toHaveLength(0) // 不补跑

    await sleep(150) // 超过 tickMs(50) → 触发至少一轮
    expect(runLoopCalls.length).toBeGreaterThanOrEqual(1)
    // 状态文件已更新（round 递增）
    const updated = await state.read()
    expect(updated.round).toBeGreaterThanOrEqual(2)
    expect(updated.lastResultSummary).toContain('轮完成')
    scheduler.stop()
  })

  it('runNow 手动触发（不等调度）', async () => {
    const { scheduler, runLoopCalls } = createScheduler(tempDir)
    const result = await scheduler.runNow('ci-triage')
    expect(result).toContain('第 1 轮完成')
    expect(runLoopCalls).toHaveLength(1)
    // 未知 loop → null
    expect(await scheduler.runNow('nope')).toBeNull()
    scheduler.stop()
  })

  it('setEnabled(false) 停止调度并标记状态文件；enable(true) 恢复', async () => {
    const { scheduler, runLoopCalls } = createScheduler(tempDir)
    await scheduler.start()
    await sleep(100)
    expect(runLoopCalls.length).toBeGreaterThanOrEqual(1)

    await scheduler.setEnabled('ci-triage', false)
    const state = await new LoopState(tempDir, 'ci-triage').read()
    expect(state.stopRequested).toBe(true)

    const before = runLoopCalls.length
    await sleep(150) // 禁用期间不应再触发
    expect(runLoopCalls.length).toBe(before)

    await scheduler.setEnabled('ci-triage', true)
    await sleep(100)
    expect(runLoopCalls.length).toBeGreaterThan(before)
    scheduler.stop()
  })

  it('list 返回运行时信息（name/scheduleMin/enabled/nextRunAt/上次结果）', async () => {
    const { scheduler } = createScheduler(tempDir, { loops: [createLoop('a'), createLoop('b')] })
    await scheduler.start()
    const list = scheduler.list()
    expect(list).toHaveLength(2)
    expect(list[0].config.name).toBe('a')
    expect(list[0].config.scheduleMin).toBe(10)
    expect(list[0].config.enabled).toBe(true)
    expect(list[0].lastResultSummary).toBe('') // 尚未完成一轮（补跑异步中）
    scheduler.stop()
  })

  it('成本超限 → 暂停该 loop（不执行、记录 pausedReason）', async () => {
    const { scheduler, runLoopCalls } = createScheduler(tempDir, {
      getTotalCost: () => 100, // 远超 maxCost 默认 $2
    })
    await scheduler.start()
    await sleep(100)
    expect(runLoopCalls).toHaveLength(0)
    const list = scheduler.list()
    expect(list[0].pausedReason).toContain('成本已达上限')
    scheduler.stop()
  })
})

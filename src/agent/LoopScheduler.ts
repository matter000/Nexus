/**
 * LoopScheduler —— 本地 Automations 会话内调度器（2026-08）
 *
 * 对齐 Codex Automations 心跳形态：会话开启期间按 schedule 自动执行配置的 loop。
 * 每个 enabled loop 一条 setTimeout 链（不引入 cron 库，Bun 原生定时器）；
 * 到点读状态文件 → 执行（复用 runLoop 链路，按 loop 名分状态文件）→ 写状态 → 调度下一轮。
 *
 * 关键设计（对齐 Codex 踩坑复盘："Cron 触发丢失上下文导致任务失忆"）：
 * 每轮携带 loop-state-<name>.md 状态（上一轮结果摘要），保证跨轮上下文连续。
 *
 * 停止规则：/loops disable（状态文件标记 + 定时器清除）/ Ctrl+C（abortSignal）/
 *            成本上限（getTotalCost ≥ min(maxCost, sessionMaxCost) 时暂停该 loop 并告警）。
 * 并发护栏：同一 loop 不重叠执行（running 标志）；不同 loop 独立调度。
 * 启动补跑：lastRunAt 为 null 或距当前超过 2×interval → 立即补跑一次（防"错过不跑"）。
 */

import type { LoopConfig } from './LoopConfigLoader'
import { LoopState, type LoopStateFile } from './LoopState'
import type { NexusEvent } from './types'

/** 单个 loop 的运行时信息（/loops 列表展示） */
export interface LoopRuntimeInfo {
  config: LoopConfig
  nextRunAt: number | null
  lastRunAt: number | null
  lastResultSummary: string
  running: boolean
  /** 因成本超限/停止请求而暂停（列表展示原因） */
  pausedReason: string | null
}

export interface LoopSchedulerOptions {
  projectRoot: string
  loops: LoopConfig[]
  /** 执行一轮（Orchestrator.runLoop 链路；loopName 使状态文件按名分文件） */
  runLoop: (
    prompt: string,
    opts?: {
      loopName?: string
      intervalMin?: number
      maxRounds?: number
      maxCost?: number
    },
  ) => Promise<string>
  getTotalCost: () => number
  sessionMaxCost: number
  abortSignal?: AbortSignal
  onEvent: (event: NexusEvent) => void
  /** 测试注入：最小调度间隔（ms）；默认 0 时严格按 scheduleMin 分钟 */
  tickMs?: number
}

export class LoopScheduler {
  private readonly opts: LoopSchedulerOptions
  private readonly runtimes = new Map<string, LoopRuntimeInfo>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private stopped = false

  constructor(opts: LoopSchedulerOptions) {
    this.opts = opts
    for (const cfg of opts.loops) {
      this.runtimes.set(cfg.name, {
        config: cfg,
        nextRunAt: null,
        lastRunAt: null,
        lastResultSummary: '',
        running: false,
        pausedReason: null,
      })
    }
  }

  /** 为每个 enabled loop 建立调度链（含启动补跑判定） */
  async start(): Promise<void> {
    this.stopped = false
    for (const cfg of this.opts.loops) {
      if (!cfg.enabled) continue
      const runtime = this.runtimes.get(cfg.name)!
      const state = await new LoopState(this.opts.projectRoot, cfg.name).read()
      runtime.lastRunAt = state.lastRunAt
      runtime.lastResultSummary = state.lastResultSummary

      // 启动补跑：从未运行或错过（距上次超过 2×interval）
      const intervalMs = this.intervalMs(cfg)
      if (state.lastRunAt === null || Date.now() - state.lastRunAt > intervalMs * 2) {
        this.opts.onEvent({
          type: 'system_info',
          message: `[loops.${cfg.name}] 启动补跑（上次运行: ${
            state.lastRunAt ? new Date(state.lastRunAt).toLocaleString() : '从未'
          }）...`,
        })
        void this.runOnce(cfg)
      } else {
        this.scheduleNext(cfg, intervalMs)
      }
    }
  }

  /** 停止所有调度（Orchestrator.shutdown 调用） */
  stop(): void {
    this.stopped = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    for (const runtime of this.runtimes.values()) {
      runtime.nextRunAt = null
    }
  }

  /** 当前所有 loop 的运行时信息（/loops 列表） */
  list(): LoopRuntimeInfo[] {
    return [...this.runtimes.values()].map((r) => ({
      config: r.config,
      nextRunAt: r.nextRunAt,
      lastRunAt: r.lastRunAt,
      lastResultSummary: r.lastResultSummary,
      running: r.running,
      pausedReason: r.pausedReason,
    }))
  }

  /** 手动触发一轮（不等调度）；loop 不存在返回 null */
  async runNow(name: string): Promise<string | null> {
    const runtime = this.runtimes.get(name)
    if (!runtime) return null
    if (runtime.running) return `[loops.${name}] 正在运行中，请稍后再试`
    return await this.executeOnce(runtime)
  }

  /** 启停（更新内存态 + 状态文件 stop_requested 标记） */
  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const runtime = this.runtimes.get(name)
    if (!runtime) return
    runtime.config = { ...runtime.config, enabled }
    const state = new LoopState(this.opts.projectRoot, name)
    await state.update({ stopRequested: !enabled })
    if (enabled) {
      this.scheduleNext(runtime.config, this.intervalMs(runtime.config))
    } else {
      const timer = this.timers.get(name)
      if (timer) clearTimeout(timer)
      this.timers.delete(name)
      runtime.nextRunAt = null
      runtime.pausedReason = null
    }
  }

  /** 实际间隔（ms）：测试注入 tickMs 时用其最小值，否则按 scheduleMin 分钟 */
  private intervalMs(cfg: LoopConfig): number {
    const scheduled = cfg.scheduleMin * 60_000
    return this.opts.tickMs !== undefined && this.opts.tickMs > 0
      ? Math.min(scheduled, this.opts.tickMs)
      : scheduled
  }

  private scheduleNext(cfg: LoopConfig, intervalMs: number): void {
    if (this.stopped) return
    const runtime = this.runtimes.get(cfg.name)
    if (!runtime || !cfg.enabled) return
    const timer = setTimeout(() => {
      this.timers.delete(cfg.name)
      void this.runOnce(cfg)
    }, intervalMs)
    this.timers.set(cfg.name, timer)
    runtime.nextRunAt = Date.now() + intervalMs
  }

  /** 一轮执行入口：并发护栏 + 成本检查 + 状态文件读写 */
  private async runOnce(cfg: LoopConfig): Promise<void> {
    const runtime = this.runtimes.get(cfg.name)
    if (!runtime || runtime.running) return
    if (this.stopped || this.opts.abortSignal?.aborted) return

    // 成本护栏：超限暂停该 loop
    const maxCost = Math.min(cfg.maxCost ?? 2, this.opts.sessionMaxCost)
    if (this.opts.getTotalCost() >= maxCost) {
      runtime.pausedReason = `成本已达上限 $${maxCost.toFixed(2)}`
      this.opts.onEvent({
        type: 'system_info',
        message: `[loops.${cfg.name}] 已暂停：${runtime.pausedReason}`,
      })
      return
    }

    const result = await this.executeOnce(runtime)
    // 执行完成后（成功或失败）继续调度下一轮（若未停止）
    const intervalMs = this.intervalMs(runtime.config)
    if (result && !this.stopped) this.scheduleNext(runtime.config, intervalMs)
  }

  /** 单轮执行（读取状态 → runLoop → 写状态含 Triage 分级） */
  private async executeOnce(runtime: LoopRuntimeInfo): Promise<string> {
    const cfg = runtime.config
    if (runtime.running) return `[loops.${cfg.name}] 正在运行中`
    runtime.running = true
    runtime.pausedReason = null

    const state = new LoopState(this.opts.projectRoot, cfg.name)
    let stateFile: LoopStateFile
    try {
      stateFile = await state.read()
    } catch {
      stateFile = {
        loopName: cfg.name,
        round: 0,
        lastRunAt: null,
        lastResultSummary: '',
        todos: [],
        stopRequested: false,
      }
    }
    if (stateFile.stopRequested) {
      runtime.running = false
      runtime.pausedReason = '状态文件标记停止请求'
      this.opts.onEvent({
        type: 'system_info',
        message: `[loops.${cfg.name}] 状态文件标记停止请求，本轮跳过`,
      })
      return `[loops.${cfg.name}] 已按停止请求跳过`
    }

    const intervalMin = cfg.scheduleMin
    this.opts.onEvent({
      type: 'system_info',
      message: `[loops.${cfg.name}] 第 ${stateFile.round + 1} 轮开始...`,
    })

    try {
      const output = await this.opts.runLoop(cfg.prompt, {
        loopName: cfg.name,
        intervalMin,
        maxRounds: 1,
        maxCost: cfg.maxCost,
      })
      const summary = output.length > 500 ? `${output.slice(0, 500)}…` : output
      const findings = LoopState.parseFindings(summary)
      const updated = await state.update({
        round: stateFile.round + 1,
        lastRunAt: Date.now(),
        lastResultSummary: summary,
        stopRequested: false,
        findings,
      })
      runtime.lastRunAt = updated.lastRunAt
      runtime.lastResultSummary = updated.lastResultSummary
      this.opts.onEvent({
        type: 'system_info',
        message: `[loops.${cfg.name}] 第 ${updated.round} 轮完成，下次运行: ${new Date(
          (runtime.nextRunAt ?? Date.now()) + this.intervalMs(cfg),
        ).toLocaleTimeString()}`,
      })
      return output
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      runtime.lastResultSummary = `[第 ${stateFile.round + 1} 轮失败] ${msg}`
      this.opts.onEvent({
        type: 'error',
        message: `[loops.${cfg.name}] 第 ${stateFile.round + 1} 轮执行失败: ${msg}`,
        recoverable: true,
      })
      return `[loops.${cfg.name}] 执行失败: ${msg}`
    } finally {
      runtime.running = false
    }
  }
}

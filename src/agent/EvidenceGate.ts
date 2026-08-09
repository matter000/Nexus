/**
 * EvidenceGate —— Loop Engineering 确定性证据门禁（2026-08 深度适配）
 *
 * 手册铁律："不要基于置信度循环，要基于证据循环"。验证条件必须是可客观
 * 验证的（测试 / lint / 类型），"看起来没问题"是反模式
 * （Loop-Engineering-Handbook 第 10/11 章、loop-engineering-guide 5.3 反模式 2 交叉证实）。
 *
 * 职责：任务完成时运行确定性检查（lint / typecheck / test），产出结构化证据
 * 喂给 verifier（Checker 只处理确定性工具覆盖不到的语义验证）与修复循环
 * （确定性失败直接反馈，无需 LLM 复述）。
 *
 * 安全护栏：
 * - 命令来源三级：config.evidence 显式配置 → 探测 package.json scripts → 跳过
 * - 超时按 skipped 处理（不确定结果不当作失败，避免误触发修复循环烧钱）
 * - 输出截断保留尾部（失败信息在尾部）
 * - 不新增审批路径（与步级 autoTest 一致的确定性内部检查）
 */

import { spawn } from 'child_process'
import { readFile } from 'fs/promises'
import { join } from 'path'

/** 证据门禁配置（config.evidence 段 / ExecutorConfig.evidence 共用） */
export interface EvidenceConfig {
  /** lint 检查命令（如 "bun run lint"）；未配置时探测 package.json scripts */
  lintCommand?: string
  /** 类型检查命令（如 "bunx tsc --noEmit"） */
  typecheckCommand?: string
  /** 测试命令（如 "bun test"） */
  testCommand?: string
  /** 单条命令超时（默认 180s）；超时按 skipped 处理，不误判失败 */
  timeoutMs?: number
  /** 输出截断上限（默认 1500 字符，保留尾部） */
  maxOutputBytes?: number
}

export type EvidenceGateName = 'lint' | 'typecheck' | 'test'

/** 单条门禁的确定性结果 */
export interface EvidenceResult {
  gate: EvidenceGateName
  /** 实际执行的命令；未配置时为 '' */
  command: string
  /** 退出码；未运行/超时/命令不存在时为 null */
  exitCode: number | null
  passed: boolean
  /** 未配置命令或超时被杀（不确定结果不当作失败） */
  skipped: boolean
  /** 截断后的命令输出（保留尾部） */
  output: string
}

/** 全部门禁的聚合结果 */
export interface EvidenceSet {
  /** 全部未跳过且 exitCode === 0；全 skipped 视为通过 */
  passed: boolean
  results: EvidenceResult[]
}

const DEFAULT_TIMEOUT_MS = 180_000
const DEFAULT_MAX_OUTPUT_BYTES = 1500

/** package.json scripts 探测映射：常见脚本名 → gate */
const SCRIPT_ALIASES: Record<EvidenceGateName, string[]> = {
  lint: ['lint', 'check'],
  typecheck: ['typecheck', 'type-check', 'tsc', 'types'],
  test: ['test'],
}

/** 锁文件 → 包管理器（探测到的 script 用对应 runner 执行） */
const LOCK_RUNNERS: Array<[string, string]> = [
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
]

export class EvidenceGate {
  private readonly config: EvidenceConfig
  private scripts: Record<string, string> | null = null
  private runner: string | null = null

  constructor(
    config: EvidenceConfig | undefined,
    private readonly projectRoot: string,
  ) {
    this.config = {
      ...config,
      timeoutMs: config?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxOutputBytes: config?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    }
  }

  /** 运行全部已解析命令的门禁；未配置命令的 gate 标记 skipped */
  async runAll(): Promise<EvidenceSet> {
    const results: EvidenceResult[] = []
    for (const gate of ['lint', 'typecheck', 'test'] as const) {
      results.push(await this.runGate(gate))
    }
    return { passed: results.every((r) => r.skipped || r.passed), results }
  }

  private async runGate(gate: EvidenceGateName): Promise<EvidenceResult> {
    const command = await this.resolveCommand(gate)
    if (!command) {
      return { gate, command: '', exitCode: null, passed: false, skipped: true, output: '' }
    }

    const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const result = await new Promise<{
      stdout: string
      stderr: string
      exitCode: number | null
      timedOut: boolean
      error: string | null
    }>((resolvePromise) => {
      const child = spawn(command, {
        cwd: this.projectRoot,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(process.platform === 'win32' ? { windowsHide: true } : {}),
      })
      let stdout = ''
      let stderr = ''
      let settled = false
      // 自定义超时：Windows 下 spawn timeout 只杀 shell 不杀子进程树，
      // 管道仍被占用导致 close 永不触发；超时即 resolve，不等管道关闭
      const timer = setTimeout(() => {
        settled = true
        child.kill()
        resolvePromise({
          stdout,
          stderr,
          exitCode: null,
          timedOut: true,
          error: null,
        })
      }, timeoutMs)
      child.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString()
      })
      child.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString()
      })
      child.on('close', (code, signal) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolvePromise({
          stdout,
          stderr,
          exitCode: code,
          timedOut: signal !== null,
          error: null,
        })
      })
      child.on('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolvePromise({
          stdout,
          stderr,
          exitCode: null,
          timedOut: false,
          error: err.message,
        })
      })
    })

    const raw = `${result.stdout}\n${result.stderr}`.trim()
    const maxBytes = this.config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    const output = raw.length > maxBytes ? `...（已截断）\n${raw.slice(-maxBytes)}` : raw

    // 超时/命令不存在：不确定结果按 skipped 处理，不触发修复循环
    if (result.timedOut || result.error) {
      return {
        gate,
        command,
        exitCode: result.exitCode,
        passed: false,
        skipped: true,
        output: output || result.error || `超时（> ${Math.round(timeoutMs / 1000)}s 未完成）`,
      }
    }
    return {
      gate,
      command,
      exitCode: result.exitCode,
      passed: result.exitCode === 0,
      skipped: false,
      output,
    }
  }

  /** 命令解析：显式配置优先，其次 package.json scripts 探测 */
  private async resolveCommand(gate: EvidenceGateName): Promise<string | undefined> {
    const explicit = this.config[`${gate}Command`]
    if (explicit) return explicit
    const scripts = await this.loadProjectInfo()
    for (const name of SCRIPT_ALIASES[gate]) {
      if (scripts[name]) {
        const runner = await this.detectRunner()
        return `${runner} run ${name}`
      }
    }
    return undefined
  }

  /** 读取 package.json scripts（带缓存） */
  private async loadProjectInfo(): Promise<Record<string, string>> {
    if (this.scripts) return this.scripts
    try {
      const raw = await readFile(join(this.projectRoot, 'package.json'), 'utf-8')
      const pkg = JSON.parse(raw) as { scripts?: Record<string, string> }
      this.scripts = pkg.scripts ?? {}
    } catch {
      this.scripts = {}
    }
    return this.scripts
  }

  /** 按锁文件探测包管理器（bun → pnpm → yarn → npm） */
  private async detectRunner(): Promise<string> {
    if (this.runner) return this.runner
    for (const [lock, runner] of LOCK_RUNNERS) {
      try {
        await readFile(join(this.projectRoot, lock))
        this.runner = runner
        return runner
      } catch {
        // 继续探测下一个锁文件
      }
    }
    this.runner = 'npm'
    return this.runner
  }
}

/** 证据聚合的人类可读摘要（供 system_info 展示，紧凑单行） */
export function formatEvidenceSummary(set: EvidenceSet): string {
  const lines = set.results.map((r) => {
    if (r.skipped) return `${r.gate}: 跳过`
    return `${r.gate}: ${r.passed ? '通过' : '失败'} (${r.command})`
  })
  return lines.join(' / ')
}

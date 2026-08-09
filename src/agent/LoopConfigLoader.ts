/**
 * LoopConfigLoader —— 本地 Automations 配置解析（.nexus/loops.toml，2026-08）
 *
 * 对齐 Codex automations.toml 形态（name/schedule/prompt/gates/budget）：
 * 用户"配置一次、会话内自动心跳运行"。单条损坏跳过并告警，不阻塞其他 loop；
 * 文件缺失/不可读 → 返回 []（静默降级，与无配置行为一致）。
 */

import { readFile } from 'fs/promises'
import { join } from 'path'
import { parse } from 'smol-toml'

/** 单条 loop 配置（[loops.<name>] 段） */
export interface LoopConfig {
  name: string
  /** 解析后的分钟间隔（≥ 1） */
  scheduleMin: number
  prompt: string
  /** 每轮证据门禁（空=沿用全局 evidence 配置） */
  gates?: Array<'lint' | 'typecheck' | 'test'>
  /** 轮次成本上限（默认 $2，与会话 max_session_cost 取小） */
  maxCost?: number
  /** worktree 隔离执行（复用 WorktreeManager，可选） */
  worktree?: boolean
  enabled: boolean
}

const VALID_GATES = new Set(['lint', 'typecheck', 'test'])
const DEFAULT_MAX_COST = 2

export class LoopConfigLoader {
  /**
   * 加载全部 loop 配置；文件缺失/不可读返回 []，单条损坏跳过并告警。
   */
  static async load(projectRoot: string): Promise<LoopConfig[]> {
    const filePath = join(projectRoot, '.nexus', 'loops.toml')
    let content: string
    try {
      content = await readFile(filePath, 'utf-8')
    } catch {
      return []
    }

    let raw: Record<string, unknown>
    try {
      raw = parse(content) as Record<string, unknown>
    } catch (err) {
      console.warn(
        `[LoopConfigLoader] ${filePath} 解析失败: ${
          err instanceof Error ? err.message : String(err)
        }，本次会话不加载任何 loop`,
      )
      return []
    }

    const loopsSection = raw.loops as Record<string, Record<string, unknown>> | undefined
    if (!loopsSection || typeof loopsSection !== 'object') return []

    const result: LoopConfig[] = []
    for (const [name, cfgRaw] of Object.entries(loopsSection)) {
      const cfg = cfgRaw as Record<string, unknown>
      const config = LoopConfigLoader.buildConfig(name, cfg)
      if (config) result.push(config)
    }
    return result
  }

  /** 解析调度间隔："10m"→10, "1h"→60, "2h"→120；非法或 < 1m 返回 null */
  static parseSchedule(value: string): number | null {
    const m = value.trim().match(/^(\d+)\s*(m|h)$/)
    if (!m) return null
    const n = Number.parseInt(m[1], 10)
    const minutes = m[2] === 'h' ? n * 60 : n
    return minutes >= 1 ? minutes : null
  }

  /** 单条配置校验与构造；损坏返回 null（调用方告警跳过） */
  private static buildConfig(name: string, cfg: Record<string, unknown>): LoopConfig | null {
    const scheduleRaw = cfg.schedule
    const scheduleMin =
      typeof scheduleRaw === 'string' ? LoopConfigLoader.parseSchedule(scheduleRaw) : null
    const prompt = typeof cfg.prompt === 'string' ? cfg.prompt.trim() : ''

    if (scheduleMin === null) {
      console.warn(
        `[LoopConfigLoader] loops.${name}.schedule 无效（需 ≥1m，如 "10m"/"1h"），已跳过`,
      )
      return null
    }
    if (!prompt) {
      console.warn(`[LoopConfigLoader] loops.${name}.prompt 缺失，已跳过`)
      return null
    }

    let gates: Array<'lint' | 'typecheck' | 'test'> | undefined
    if (Array.isArray(cfg.gates)) {
      const valid = cfg.gates.filter(
        (g): g is 'lint' | 'typecheck' | 'test' => typeof g === 'string' && VALID_GATES.has(g),
      )
      if (valid.length !== cfg.gates.length) {
        console.warn(
          `[LoopConfigLoader] loops.${name}.gates 含非法值（仅 lint/typecheck/test），已跳过该 loop`,
        )
        return null
      }
      if (valid.length > 0) gates = valid
    }

    const maxCostRaw = typeof cfg.max_cost === 'number' ? cfg.max_cost : undefined
    const maxCost = maxCostRaw !== undefined && maxCostRaw > 0 ? maxCostRaw : DEFAULT_MAX_COST

    return {
      name,
      scheduleMin,
      prompt,
      gates,
      maxCost,
      worktree: typeof cfg.worktree === 'boolean' ? cfg.worktree : undefined,
      enabled: typeof cfg.enabled === 'boolean' ? cfg.enabled : true,
    }
  }
}

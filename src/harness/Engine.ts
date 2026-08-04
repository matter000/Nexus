/**
 * 评估引擎 — 批量加载、运行、验证评估任务
 */

import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadTasks } from './TaskLoader'
import type { EvalReport, EvalResult, EvalTask } from './types'
import { validateTask } from './Validator'

export interface HarnessOptions {
  /** 任务目录（.toml 文件所在） */
  tasksDir: string
  /** 任务执行工厂：接收任务描述 → 执行 → 返回结果文本 */
  runner: (task: EvalTask, workDir: string) => Promise<{ output: string; cost: number }>
  /** 运行模式（影响报告标题） */
  mode: 'mock' | 'real'
  /** 单个任务超时 ms（默认 300000 = 5 分钟） */
  timeoutMs?: number
}

export class HarnessEngine {
  private opts: Required<HarnessOptions>

  constructor(opts: HarnessOptions) {
    this.opts = {
      tasksDir: opts.tasksDir,
      runner: opts.runner,
      mode: opts.mode,
      timeoutMs: opts.timeoutMs ?? 300000,
    }
  }

  /** 运行所有任务 */
  async runAll(): Promise<EvalReport> {
    const tasks = await loadTasks(this.opts.tasksDir)
    if (tasks.length === 0) {
      throw new Error(`在 ${this.opts.tasksDir} 中没有找到有效的 .toml 任务文件`)
    }

    const results: EvalResult[] = []
    let totalCost = 0
    let totalDurationMs = 0

    for (const task of tasks) {
      const result = await this.runOne(task)
      results.push(result)
      totalCost += result.cost
      totalDurationMs += result.durationMs
    }

    return {
      mode: this.opts.mode,
      tasksTotal: tasks.length,
      tasksPassed: results.filter((r) => r.pass).length,
      tasksFailed: results.filter((r) => !r.pass).length,
      totalCost,
      totalDurationMs,
      results,
      timestamp: Date.now(),
    }
  }

  /** 运行单个任务 */
  async runOne(task: EvalTask): Promise<EvalResult> {
    const startTime = Date.now()
    let workDir = ''

    try {
      // 创建临时工作目录
      workDir = await mkdtemp(join(tmpdir(), 'nexus-eval-'))

      // 写入初始文件
      for (const file of task.initialFiles) {
        const fullPath = join(workDir, file.path)
        await mkdirIfNeeded(fullPath)
        await writeFile(fullPath, file.content, 'utf-8')
      }

      // 执行任务
      const { output, cost } = await this.opts.runner(task, workDir)

      // 验证结果
      const validateResult = await validateTask(workDir, task)
      const durationMs = Date.now() - startTime

      return {
        taskId: task.id,
        taskName: task.name,
        category: task.category,
        difficulty: task.difficulty,
        pass: validateResult.pass,
        reason: validateResult.reason,
        rulesPassed: validateResult.rulesPassed,
        rulesTotal: validateResult.rulesTotal,
        durationMs,
        cost,
        output,
      }
    } catch (err) {
      const durationMs = Date.now() - startTime
      return {
        taskId: task.id,
        taskName: task.name,
        category: task.category,
        difficulty: task.difficulty,
        pass: false,
        reason: `执行异常: ${err instanceof Error ? err.message : String(err)}`,
        rulesPassed: 0,
        rulesTotal: task.validate.length,
        durationMs,
        cost: 0,
      }
    } finally {
      // 清理临时目录
      if (workDir) {
        try {
          await rm(workDir, { recursive: true, force: true })
        } catch {}
      }
    }
  }
}

async function mkdirIfNeeded(filePath: string): Promise<void> {
  const { mkdir } = await import('fs/promises')
  const { dirname } = await import('path')
  try {
    await mkdir(dirname(filePath), { recursive: true })
  } catch {
    /* 目录已存在 */
  }
}

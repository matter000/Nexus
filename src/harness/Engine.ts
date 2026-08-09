/**
 * 评估引擎 — 批量加载、运行、验证评估任务
 */

import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadTasks } from './TaskLoader'
import type { EvalReport, EvalResult, EvalTask, TaskDifficulty } from './types'
import { validateTask } from './Validator'

export interface HarnessOptions {
  /** 任务目录（.toml 文件所在） */
  tasksDir: string
  /** 任务执行工厂：接收任务描述 → 执行 → 返回结果文本（steps/peakUtilization 为可选上报） */
  runner: (
    task: EvalTask,
    workDir: string,
  ) => Promise<{ output: string; cost: number; steps?: number; peakUtilization?: number }>
  /** 运行模式（影响报告标题） */
  mode: 'mock' | 'real'
  /** 单个任务超时 ms（默认 300000 = 5 分钟） */
  timeoutMs?: number
  /** 按难度过滤任务（真实模式回归门只跑子集用，缺省不过滤） */
  difficulty?: TaskDifficulty
}

export class HarnessEngine {
  private opts: Required<Omit<HarnessOptions, 'difficulty'>> & Pick<HarnessOptions, 'difficulty'>

  constructor(opts: HarnessOptions) {
    this.opts = {
      tasksDir: opts.tasksDir,
      runner: opts.runner,
      mode: opts.mode,
      timeoutMs: opts.timeoutMs ?? 300000,
      difficulty: opts.difficulty,
    }
  }

  /** 运行所有任务（应用 difficulty 过滤） */
  async runAll(): Promise<EvalReport> {
    let tasks = await loadTasks(this.opts.tasksDir)
    if (this.opts.difficulty) {
      tasks = tasks.filter((t) => t.difficulty === this.opts.difficulty)
    }
    if (tasks.length === 0) {
      throw new Error(
        `在 ${this.opts.tasksDir} 中没有找到有效的 .toml 任务文件${this.opts.difficulty ? `（difficulty=${this.opts.difficulty} 过滤后）` : ''}`,
      )
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

    // 聚合指标：步数/利用率均值（仅统计上报了的任务）+ diff 干净度违规数
    const stepsReported = results.filter((r) => r.steps !== undefined)
    const utilReported = results.filter((r) => r.peakContextUtilization !== undefined)

    return {
      mode: this.opts.mode,
      tasksTotal: tasks.length,
      tasksPassed: results.filter((r) => r.pass).length,
      tasksFailed: results.filter((r) => !r.pass).length,
      totalCost,
      totalDurationMs,
      avgSteps:
        stepsReported.length > 0
          ? stepsReported.reduce((s, r) => s + (r.steps ?? 0), 0) / stepsReported.length
          : undefined,
      avgPeakUtilization:
        utilReported.length > 0
          ? utilReported.reduce((s, r) => s + (r.peakContextUtilization ?? 0), 0) /
            utilReported.length
          : undefined,
      extraFilesViolations: results.filter((r) => r.extraFilesViolation).length,
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
      const { output, cost, steps, peakUtilization } = await this.opts.runner(task, workDir)

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
        steps,
        peakContextUtilization: peakUtilization,
        // diff 干净度违规标记：no_extra_files 规则存在且未通过
        extraFilesViolation: validateResult.details.some(
          (d) => d.rule.type === 'no_extra_files' && !d.pass,
        ),
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

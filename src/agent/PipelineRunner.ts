/**
 * 流水线编排器（Pipeline 协作拓扑）
 *
 * 引擎链式执行：前序引擎的摘要作为后序引擎的输入（只传摘要不传完整 transcript，
 * 避免污染子 Agent 上下文窗口，遵守多 Agent 协作社区准则）。
 * 某步失败即中断，返回已执行步骤的结果。
 */

import type { SubAgentRunner } from '../tools/registry'
import type { AgentEngineRegistry } from './AgentEngine'
import type { SubAgentResult, SubAgentTask } from './types'

export interface PipelineStep {
  engine: string
  description: string
  writable?: boolean
  tools?: string[]
}

export interface PipelineStepResult {
  engine: string
  description: string
  success: boolean
  summary: string
  error?: string
}

export interface PipelineResult {
  success: boolean
  steps: PipelineStepResult[]
  /** 最终输出：全部成功时为最后一步摘要，否则为失败步骤的错误信息 */
  output: string
}

export class PipelineRunner {
  constructor(
    private registry: AgentEngineRegistry,
    private runner: SubAgentRunner,
  ) {}

  /** 顺序执行 steps；每步 output 作为下一步 input 注入；某步失败即中断 */
  async run(steps: PipelineStep[], initialInput?: string): Promise<PipelineResult> {
    const results: PipelineStepResult[] = []
    let input = initialInput

    for (const step of steps) {
      if (!this.registry.has(step.engine)) {
        results.push({
          engine: step.engine,
          description: step.description,
          success: false,
          summary: '',
          error: `未知引擎: ${step.engine}，可用引擎: ${this.registry.getNames().join(', ')}`,
        })
        break
      }

      const task: SubAgentTask = {
        id: `pipe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        description: step.description,
        tools: step.tools ?? [],
        maxIterations: 10,
        engine: step.engine,
        ...(typeof step.writable === 'boolean' ? { writable: step.writable } : {}),
        ...(input !== undefined ? { input } : {}),
      }

      let result: SubAgentResult
      try {
        result = await this.runner.run(task)
      } catch (err) {
        // 子任务内部未捕获的 crash：记录为失败而非中断整个流水线管理
        result = {
          id: task.id,
          success: false,
          summary: '',
          filesChanged: [],
          error: err instanceof Error ? err.message : String(err),
        }
      }

      results.push({
        engine: step.engine,
        description: step.description,
        success: result.success,
        summary: result.summary,
        error: result.error,
      })

      if (!result.success) break
      // 摘要传递：前序输出作为后序输入
      input = result.summary
    }

    const success = results.every((r) => r.success)
    const last = results[results.length - 1]
    return {
      success,
      steps: results,
      output: last?.success ? last.summary : (last?.error ?? ''),
    }
  }
}

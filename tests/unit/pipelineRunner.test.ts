/**
 * 单元测试: PipelineRunner 流水线编排
 * 验证引擎链式执行、摘要传递、失败中断、未知引擎处理
 *
 * 注意：run_pipeline 工具测试在 dispatchSubagents.test.ts 中（依赖真实
 * ToolRegistry，需避开 orchestrator.test.ts 的 registry mock 泄漏）。
 */

import { describe, it, expect } from 'bun:test'
import { AgentEngineRegistry } from '../../src/agent/AgentEngine'
import { PipelineRunner, type PipelineStep } from '../../src/agent/PipelineRunner'
import type { SubAgentResult, SubAgentTask } from '../../src/agent/types'
import type { SubAgentRunner } from '../../src/tools/registry'

/** 记录每次 run 的 task，用于断言 input 链式传递 */
class RecordingRunner implements SubAgentRunner {
  tasks: SubAgentTask[] = []

  constructor(private failOn?: (task: SubAgentTask) => boolean) {}

  async run(task: SubAgentTask): Promise<SubAgentResult> {
    this.tasks.push(task)
    if (this.failOn?.(task)) {
      return {
        id: task.id,
        success: false,
        summary: '',
        filesChanged: [],
        error: `步骤失败: ${task.description}`,
      }
    }
    return {
      id: task.id,
      success: true,
      summary: `摘要[${task.description}]`,
      filesChanged: [],
    }
  }
}

describe('PipelineRunner', () => {
  const registry = new AgentEngineRegistry()

  it('顺序执行全部步骤，前序摘要作为后序输入', async () => {
    const runner = new RecordingRunner()
    const pipeline = new PipelineRunner(registry, runner)
    const steps: PipelineStep[] = [
      { engine: 'explorer', description: '探索' },
      { engine: 'reviewer', description: '审查' },
    ]
    const result = await pipeline.run(steps)

    expect(result.success).toBe(true)
    expect(result.steps).toHaveLength(2)
    expect(result.output).toBe('摘要[审查]')
    // 第二步的 input 是第一步的摘要（只传摘要不传完整 transcript）
    expect(runner.tasks[1].input).toBe('摘要[探索]')
    // 第一步无 input（未提供初始输入）
    expect(runner.tasks[0].input).toBeUndefined()
  })

  it('初始 input 注入第一步', async () => {
    const runner = new RecordingRunner()
    const pipeline = new PipelineRunner(registry, runner)
    const result = await pipeline.run([{ engine: 'explorer', description: '探索' }], '初始上下文')

    expect(result.success).toBe(true)
    expect(runner.tasks[0].input).toBe('初始上下文')
  })

  it('某步失败即中断，后续步骤不执行', async () => {
    const runner = new RecordingRunner((task) => task.description.includes('审查'))
    const pipeline = new PipelineRunner(registry, runner)
    const steps: PipelineStep[] = [
      { engine: 'explorer', description: '探索' },
      { engine: 'reviewer', description: '审查' },
      { engine: 'coder', description: '编码' },
    ]
    const result = await pipeline.run(steps)

    expect(result.success).toBe(false)
    expect(result.steps).toHaveLength(2) // 第三步未执行
    expect(result.output).toBe('步骤失败: 审查')
    expect(runner.tasks).toHaveLength(2)
  })

  it('未知引擎立即失败并提示可用引擎', async () => {
    const runner = new RecordingRunner()
    const pipeline = new PipelineRunner(registry, runner)
    const result = await pipeline.run([{ engine: 'ghost', description: '幽灵引擎' }])

    expect(result.success).toBe(false)
    expect(result.steps[0].error).toContain('ghost')
    expect(result.steps[0].error).toContain('explorer')
    expect(runner.tasks).toHaveLength(0) // 未触发 runner
  })

  it('run 内部抛异常时记录为失败而非整体崩溃', async () => {
    const runner = new RecordingRunner()
    runner.run = async () => {
      throw new Error('子任务内部崩溃')
    }
    const pipeline = new PipelineRunner(registry, runner)
    const result = await pipeline.run([{ engine: 'explorer', description: '探索' }])

    expect(result.success).toBe(false)
    expect(result.steps[0].error).toBe('子任务内部崩溃')
    expect(result.output).toBe('子任务内部崩溃')
  })
})

/**
 * 单元测试: dispatch_subagents 并行任务的结果保留
 * 验证单个子任务 reject 时，其他已完成子任务的结果不丢失
 */

import { describe, it, expect, mock } from 'bun:test'
import type { SubAgentResult, SubAgentTask } from '../../src/agent/types'
import type { SubAgentRunner } from '../../src/tools/registry'

// ─── mock: SubAgentRunner，可控制每个子任务的成功/失败 ────────────────────────

class MockSubAgentRunner implements SubAgentRunner {
  constructor(private behavior: 'all-succeed' | 'one-throws' | 'mixed' = 'all-succeed') {}

  async run(task: SubAgentTask): Promise<SubAgentResult> {
    // 第 2 个任务抛异常（模拟 run 内部未捕获的 crash）
    if (this.behavior === 'one-throws' && task.description.includes('THROW_ME')) {
      throw new Error('子任务内部崩溃')
    }
    // mixed: 第 2 个返回 success=false，第 1、3 个成功
    if (this.behavior === 'mixed' && task.description.includes('FAIL_ME')) {
      return {
        id: task.id,
        success: false,
        summary: '',
        filesChanged: [],
        error: '任务执行失败',
      }
    }
    return {
      id: task.id,
      success: true,
      summary: `完成: ${task.description}`,
      filesChanged: [],
    }
  }
}

// ─── mock 外部依赖，让 dispatch_subagents 工具能被独立测试 ──────────────────────

;(mock as any).module('@xenova/transformers', () => ({ pipeline: async () => () => ({ data: new Float32Array(8), dims: [1, 8] }) }))

import { createToolRegistry, type ToolContext } from '../../src/tools/registry'

function createContext(): ToolContext {
  return {
    projectRoot: process.cwd(),
    callId: 'test-call',
    maxReadLines: 2000,
    maxOutputBytes: 102400,
    bashTimeout: 30,
    todos: [],
  }
}

describe('dispatch_subagents 结果保留', () => {
  it('全部成功时返回所有结果', async () => {
    const registry = createToolRegistry()
    registry.setSubAgentRunner(new MockSubAgentRunner('all-succeed'))
    const handler = registry.get('dispatch_subagents')!
    const result = await handler.execute(
      {
        tasks: [
          { description: '任务A' },
          { description: '任务B' },
          { description: '任务C' },
        ],
      },
      createContext(),
    )
    expect(result.error).toBeUndefined()
    expect(result.result).toContain('3 成功')
    expect(result.result).toContain('任务A')
    expect(result.result).toContain('任务B')
    expect(result.result).toContain('任务C')
  })

  it('某个子任务 throw 时，其他已完成子任务的结果不丢失', async () => {
    const registry = createToolRegistry()
    registry.setSubAgentRunner(new MockSubAgentRunner('one-throws'))
    const handler = registry.get('dispatch_subagents')!
    const result = await handler.execute(
      {
        tasks: [
          { description: '任务A' },
          { description: 'THROW_ME 任务B' },
          { description: '任务C' },
        ],
      },
      createContext(),
    )
    // 关键断言：即使 B 崩溃，A 和 C 的结果仍应出现在汇总中
    expect(result.result).toContain('任务A')
    expect(result.result).toContain('任务C')
    // 失败的任务也应被记录
    expect(result.result).toContain('任务B')
  })

  it('某个子任务返回 success=false 时，结果仍被收集', async () => {
    const registry = createToolRegistry()
    registry.setSubAgentRunner(new MockSubAgentRunner('mixed'))
    const handler = registry.get('dispatch_subagents')!
    const result = await handler.execute(
      {
        tasks: [
          { description: '任务A' },
          { description: 'FAIL_ME 任务B' },
        ],
      },
      createContext(),
    )
    expect(result.result).toContain('1 成功')
    expect(result.result).toContain('1 失败')
    expect(result.result).toContain('任务A')
    expect(result.result).toContain('任务B')
  })
})

describe('run_pipeline 工具', () => {
  it('未注入 runner 时返回错误', async () => {
    const registry = createToolRegistry()
    const handler = registry.get('run_pipeline')!
    const result = await handler.execute(
      { steps: [{ engine: 'explorer', description: '探索' }] },
      createContext(),
    )
    expect(result.error).toContain('SubAgent 未初始化')
  })

  it('全流程成功时返回分步摘要', async () => {
    const registry = createToolRegistry()
    registry.setSubAgentRunner(new MockSubAgentRunner('all-succeed'))
    const handler = registry.get('run_pipeline')!
    const result = await handler.execute(
      {
        steps: [
          { engine: 'explorer', description: '任务A' },
          { engine: 'reviewer', description: '任务B' },
        ],
      },
      createContext(),
    )
    expect(result.error).toBeUndefined()
    expect(result.result).toContain('流水线完成（2 步）')
    expect(result.result).toContain('[explorer]')
    expect(result.result).toContain('[reviewer]')
  })

  it('步骤为空时返回错误', async () => {
    const registry = createToolRegistry()
    registry.setSubAgentRunner(new MockSubAgentRunner())
    const handler = registry.get('run_pipeline')!
    const result = await handler.execute({ steps: [] }, createContext())
    expect(result.error).toContain('步骤列表为空')
  })
})

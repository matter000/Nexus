/**
 * 单元测试: L3 事件驱动斜杠命令（/goal /loop）
 * 验证：命令解析（--max-rounds/--max-cost/--interval）、handler 委托、用法提示
 */

import { describe, expect, it } from 'bun:test'
import { type CommandContext, handleSlashCommand } from '../../src/cli/commands'

function createMockContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    getModel: () => 'test-model',
    setModel: () => {},
    interrupt: () => {},
    reinitAndSelectModel: async () => {},
    reinitProviders: async () => {},
    getAvailableModels: () => [],
    getAllKnownModels: () => [],
    isProviderConfigured: () => true,
    getCost: () => ({ total: 0, inputTokens: 0, outputTokens: 0 }),
    clearContext: () => {},
    undo: async () => '',
    compact: async () => ({ tokensUsed: 0 }),
    getHistory: () => [],
    setSkipPlan: () => {},
    getSkipPlan: () => false,
    saveLastModel: async () => {},
    restoreSession: async () => ({ restored: false, message: '' }),
    listRecentSessions: () => [],
    exportSession: async () => '',
    getStatus: () => ({ db: true, codeGraph: true, mcp: true, watcher: true, model: 'm', cost: 0 }),
    searchSessions: () => '',
    setAutoRetries: () => {},
    getAutoRetries: () => 1,
    getRecentErrors: async () => '',
    listMemory: () => '',
    deleteMemoryEntry: () => '',
    listSkills: () => '',
    listPlugins: () => '',
    ...overrides,
  }
}

describe('/goal 目标驱动循环命令', () => {
  it('无参数 → 返回用法提示', async () => {
    const result = await handleSlashCommand('/goal', createMockContext())
    expect(result).toContain('用法: /goal')
  })

  it('委托 runGoal 并展示达成结果与轮次摘要', async () => {
    const calls: Array<{ goal: string; opts?: unknown }> = []
    const ctx = createMockContext({
      runGoal: async (goal, opts) => {
        calls.push({ goal, opts })
        return {
          achieved: true,
          rounds: 2,
          roundSummaries: [
            { round: 1, evidencePassed: false, verifyPass: null, cost: 0.02 },
            { round: 2, evidencePassed: true, verifyPass: true, cost: 0.01 },
          ],
        }
      },
    })
    const result = await handleSlashCommand('/goal 让所有测试通过 --max-rounds 3 --max-cost 5', ctx)

    expect(calls).toHaveLength(1)
    expect(calls[0].goal).toBe('让所有测试通过')
    expect(calls[0].opts).toEqual({ maxRounds: 3, maxCost: 5 })
    expect(result).toContain('目标已达成')
    expect(result).toContain('第 2 轮')
    expect(result).toContain('总成本')
  })

  it('未达成 → 提示预算不足可重试', async () => {
    const ctx = createMockContext({
      runGoal: async () => ({
        achieved: false,
        rounds: 3,
        roundSummaries: [{ round: 1, evidencePassed: false, verifyPass: false, cost: 0.05 }],
      }),
    })
    const result = await handleSlashCommand('/goal 重构代码 --max-rounds 3', ctx)
    expect(result).toContain('目标未达成')
    expect(result).toContain('提示')
  })

  it('未注入 runGoal → 提示不可用', async () => {
    const result = await handleSlashCommand('/goal 让所有测试通过', createMockContext())
    expect(result).toContain('不可用')
  })
})

describe('/loop 节拍循环命令', () => {
  it('无参数 → 返回用法提示', async () => {
    const result = await handleSlashCommand('/loop', createMockContext())
    expect(result).toContain('用法: /loop')
  })

  it('解析 --interval 10m/1h 与 --max-rounds 并委托 runLoop', async () => {
    const calls: Array<{ prompt: string; opts?: unknown }> = []
    const ctx = createMockContext({
      runLoop: async (prompt, opts) => {
        calls.push({ prompt, opts })
        return '/loop 结束：共 1 轮'
      },
    })
    const result = await handleSlashCommand('/loop 检查依赖更新 --interval 10m --max-rounds 5', ctx)

    expect(calls).toHaveLength(1)
    expect(calls[0].prompt).toBe('检查依赖更新')
    expect(calls[0].opts).toEqual({ intervalMin: 10, maxRounds: 5 })
    expect(result).toContain('/loop 结束')
  })

  it('--interval 1h → intervalMin 60', async () => {
    const calls: Array<{ opts?: unknown }> = []
    const ctx = createMockContext({
      runLoop: async (_prompt, opts) => {
        calls.push({ opts })
        return 'ok'
      },
    })
    await handleSlashCommand('/loop 每日巡检 --interval 1h', ctx)
    expect(calls[0].opts).toEqual({ intervalMin: 60 })
  })

  it('未注入 runLoop → 提示不可用', async () => {
    const result = await handleSlashCommand('/loop 检查依赖', createMockContext())
    expect(result).toContain('不可用')
  })
})

describe('/loops 本地 Automations 命令', () => {
  it('未注入 → 提示不可用', async () => {
    const result = await handleSlashCommand('/loops', createMockContext())
    expect(result).toContain('不可用')
  })

  it('无配置 → 提示未配置并展示用法', async () => {
    const ctx = createMockContext({ listLoops: () => [] })
    const result = await handleSlashCommand('/loops', ctx)
    expect(result).toContain('未配置本地 Automations')
    expect(result).toContain('run-now')
  })

  it('list 展示运行状态与上次结果摘要', async () => {
    const ctx = createMockContext({
      listLoops: () => [
        {
          name: 'ci-triage',
          scheduleMin: 120,
          enabled: true,
          nextRunAt: Date.now() + 60000,
          lastRunAt: Date.now() - 60000,
          lastResultSummary: 'CI 已修复',
          running: false,
          pausedReason: null,
        },
      ],
    })
    const result = await handleSlashCommand('/loops', ctx)
    expect(result).toContain('[loops.ci-triage]')
    expect(result).toContain('启用')
    expect(result).toContain('120m')
    expect(result).toContain('CI 已修复')
  })

  it('run-now 委托并返回执行结果', async () => {
    const calls: string[] = []
    const ctx = createMockContext({
      listLoops: () => [],
      runLoopNow: async (name) => {
        calls.push(name)
        return '第 1 轮完成'
      },
    })
    const result = await handleSlashCommand('/loops run-now ci-triage', ctx)
    expect(calls).toEqual(['ci-triage'])
    expect(result).toContain('第 1 轮完成')
  })

  it('enable/disable 委托', async () => {
    const calls: Array<{ name: string; enabled: boolean }> = []
    const ctx = createMockContext({
      listLoops: () => [],
      setLoopEnabled: async (name, enabled) => {
        calls.push({ name, enabled })
      },
    })
    await handleSlashCommand('/loops disable ci-triage', ctx)
    await handleSlashCommand('/loops enable daily', ctx)
    expect(calls).toEqual([
      { name: 'ci-triage', enabled: false },
      { name: 'daily', enabled: true },
    ])
  })

  it('inbox 委托展示分级发现', async () => {
    const ctx = createMockContext({
      listLoops: () => [],
      getLoopInbox: async (name) => `[loops.${name ?? 'all'}]  [紧急] CI 失败`,
    })
    const result = await handleSlashCommand('/loops inbox ci-triage', ctx)
    expect(result).toContain('[loops.ci-triage]')
    expect(result).toContain('[紧急]')
  })
})

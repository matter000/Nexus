/**
 * 单元测试: GoalLoop 目标驱动循环（L3 事件驱动，/goal）
 * 验证：验收判定（门禁优先 + verifier 兜底）、重跑、预算/轮次/中断护栏、门禁映射
 */

import { describe, expect, it } from 'bun:test'
import {
  type ExecutionSignals,
  GoalLoop,
  type GoalLoopConfig,
  mapAcceptanceToGate,
} from '../../src/agent/GoalLoop'
import type { NexusEvent } from '../../src/agent/types'

function createSignals(overrides: Partial<ExecutionSignals> = {}): ExecutionSignals {
  return {
    evidencePassed: true,
    evidenceSummary: 'test: 通过',
    evidence: [],
    verifyPass: true,
    executionError: null,
    ...overrides,
  }
}

function createLoop(
  overrides: {
    signals?: () => ExecutionSignals
    totalCost?: () => number
    abortSignal?: AbortSignal
    events?: NexusEvent[]
  } = {},
): {
  loop: GoalLoop
  submitCount: () => number
  events: NexusEvent[]
} {
  let count = 0
  const events: NexusEvent[] = overrides.events ?? []
  const config: GoalLoopConfig = {
    goal: '让所有测试通过',
    sessionMaxCost: 5,
    submit: async () => {
      count++
      return 'ok'
    },
    getTotalCost: overrides.totalCost ?? (() => 0),
    getLastSignals: overrides.signals ?? (() => createSignals()),
    abortSignal: overrides.abortSignal,
    onEvent: (e: NexusEvent) => events.push(e),
  }
  return { loop: new GoalLoop(config), submitCount: () => count, events }
}

describe('GoalLoop 验收判定与循环控制', () => {
  it('验收通过（证据全绿）→ 1 轮结束 achieved=true', async () => {
    const { loop, submitCount } = createLoop({
      signals: () =>
        createSignals({
          evidence: [
            {
              gate: 'test',
              command: 'bun test',
              exitCode: 0,
              passed: true,
              skipped: false,
              output: '',
            },
          ],
        }),
    })
    const result = await loop.run()
    expect(result.achieved).toBe(true)
    expect(result.rounds).toBe(1)
    expect(submitCount()).toBe(1)
  })

  it('第 1 轮测试门禁失败、第 2 轮通过 → rounds=2', async () => {
    let round = 0
    const { loop, submitCount } = createLoop({
      signals: () => {
        round++
        if (round === 1) {
          return createSignals({
            evidencePassed: false,
            evidenceSummary: 'test: 失败',
            evidence: [
              {
                gate: 'test',
                command: 'bun test',
                exitCode: 1,
                passed: false,
                skipped: false,
                output: 'FAIL',
              },
            ],
          })
        }
        return createSignals({
          evidence: [
            {
              gate: 'test',
              command: 'bun test',
              exitCode: 0,
              passed: true,
              skipped: false,
              output: '',
            },
          ],
        })
      },
    })
    const result = await loop.run()
    expect(result.achieved).toBe(true)
    expect(result.rounds).toBe(2)
    expect(submitCount()).toBe(2)
  })

  it('门禁映射命中但 gate 失败 + verifier 通过 → 仍未达成（证据优先铁律）', async () => {
    const { loop } = createLoop({
      signals: () =>
        createSignals({
          evidencePassed: false,
          evidenceSummary: 'test: 失败',
          evidence: [
            {
              gate: 'test',
              command: 'bun test',
              exitCode: 1,
              passed: false,
              skipped: false,
              output: 'FAIL',
            },
          ],
          verifyPass: true, // verifier 说通过也不行
        }),
    })
    const result = await loop.run()
    expect(result.achieved).toBe(false)
    expect(result.rounds).toBe(5) // 默认 maxRounds 耗尽
  })

  it('未映射验收 + 无确定性失败 + verifier 通过 → verifier 兜底判定达成', async () => {
    const { loop } = createLoop({
      signals: () =>
        createSignals({
          evidence: [], // 门禁未运行
          verifyPass: true,
        }),
    })
    // 自定义 goal 不含"测试"关键词 → 门禁映射 null → verifier 兜底
    const result = await loop.run()
    expect(result.achieved).toBe(true)
    expect(result.rounds).toBe(1)
  })

  it('maxRounds 耗尽 → achieved=false 且轮次封顶', async () => {
    const { loop } = createLoop({
      signals: () =>
        createSignals({
          evidencePassed: false,
          evidenceSummary: 'test: 失败',
          evidence: [
            {
              gate: 'test',
              command: 'bun test',
              exitCode: 1,
              passed: false,
              skipped: false,
              output: 'FAIL',
            },
          ],
        }),
    })
    const result = await loop.run() // 默认 maxRounds=5
    expect(result.achieved).toBe(false)
    expect(result.rounds).toBe(5)
  })

  it('maxCost 预算停止（累计成本超上限）', async () => {
    let cost = 0
    let count = 0
    const loop = new GoalLoop({
      goal: '让所有测试通过',
      sessionMaxCost: 5,
      maxCost: 2,
      submit: async () => {
        count++
        cost += 2.5 // 单轮成本超过预算
        return 'ok'
      },
      getTotalCost: () => cost,
      getLastSignals: () =>
        createSignals({
          evidencePassed: false,
          evidence: [
            {
              gate: 'test',
              command: 'bun test',
              exitCode: 1,
              passed: false,
              skipped: false,
              output: 'FAIL',
            },
          ],
        }),
      onEvent: () => {},
    })
    const result = await loop.run()
    expect(result.achieved).toBe(false)
    expect(count).toBe(1) // 第二轮前成本 2.5 >= 2 停止
  })

  it('abortSignal 中断 → 立即退出', async () => {
    const controller = new AbortController()
    controller.abort()
    const { loop, submitCount } = createLoop({ abortSignal: controller.signal })
    const result = await loop.run()
    expect(result.achieved).toBe(false)
    expect(result.rounds).toBe(0)
    expect(submitCount()).toBe(0)
  })

  it('submit 抛错 → 记录失败并退出（不无限重试）', async () => {
    let count = 0
    const loop = new GoalLoop({
      goal: '让所有测试通过',
      sessionMaxCost: 5,
      submit: async () => {
        count++
        throw new Error('LLM 调用失败')
      },
      getTotalCost: () => 0,
      getLastSignals: () => createSignals(),
      onEvent: () => {},
    })
    const result = await loop.run()
    expect(result.achieved).toBe(false)
    expect(result.rounds).toBe(1)
    expect(count).toBe(1)
  })
})

describe('mapAcceptanceToGate 门禁映射', () => {
  it('包含"测试/test" → test', () => {
    expect(mapAcceptanceToGate('让所有测试通过')).toBe('test')
    expect(mapAcceptanceToGate('run all tests')).toBe('test')
  })
  it('包含"类型/typecheck/tsc" → typecheck', () => {
    expect(mapAcceptanceToGate('修复类型错误')).toBe('typecheck')
    expect(mapAcceptanceToGate('typecheck 通过')).toBe('typecheck')
    expect(mapAcceptanceToGate('tsc 无错误')).toBe('typecheck')
  })
  it('包含"lint/eslint" → lint', () => {
    expect(mapAcceptanceToGate('lint 零告警')).toBe('lint')
    expect(mapAcceptanceToGate('eslint 通过')).toBe('lint')
  })
  it('未命中 → null（verifier 兜底）', () => {
    expect(mapAcceptanceToGate('重构 utils 模块')).toBeNull()
  })
  it('优先级：同时含测试与类型时取 test', () => {
    expect(mapAcceptanceToGate('测试与类型检查都通过')).toBe('test')
  })
})

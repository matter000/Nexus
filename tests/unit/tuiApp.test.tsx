/**
 * App 级集成测试：渲染完整 App，驱动 eventBus 事件流与 stdin 输入，断言帧内容。
 * 覆盖：工具耗时徽章 / ? 帮助浮层 / /resume 会话列表 / 文件汇总行 / 输入框居中
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { render } from 'ink-testing-library'
import React from 'react'
import { App } from '../../src/tui/App'
import { eventBus } from '../../src/core/eventBus'
import { registerPlanApproval } from '../../src/core/approvalRegistry'

/** 去除 ANSI 转义码 */
function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, '')
}

const tick = () => new Promise((r) => setTimeout(r, 30))

function mockCtx(overrides: Record<string, unknown> = {}) {
  return {
    getModel: () => 'deepseek-v4-flash',
    setModel: () => {},
    interrupt: () => {},
    reinitAndSelectModel: async () => {},
    reinitProviders: async () => {},
    getAvailableModels: () => [],
    getAllKnownModels: () => [],
    isProviderConfigured: () => false,
    getCost: () => ({ total: 0.01, inputTokens: 100, outputTokens: 50, cacheHitRate: 0 }),
    clearContext: () => {},
    undo: async () => '',
    compact: async () => ({ tokensUsed: 0 }),
    getHistory: () => [],
    setSkipPlan: () => {},
    getSkipPlan: () => false,
    setPermissionMode: () => {},
    getPermissionMode: () => 'ask' as const,
    saveLastModel: async () => {},
    restoreSession: async () => ({ restored: true, message: '会话已恢复' }),
    listRecentSessions: () => [
      { id: 's1', startTime: Date.now() - 60_000, messageCount: 5, cost: 0.02 },
      { id: 's2', startTime: Date.now() - 3_600_000, messageCount: 12, cost: 0.05 },
    ],
    exportSession: async () => '',
    getStatus: () => ({ db: true, codeGraph: true, mcp: false, watcher: false, model: 'x', cost: 0 }),
    searchSessions: () => '',
    setAutoRetries: () => {},
    getAutoRetries: () => 1,
    getRecentErrors: async () => '',
    listMemory: () => '',
    deleteMemoryEntry: () => '',
    listSkills: () => '',
    listPlugins: () => '',
    ...overrides,
  } as never
}

let unmount: (() => void) | null = null

afterEach(() => {
  unmount?.()
  unmount = null
})

async function renderApp(overrides: Record<string, unknown> = {}) {
  const rendered = render(
    <App
      onSubmit={() => {}}
      onApproval={() => {}}
      commandContext={mockCtx(overrides)}
      projectRoot="D:/test"
    />,
  )
  unmount = rendered.unmount
  await tick()
  return rendered
}

describe('App 集成', () => {
  it('工具耗时徽章：tool_call→tool_result 后帧含耗时', async () => {
    const { lastFrame } = await renderApp()
    eventBus.emit({
      type: 'tool_call',
      tool: 'read_file',
      params: { path: 'a.ts' },
      callId: 'c1',
    } as never)
    await tick()
    // 立即返回结果（耗时极小，展示 ms）
    eventBus.emit({
      type: 'tool_result',
      callId: 'c1',
      tool: 'read_file',
      result: 'content',
    } as never)
    await tick()
    const frame = stripAnsi(lastFrame() ?? '')
    expect(frame).toContain('read_file')
    expect(frame).toContain('✓')
    expect(/\d+ms/.test(frame)).toBe(true)
  })

  it('? 打开帮助浮层，Esc 关闭', async () => {
    const { lastFrame, stdin } = await renderApp()
    stdin.write('?')
    await tick()
    const open = stripAnsi(lastFrame() ?? '')
    expect(open).toContain('快捷键')
    expect(open).toContain('常用命令')
    stdin.write('\u001B')
    await tick()
    const closed = stripAnsi(lastFrame() ?? '')
    expect(closed).not.toContain('常用命令')
  })

  it('/resume 无参数打开会话列表，Enter 恢复选中会话', async () => {
    let restored: string | null = null
    const { lastFrame, stdin } = await renderApp({
      restoreSession: async (id: string) => {
        restored = id
        return { restored: true, message: '会话已恢复' }
      },
    })
    stdin.write('/resume')
    await tick()
    stdin.write('\r')
    await tick()
    const frame = stripAnsi(lastFrame() ?? '')
    expect(frame).toContain('历史会话')
    // ↓ 选择第二条 + Enter 恢复
    stdin.write('\u001B[B')
    await tick()
    stdin.write('\r')
    await tick()
    expect(restored).toBe('s2')
    // 恢复后浮层关闭，消息留痕
    const after = stripAnsi(lastFrame() ?? '')
    expect(after).toContain('会话已恢复')
  })

  it('done 事件生成文件汇总行', async () => {
    const { lastFrame } = await renderApp()
    // 真实时序：工具完成事件与 done 有间隔（每次 emit 后等待渲染）
    eventBus.emit({ type: 'file_artifact', path: 'src/a.ts', tool: 'edit_file' } as never)
    await tick()
    eventBus.emit({ type: 'file_artifact', path: 'src/b.ts', tool: 'edit_file' } as never)
    await tick()
    eventBus.emit({ type: 'done', summary: '完成' } as never)
    await tick()
    const frame = stripAnsi(lastFrame() ?? '')
    expect(frame).toContain('📝')
    expect(frame).toContain('src/a.ts')
    expect(frame).toContain('src/b.ts')
  })

  it('浮层打开时输入框仍在底部（居中位置不变）', async () => {
    const { lastFrame, stdin } = await renderApp()
    stdin.write('?')
    await tick()
    const frame = stripAnsi(lastFrame() ?? '')
    // 帮助浮层打开时输入框边框仍在帧中（底部固定区未消失）
    expect(frame).toContain('快捷键')
    expect(/❯|输入/.test(frame)).toBe(true)
  })

  it('Plan 阶段 llm_done 文本不沉淀，Execute 阶段正常沉淀', async () => {
    const { lastFrame } = await renderApp()
    // Plan 阶段：llm_start(plan) → 等 phaseRef 同步 → llm_done 带文本（不沉淀）
    eventBus.emit({ type: 'llm_start', phase: 'plan' } as never)
    await tick()
    eventBus.emit({ type: 'llm_done', text: '规划中间探索文本' } as never)
    await tick()
    expect(stripAnsi(lastFrame() ?? '')).not.toContain('规划中间探索文本')
    // Execute 阶段：llm_start(execute) → llm_done 带文本（正常沉淀）
    eventBus.emit({ type: 'llm_start', phase: 'execute' } as never)
    await tick()
    eventBus.emit({ type: 'llm_done', text: '最终执行结果' } as never)
    await tick()
    expect(stripAnsi(lastFrame() ?? '')).toContain('最终执行结果')
  })

  it('plan_approval_request 清空探索时间线', async () => {
    const { lastFrame } = await renderApp()
    // 探索阶段工具调用进时间线
    eventBus.emit({
      type: 'tool_call',
      tool: 'list_directory',
      params: { path: '.' },
      callId: 'c1',
    } as never)
    await tick()
    expect(stripAnsi(lastFrame() ?? '')).toContain('list_directory')
    // 进入计划审批：先注册审批 resolver，再发事件（handler 依赖 resolver 存在）→ 时间线被清空
    registerPlanApproval('p1', () => {})
    eventBus.emit({
      type: 'plan_approval_request',
      callId: 'p1',
      plan: { summary: '计划', todos: [], filesToModify: [], estimatedSteps: 1 },
    } as never)
    await tick()
    const frame = stripAnsi(lastFrame() ?? '')
    expect(frame).not.toContain('list_directory')
    expect(frame).toContain('计划审批')
  })
})

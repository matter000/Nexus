/**
 * 单元测试: 终端体验四维优化（TUI UX）
 * 覆盖审批参数格式化、子智能体卡片渲染、输入历史回溯。
 */

import { describe, expect, it } from 'bun:test'
import { render } from 'ink-testing-library'
import React from 'react'
import {
  formatApprovalParams,
  ApprovalPrompt,
} from '../../src/tui/components/ApprovalPrompt'
import { AgentRunList, type AgentRun } from '../../src/tui/components/AgentRunList'
import { InputBox } from '../../src/tui/components/InputBox'

/** 去除 ANSI 转义码，便于断言纯文本内容 */
function stripAnsi(text: string): string {
  return text.replace(/\u001B\[[0-9;]*m/g, '')
}

describe('formatApprovalParams 审批参数格式化', () => {
  it('git_merge 展示分支数而非裸 JSON', () => {
    expect(formatApprovalParams('git_merge', { branchCount: 2 })).toBe('合并 2 个 worktree 分支')
  })

  it('bash 展示命令并截断', () => {
    const long = 'x'.repeat(200)
    const result = formatApprovalParams('bash', { command: long })
    expect(result.length).toBeLessThanOrEqual(81)
    expect(result.endsWith('…')).toBe(true)
  })

  it('edit_file/read_file/create_file 展示路径', () => {
    expect(formatApprovalParams('edit_file', { path: 'src/a.ts' })).toBe('src/a.ts')
    expect(formatApprovalParams('read_file', { path: 'b.ts' })).toBe('b.ts')
  })

  it('team_task_claim 展示任务与认领者', () => {
    expect(formatApprovalParams('team_task_claim', { agent_id: 'coder-1', task_id: '3' })).toBe(
      '认领任务 #3 (coder-1)',
    )
  })

  it('send_message 展示收发双方与内容摘要', () => {
    const result = formatApprovalParams('send_message', {
      from: 'lead',
      to: 'coder-1',
      content: '先改 utils',
    })
    expect(result).toContain('lead → coder-1')
    expect(result).toContain('先改 utils')
  })

  it('未知工具退化为紧凑 key=value（替代裸 JSON）', () => {
    const result = formatApprovalParams('custom_tool', { a: 'hello', b: 42 })
    expect(result).toBe('a=hello b=42')
  })
})

describe('ApprovalPrompt 渲染', () => {
  it('展示格式化后的参数描述', () => {
    const { lastFrame } = render(
      <ApprovalPrompt
        tool="git_merge"
        description={formatApprovalParams('git_merge', { branchCount: 3 })}
      />,
    )
    const frame = stripAnsi(lastFrame() ?? '')
    expect(frame).toContain('合并 3 个 worktree 分支')
    expect(frame).toContain('[Y] 批准')
  })
})

describe('AgentRunList 子智能体卡片', () => {
  it('空列表不渲染', () => {
    const { lastFrame } = render(<AgentRunList runs={[]} />)
    expect(stripAnsi(lastFrame() ?? '').trim()).toBe('')
  })

  it('渲染引擎名、任务 ID 与状态图标', () => {
    const runs: AgentRun[] = [
      { engine: 'explorer', taskId: 'sub-1', status: 'running' },
      { engine: 'coder', taskId: 'sub-2', status: 'done', summary: '实现了功能 X' },
      { engine: 'reviewer', taskId: 'sub-3', status: 'failed', summary: '超时' },
    ]
    const { lastFrame } = render(<AgentRunList runs={runs} />)
    const frame = stripAnsi(lastFrame() ?? '')
    expect(frame).toContain('子智能体')
    expect(frame).toContain('explorer')
    expect(frame).toContain('⟳')
    expect(frame).toContain('coder')
    expect(frame).toContain('✓')
    expect(frame).toContain('实现了功能 X')
    expect(frame).toContain('✗')
  })

  it('摘要压缩空白并截断', () => {
    const runs: AgentRun[] = [
      { engine: 'coder', taskId: 't', status: 'done', summary: '多行\n\n摘要 ' + 'x'.repeat(100) },
    ]
    const { lastFrame } = render(<AgentRunList runs={runs} />)
    const frame = stripAnsi(lastFrame() ?? '')
    expect(frame).toContain('…')
  })
})

describe('InputBox 输入历史回溯', () => {
  /** Ink 渲染节流（默认 32ms/帧）：每次输入后等待一帧，确保 useInput 闭包拿到最新 state */
  const tick = () => new Promise((r) => setTimeout(r, 40))

  it('提交后 ↑ 回溯历史，↓ 回到空输入', async () => {
    const submitted: string[] = []
    const { lastFrame, stdin } = render(<InputBox onSubmit={(t) => submitted.push(t)} />)
    // useInput 在 useEffect 中订阅：首次写入前需等挂载完成，否则输入丢失
    await tick()

    // 提交两条历史（每次输入后等一帧，避免同 tick 闭包陈旧）
    stdin.write('first task')
    await tick()
    stdin.write('\r')
    await tick()
    stdin.write('second task')
    await tick()
    stdin.write('\r')
    await tick()
    expect(submitted).toEqual(['first task', 'second task'])

    // ↑ 回溯最新一条
    stdin.write('\u001B[A')
    await tick()
    expect(stripAnsi(lastFrame() ?? '')).toContain('second task')

    // 再 ↑ 回溯更早一条
    stdin.write('\u001B[A')
    await tick()
    expect(stripAnsi(lastFrame() ?? '')).toContain('first task')
    expect(stripAnsi(lastFrame() ?? '')).not.toContain('second task')

    // ↓ 回到最新一条
    stdin.write('\u001B[B')
    await tick()
    expect(stripAnsi(lastFrame() ?? '')).toContain('second task')

    // ↓ 越界回到空输入（显示 placeholder）
    stdin.write('\u001B[B')
    await tick()
    expect(stripAnsi(lastFrame() ?? '')).toContain('输入任务...')
  })

  it('连续重复提交不叠加历史', async () => {
    const submitted: string[] = []
    const { lastFrame, stdin } = render(<InputBox onSubmit={(t) => submitted.push(t)} />)
    await tick()

    stdin.write('same')
    await tick()
    stdin.write('\r')
    await tick()
    stdin.write('same')
    await tick()
    stdin.write('\r')
    await tick()
    expect(submitted).toEqual(['same', 'same'])

    // ↑ 两次应仍是唯一的 'same'（历史栈去重，无叠加项）
    stdin.write('\u001B[A')
    await tick()
    expect(stripAnsi(lastFrame() ?? '')).toContain('same')
    stdin.write('\u001B[A')
    await tick()
    expect(stripAnsi(lastFrame() ?? '')).toContain('same')
    // 历史栈只有一条：再按 ↑ 不会变化，↓ 一次即回空输入
    stdin.write('\u001B[B')
    await tick()
    expect(stripAnsi(lastFrame() ?? '')).toContain('输入任务...')
  })
})

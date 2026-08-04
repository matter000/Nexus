/**
 * 单元测试: TodoProgress TUI 组件
 * 使用 ink-testing-library 渲染，验证空态/全完成/折叠/展开四种渲染分支。
 */

import { describe, expect, it } from 'bun:test'
import { render } from 'ink-testing-library'
import React from 'react'
import type { Todo } from '../../src/agent/types'
import { TodoProgress } from '../../src/tui/components/TodoProgress'

function makeTodo(id: string, content: string, status: Todo['status']): Todo {
  return { id, content, status }
}

/** 去除 ANSI 转义码，便于断言纯文本内容 */
function stripAnsi(text: string): string {
  return text.replace(/\u001B\[[0-9;]*m/g, '')
}

describe('TodoProgress', () => {
  it('todos 为空时不渲染', () => {
    const { lastFrame } = render(<TodoProgress todos={[]} expanded={false} />)
    expect(stripAnsi(lastFrame() ?? '').trim()).toBe('')
  })

  it('全部完成时不渲染（保持界面干净）', () => {
    const todos = [makeTodo('1', '任务A', 'complete'), makeTodo('2', '任务B', 'complete')]
    const { lastFrame } = render(<TodoProgress todos={todos} expanded={true} />)
    expect(stripAnsi(lastFrame() ?? '').trim()).toBe('')
  })

  it('折叠状态显示展开提示与完成数', () => {
    const todos = [makeTodo('1', '任务A', 'complete'), makeTodo('2', '任务B', 'pending')]
    const { lastFrame } = render(<TodoProgress todos={todos} expanded={false} />)
    expect(stripAnsi(lastFrame() ?? '')).toContain('Shift+P 展开 1/2')
  })

  it('展开状态显示进度与每个任务内容', () => {
    const todos = [makeTodo('1', '任务A', 'complete'), makeTodo('2', '任务B', 'in_progress')]
    const { lastFrame } = render(<TodoProgress todos={todos} expanded={true} />)
    const frame = stripAnsi(lastFrame() ?? '')
    expect(frame).toContain('进度 1/2')
    expect(frame).toContain('任务A')
    expect(frame).toContain('任务B')
  })
})

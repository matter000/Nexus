/**
 * 单元测试: TaskTimeline TUI 组件
 * 验证任务分组视图：工具调用与产出文件归属到对应任务下方，
 * 无归属调用进入「准备/其他」分组。
 */

import { describe, expect, it } from 'bun:test'
import { render } from 'ink-testing-library'
import React from 'react'
import type { Todo } from '../../src/agent/types'
import { TaskTimeline, type TimelineToolCall } from '../../src/tui/components/TaskTimeline'

function makeTodo(id: string, content: string, status: Todo['status']): Todo {
  return { id, content, status }
}

function makeCall(
  callId: string,
  tool: string,
  todoId: string | undefined,
  path?: string,
  status: TimelineToolCall['status'] = 'done',
): TimelineToolCall {
  return {
    callId,
    tool,
    params: path ? { path } : {},
    status,
    todoId,
  }
}

/** 去除 ANSI 转义码，便于断言纯文本内容 */
function stripAnsi(text: string): string {
  return text.replace(/\u001B\[[0-9;]*m/g, '')
}

describe('TaskTimeline', () => {
  it('todos 与 toolCalls 均为空时不渲染', () => {
    const { lastFrame } = render(
      <TaskTimeline todos={[]} toolCalls={[]} forceExpandTools={false} />,
    )
    expect(stripAnsi(lastFrame() ?? '').trim()).toBe('')
  })

  it('工具调用与产物归属到对应任务下方', () => {
    const todos = [makeTodo('1', '创建排序脚本', 'complete'), makeTodo('2', '运行验证', 'in_progress')]
    const calls: TimelineToolCall[] = [
      makeCall('c1', 'create_file', '1', 'sort.py'),
      makeCall('c2', 'bash', '2'),
    ]
    const { lastFrame } = render(
      <TaskTimeline todos={todos} toolCalls={calls} forceExpandTools={false} />,
    )
    const frame = stripAnsi(lastFrame() ?? '')
    expect(frame).toContain('进度 1/2')
    expect(frame).toContain('创建排序脚本')
    expect(frame).toContain('运行验证')
    // 产物路径展示在任务分组内
    expect(frame).toContain('sort.py')
    // 不应出现「准备/其他」分组（所有调用都有归属）
    expect(frame).not.toContain('准备/其他')
  })

  it('无任务归属的调用归入「准备/其他」分组', () => {
    const todos = [makeTodo('1', '任务A', 'in_progress')]
    const calls: TimelineToolCall[] = [
      makeCall('c1', 'read_file', undefined), // Plan 阶段探索，无 todo
      makeCall('c2', 'edit_file', '1', 'src/a.ts'),
    ]
    const { lastFrame } = render(
      <TaskTimeline todos={todos} toolCalls={calls} forceExpandTools={false} />,
    )
    const frame = stripAnsi(lastFrame() ?? '')
    expect(frame).toContain('准备/其他')
    expect(frame).toContain('src/a.ts')
  })

  it('失败的写工具不计入产物', () => {
    const todos = [makeTodo('1', '任务A', 'in_progress')]
    const calls: TimelineToolCall[] = [makeCall('c1', 'edit_file', '1', 'src/fail.ts', 'error')]
    const { lastFrame } = render(
      <TaskTimeline todos={todos} toolCalls={calls} forceExpandTools={false} />,
    )
    const frame = stripAnsi(lastFrame() ?? '')
    expect(frame).not.toContain('└ src/fail.ts')
  })
})

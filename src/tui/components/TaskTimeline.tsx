/**
 * 任务分组时间线 — 以 todo 为分组单位渲染执行过程
 * 每个任务下方列出它的工具调用与文件产物，替代「消息在上、工具堆在底部」的旧布局。
 * 无任务归属的调用（Plan 阶段探索等）归入「准备/其他」分组。
 */

import { Box, Text } from 'ink'
import React from 'react'
import type { Todo } from '../../agent/types'
import { theme } from '../theme'
import { ToolCard, type ToolStatus } from './ToolCard'

export interface TimelineToolCall {
  callId: string
  tool: string
  params: Record<string, unknown>
  status: ToolStatus
  result?: string
  error?: string
  /** 发起该调用的任务归属 */
  todoId?: string
}

interface TaskTimelineProps {
  todos: Todo[]
  toolCalls: TimelineToolCall[]
  forceExpandTools: boolean
}

/** 产出文件的工具（成功调用即视为文件产物） */
const ARTIFACT_TOOLS = new Set(['edit_file', 'create_file'])

export function TaskTimeline({ todos, toolCalls, forceExpandTools }: TaskTimelineProps) {
  if (todos.length === 0 && toolCalls.length === 0) return null

  const completed = todos.filter((t) => t.status === 'complete').length
  const todoIds = new Set(todos.map((t) => t.id))
  const unassigned = toolCalls.filter((tc) => !tc.todoId || !todoIds.has(tc.todoId))

  return (
    <Box flexDirection="column" paddingLeft={2} marginTop={1}>
      {/* 全局进度（原底部固定进度条，现并入时间线） */}
      {todos.length > 0 && (
        <Box>
          <Text color={theme.colors.muted}>
            进度 {completed}/{todos.length}
          </Text>
          <Text> </Text>
          <ProgressBar completed={completed} total={todos.length} />
        </Box>
      )}

      {/* 无任务归属的调用：Plan 阶段探索、todo 建立前的操作等 */}
      {unassigned.length > 0 && (
        <Box flexDirection="column">
          <Text color={theme.colors.muted} dimColor>
            ── 准备/其他 ──
          </Text>
          {unassigned.map((tc) => (
            <ToolCard
              key={tc.callId}
              tool={tc.tool}
              params={tc.params}
              status={tc.status}
              result={tc.result}
              error={tc.error}
              forceExpand={forceExpandTools}
            />
          ))}
        </Box>
      )}

      {/* 每个任务：状态 + 归属该任务的工具调用 + 产出的文件 */}
      {todos.map((todo) => {
        const calls = toolCalls.filter((tc) => tc.todoId === todo.id)
        const artifacts: string[] = []
        for (const tc of calls) {
          if (
            ARTIFACT_TOOLS.has(tc.tool) &&
            tc.status !== 'error' &&
            typeof tc.params.path === 'string' &&
            !artifacts.includes(tc.params.path)
          ) {
            artifacts.push(tc.params.path)
          }
        }
        return (
          <Box key={todo.id} flexDirection="column">
            <TodoHeader todo={todo} />
            {calls.map((tc) => (
              <ToolCard
                key={tc.callId}
                tool={tc.tool}
                params={tc.params}
                status={tc.status}
                result={tc.result}
                error={tc.error}
                forceExpand={forceExpandTools}
              />
            ))}
            {artifacts.map((path) => (
              <Box key={path} paddingLeft={4}>
                <Text color={theme.colors.muted}>└ </Text>
                <Text color={theme.colors.accent}>{path}</Text>
              </Box>
            ))}
          </Box>
        )
      })}
    </Box>
  )
}

function ProgressBar({ completed, total }: { completed: number; total: number }) {
  const width = 20
  const filled = Math.round((completed / total) * width)
  return <Text>{'▓'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))}</Text>
}

const TodoHeader = React.memo(function TodoHeader({ todo }: { todo: Todo }) {
  const icon = { pending: '○', in_progress: '▶', complete: '✓', cancelled: '✗' }[todo.status]
  const colorMap = {
    pending: theme.colors.muted,
    in_progress: theme.colors.warning,
    complete: theme.colors.success,
    cancelled: theme.colors.error,
  }
  return (
    <Box>
      <Text color={colorMap[todo.status]}>{icon} </Text>
      <Text
        color={todo.status === 'complete' ? theme.colors.muted : undefined}
        dimColor={todo.status === 'complete'}
        strikethrough={todo.status === 'cancelled'}
      >
        {todo.content}
      </Text>
    </Box>
  )
})

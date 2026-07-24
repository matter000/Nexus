/**
 * Todo 进度组件
 * 实时渲染任务进度条
 */

import React from 'react'
import { Box, Text } from 'ink'
import type { Todo } from '../../agent/types'
import { theme } from '../theme'

interface TodoProgressProps {
  todos: Todo[]
}

export function TodoProgress({ todos }: TodoProgressProps) {
  if (todos.length === 0) return null

  const completed = todos.filter((t) => t.status === 'complete').length
  const total = todos.length

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.colors.muted}>
          进度: {completed}/{total}
        </Text>
        <Text> </Text>
        <ProgressBar completed={completed} total={total} />
      </Box>
      {todos.map((todo) => (
        <TodoItem key={todo.id} todo={todo} />
      ))}
    </Box>
  )
}

function TodoItem({ todo }: { todo: Todo }) {
  const icon = {
    pending: theme.symbols.pending,
    in_progress: theme.symbols.inProgress,
    complete: theme.symbols.complete,
    cancelled: '✗',
  }[todo.status]

  const color = {
    pending: theme.colors.muted,
    in_progress: theme.colors.warning,
    complete: theme.colors.success,
    cancelled: theme.colors.error,
  }[todo.status] as string

  return (
    <Box>
      <Text color={color}>{icon} </Text>
      <Text color={color} strikethrough={todo.status === 'cancelled'}>
        {todo.content}
      </Text>
    </Box>
  )
}

function ProgressBar({ completed, total }: { completed: number; total: number }) {
  const width = 20
  const filled = Math.round((completed / total) * width)
  const empty = width - filled
  return (
    <Text color={theme.colors.secondary}>
      {'▓'.repeat(filled)}{'░'.repeat(empty)}
    </Text>
  )
}

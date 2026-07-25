/**
 * Todo 进度组件 — 纯展示，展开/折叠由 App.tsx 的 useInput（Shift+P）控制
 */

import React from 'react'
import { Box, Text } from 'ink'
import type { Todo } from '../../agent/types'
import { theme } from '../theme'

interface TodoProgressProps {
  todos: Todo[]
  expanded: boolean
}

export function TodoProgress({ todos, expanded }: TodoProgressProps) {
  if (todos.length === 0) return null

  const completed = todos.filter((t) => t.status === 'complete').length
  const total = todos.length

  if (!expanded) {
    return (
      <Box paddingLeft={2}>
        <Text color={theme.colors.muted} dimColor>[Shift+P 展开 {completed}/{total}]</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Box>
        <Text color={theme.colors.muted}>进度 {completed}/{total}</Text>
        <Text> </Text>
        <ProgressBar completed={completed} total={total} />
        <Text> </Text>
        <Text color={theme.colors.muted} dimColor>[Shift+P 折叠]</Text>
      </Box>
      {todos.map((todo) => (
        <TodoItem key={todo.id} todo={todo} />
      ))}
    </Box>
  )
}

function ProgressBar({ completed, total }: { completed: number; total: number }) {
  const width = 20
  const filled = Math.round((completed / total) * width)
  return <Text>{'▓'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))}</Text>
}

function TodoItem({ todo }: { todo: Todo }) {
  const icon = { pending: '○', in_progress: '▶', complete: '✓', cancelled: '✗' }[todo.status]
  const colorMap = { pending: theme.colors.muted, in_progress: theme.colors.warning, complete: theme.colors.success, cancelled: theme.colors.error }
  return (
    <Box>
      <Text color={colorMap[todo.status]}>{icon} </Text>
      <Text color={todo.status === 'complete' ? theme.colors.muted : undefined} dimColor={todo.status === 'complete'} strikethrough={todo.status === 'cancelled'}>
        {todo.content}
      </Text>
    </Box>
  )
}

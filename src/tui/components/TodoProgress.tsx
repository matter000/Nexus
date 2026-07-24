/**
 * Todo 进度组件
 * 紧凑单行摘要：进度 N/M + 进度条
 */

import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import type { Todo } from '../../agent/types'
import { theme } from '../theme'

interface TodoProgressProps {
  todos: Todo[]
  /** 是否禁用键盘交互（审批/面板激活时为 true） */
  disabled?: boolean
}

export function TodoProgress({ todos, disabled = false }: TodoProgressProps) {
  const [expanded, setExpanded] = useState(false)

  // 快捷键展开/折叠（必须在所有 early return 之前调用，遵守 Rules of Hooks）
  useInput((input) => {
    if (disabled) return
    if (input === 'p' || input === 'P') {
      setExpanded((prev) => !prev)
    }
  })

  // 无 todo 不渲染
  if (todos.length === 0) return null

  const completed = todos.filter((t) => t.status === 'complete').length
  const total = todos.length

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Box>
        <Text color={theme.colors.muted}>
          进度 {completed}/{total}
        </Text>
        <Text> </Text>
        <ProgressBar completed={completed} total={total} />
        <Text> </Text>
        <Text color={theme.colors.muted} dimColor>
          [P {expanded ? '折叠' : '展开'}]
        </Text>
      </Box>
      {expanded && todos.map((todo) => (
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
    <Box paddingLeft={2}>
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
    <Text color={theme.colors.primary}>
      {'▓'.repeat(filled)}{'░'.repeat(empty)}
    </Text>
  )
}

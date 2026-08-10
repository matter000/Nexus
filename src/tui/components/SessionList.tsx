/**
 * 会话选择浮层 — 纯展示，输入由 App.tsx useInput 统一处理（↑↓ 选择 / Enter 恢复 / Esc 取消）
 */
import { Box, Text } from 'ink'
import React from 'react'
import { theme } from '../theme'

export interface SessionEntry {
  id: string
  startTime: number
  messageCount: number
  cost: number
}

interface SessionListProps {
  sessions: SessionEntry[]
  selectionIndex: number
}

/** 相对时间（"刚刚"/"N 分钟前"/"N 小时前"/"N 天前"） */
function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

export function SessionList({ sessions, selectionIndex }: SessionListProps) {
  if (sessions.length === 0) {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.colors.warning}
        paddingX={2}
        paddingY={1}
        marginBottom={1}
      >
        <Text color={theme.colors.muted}>没有可恢复的历史会话（/resume &lt;id&gt; 可指定）</Text>
        <Text color={theme.colors.muted} dimColor italic>
          [Esc 关闭]
        </Text>
      </Box>
    )
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.colors.warning}
      paddingX={2}
      paddingY={1}
      marginBottom={1}
    >
      <Box marginBottom={1}>
        <Text color={theme.colors.warning} bold>
          📚 历史会话（↑↓ 选择 · Enter 恢复 · Esc 取消）
        </Text>
      </Box>
      {sessions.map((s, i) => (
        <Box key={s.id}>
          <Text
            color={i === selectionIndex ? theme.colors.primary : theme.colors.muted}
            bold={i === selectionIndex}
          >
            {i === selectionIndex ? '▶ ' : '  '}
            {formatRelativeTime(s.startTime).padEnd(10)}
          </Text>
          <Text color={theme.colors.muted}>
            {' '}
            · {s.messageCount} 条消息 · ${s.cost.toFixed(3)}
          </Text>
        </Box>
      ))}
    </Box>
  )
}

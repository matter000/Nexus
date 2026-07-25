/**
 * 工具调用卡片组件 — 始终展开显示完整内容
 */

import React from 'react'
import { Box, Text } from 'ink'
import { theme } from '../theme'

export type ToolStatus = 'pending' | 'running' | 'done' | 'error' | 'approval'

interface ToolCardProps {
  tool: string
  params: Record<string, unknown>
  status: ToolStatus
  result?: string
  error?: string
}

const TOOL_EMOJIS: Record<string, string> = {
  read_file: '📄', edit_file: '✏️', bash: '⚡', grep: '🔍', glob: '📂',
  fetch_url: '🌐', search_symbol: '🔍', list_directory: '📁',
  update_todo: '📋', semantic_search: '🧠', dispatch_subagent: '🤖',
}

export function ToolCard({ tool, params, status, result, error }: ToolCardProps) {
  const emoji = TOOL_EMOJIS[tool] ?? '🔧'
  const detail = extractDetail(tool, params)

  const statusIcon = { pending: '○', running: '⟳', done: '✓', error: '✗', approval: '⚠️' }[status]
  const statusColor = ({ pending: theme.colors.muted, running: theme.colors.warning, done: theme.colors.success, error: theme.colors.error, approval: theme.colors.warning }[status] as string)
  const borderColor = ({ pending: theme.colors.muted, running: theme.colors.primary, done: theme.colors.muted, error: theme.colors.error, approval: theme.colors.warning }[status] as string)

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={borderColor} paddingX={1}>
      <Box justifyContent="space-between">
        <Box>
          <Text>{emoji} </Text>
          <Text color={theme.colors.tool} bold>{tool}</Text>
          {detail ? <Text color={theme.colors.muted}> ─ {detail}</Text> : null}
        </Box>
        <Text color={statusColor}>{statusIcon}</Text>
      </Box>
      {renderContent(status, result, error, params)}
    </Box>
  )
}

function renderContent(status: ToolStatus, result?: string, error?: string, _params?: Record<string, unknown>) {
  switch (status) {
    case 'done':
      if (result) return <Text color={theme.colors.muted}>{truncateLines(result, 4)}</Text>
      return <Text color={theme.colors.success} dimColor>✓ 完成</Text>
    case 'error':
      if (error) return <Text color={theme.colors.error}>{truncate(error, 200)}</Text>
      return null
    default:
      return null
  }
}

function extractDetail(tool: string, params: Record<string, unknown>): string {
  switch (tool) {
    case 'read_file': case 'edit_file': return String(params.path ?? '')
    case 'bash': return truncate(String(params.command ?? ''), 40)
    case 'grep': case 'glob': return String(params.pattern ?? '')
    case 'fetch_url': return String(params.url ?? '')
    case 'search_symbol': return String(params.symbol ?? '')
    case 'list_directory': return String(params.path ?? '.')
    default: return ''
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + '…'
}

function truncateLines(text: string, maxLines: number): string {
  const lines = text.split('\n')
  return lines.length <= maxLines ? text : lines.slice(0, maxLines).join('\n') + '\n…'
}

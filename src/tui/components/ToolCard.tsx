/**
 * 工具调用卡片组件
 * 带边框的紧凑卡片：emoji + 工具名 + 文件路径 + 状态图标
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
  read_file: '📄',
  edit_file: '✏️',
  bash: '⚡',
  grep: '🔍',
  glob: '📂',
  fetch_url: '🌐',
  search_symbol: '🔍',
  list_directory: '📁',
  update_todo: '📋',
  semantic_search: '🧠',
  dispatch_subagent: '🤖',
}

export function ToolCard({ tool, params, status, result, error }: ToolCardProps) {
  const emoji = TOOL_EMOJIS[tool] ?? '🔧'
  const detail = extractDetail(tool, params)

  const statusIcon = {
    pending: '○',
    running: '⟳',
    done: '✓',
    error: '✗',
    approval: '⚠️',
  }[status]

  const statusColor = {
    pending: theme.colors.muted,
    running: theme.colors.warning,
    done: theme.colors.success,
    error: theme.colors.error,
    approval: theme.colors.warning,
  }[status] as string

  const borderColor = {
    pending: theme.colors.muted,
    running: theme.colors.primary,
    done: theme.colors.muted,
    error: theme.colors.error,
    approval: theme.colors.warning,
  }[status] as string

  // 内容区域：根据状态显示不同信息
  const contentLine = renderContent(status, result, error, params)

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={borderColor}
      paddingX={1}
    >
      {/* 标题行：emoji + 工具名 + ─ + 路径 ... 状态图标 */}
      <Box justifyContent="space-between">
        <Box>
          <Text>{emoji} </Text>
          <Text color={theme.colors.tool} bold>{tool}</Text>
          {detail ? (
            <Text color={theme.colors.muted}> ─ {detail}</Text>
          ) : null}
        </Box>
        <Text color={statusColor}>{statusIcon}</Text>
      </Box>
      {/* 内容区域 */}
      {contentLine}
    </Box>
  )
}

function renderContent(
  status: ToolStatus,
  result: string | undefined,
  error: string | undefined,
  params: Record<string, unknown>,
): React.ReactElement | null {
  switch (status) {
    case 'done':
      if (result) {
        return (
          <Text color={theme.colors.muted}>{truncateLines(result, 3)}</Text>
        )
      }
      return (
        <Text color={theme.colors.success} dimColor>✓ 完成</Text>
      )
    case 'running': {
      const summary = getParamSummary(params)
      return summary ? (
        <Text color={theme.colors.muted} dimColor>{summary}</Text>
      ) : null
    }
    case 'error':
      if (error) {
        return (
          <Text color={theme.colors.error}>{truncate(error, 200)}</Text>
        )
      }
      return null
    default:
      return null
  }
}

function extractDetail(tool: string, params: Record<string, unknown>): string {
  switch (tool) {
    case 'read_file':
    case 'edit_file':
      return String(params.path ?? '')
    case 'bash':
      return truncate(String(params.command ?? ''), 40)
    case 'grep':
      return String(params.pattern ?? '')
    case 'glob':
      return String(params.pattern ?? '')
    case 'fetch_url':
      return String(params.url ?? '')
    case 'search_symbol':
      return String(params.symbol ?? '')
    case 'list_directory':
      return String(params.path ?? '.')
    default:
      return ''
  }
}

function getParamSummary(params: Record<string, unknown>): string {
  const keys = Object.keys(params)
  if (keys.length === 0) return ''
  return keys.map((k) => `${k}: ${truncate(String(params[k] ?? ''), 30)}`).join(', ')
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + '…'
}

function truncateLines(text: string, maxLines: number): string {
  const lines = text.split('\n')
  if (lines.length <= maxLines) return text
  return lines.slice(0, maxLines).join('\n') + '\n…'
}

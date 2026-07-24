/**
 * 工具调用卡片组件
 * 显示工具名、参数摘要、状态(待审批/执行中/完成/失败)
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

const TOOL_LABELS: Record<string, string> = {
  read_file: '📄 read_file',
  edit_file: '✏️ edit_file',
  bash: '⚡ bash',
  grep: '🔍 grep',
}

export function ToolCard({ tool, params, status, result, error }: ToolCardProps) {
  const label = TOOL_LABELS[tool] ?? tool
  const paramSummary = getParamSummary(tool, params)

  const statusIcon = {
    pending: '○',
    running: '●',
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

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={statusColor} paddingX={1}>
      <Box>
        <Text color={statusColor}>{statusIcon} </Text>
        <Text bold>{label}</Text>
        <Text color={theme.colors.muted}> {paramSummary}</Text>
      </Box>
      {status === 'done' && result && (
        <Text color={theme.colors.muted} dimColor>
          {truncate(result, 200)}
        </Text>
      )}
      {status === 'error' && error && (
        <Text color={theme.colors.error}>{truncate(error, 200)}</Text>
      )}
    </Box>
  )
}

function getParamSummary(tool: string, params: Record<string, unknown>): string {
  switch (tool) {
    case 'read_file':
      return String(params.path ?? '')
    case 'edit_file':
      return String(params.path ?? '')
    case 'bash':
      return truncate(String(params.command ?? ''), 60)
    case 'grep':
      return `/${params.pattern ?? ''}/`
    default:
      return JSON.stringify(params).slice(0, 60)
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + '...'
}

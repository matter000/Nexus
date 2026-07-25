/**
 * 工具调用卡片组件
 * 运行中展开显示详情，完成后自动折叠为单行摘要
 * 按 [T] 键可切换全部展开/折叠
 */

import React, { useState, useEffect } from 'react'
import { Box, Text } from 'ink'
import { theme } from '../theme'

export type ToolStatus = 'pending' | 'running' | 'done' | 'error' | 'approval'

interface ToolCardProps {
  tool: string
  params: Record<string, unknown>
  status: ToolStatus
  result?: string
  error?: string
  /** 全局展开开关（App 的 [T] 键控制） */
  forceExpand?: boolean
}

const TOOL_EMOJIS: Record<string, string> = {
  read_file: '📄', edit_file: '✏️', bash: '⚡', grep: '🔍', glob: '📂',
  fetch_url: '🌐', search_symbol: '🔍', list_directory: '📁',
  update_todo: '📋', semantic_search: '🧠', dispatch_subagent: '🤖',
}

export function ToolCard({ tool, params, status, result, error, forceExpand }: ToolCardProps) {
  const emoji = TOOL_EMOJIS[tool] ?? '🔧'
  const detail = extractDetail(tool, params)
  const [collapsed, setCollapsed] = useState(true)

  // 运行中自动展开；完成/错误/挂起时收起（forceExpand 时全部展开）
  useEffect(() => {
    if (forceExpand || status === 'running') {
      setCollapsed(false)
    } else if (status === 'done' || status === 'error' || status === 'pending') {
      setCollapsed(true)
    }
  }, [status, forceExpand])

  const statusIcon = { pending: '○', running: '⟳', done: '✓', error: '✗', approval: '⚠️' }[status]
  const statusColor = ({ pending: theme.colors.muted, running: theme.colors.warning, done: theme.colors.success, error: theme.colors.error, approval: theme.colors.warning }[status] as string)
  const borderColor = ({ pending: theme.colors.muted, running: theme.colors.primary, done: theme.colors.muted, error: theme.colors.error, approval: theme.colors.warning }[status] as string)

  // 折叠态：只显示单行标题
  if (collapsed && status !== 'running') {
    const summary = status === 'done' ? (result ? truncate(result.split('\n')[0], 60) : '完成') :
                    status === 'error' ? (error ? truncate(error, 60) : '失败') : ''
    return (
      <Box>
        <Text color={theme.colors.muted}>{emoji} </Text>
        <Text color={theme.colors.tool}>{tool}</Text>
        {detail ? <Text color={theme.colors.muted}> ─ {detail}</Text> : null}
        <Text color={statusColor}> {statusIcon}</Text>
        {summary ? <Text color={theme.colors.muted} dimColor>  {summary}</Text> : null}
      </Box>
    )
  }

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

function renderContent(status: ToolStatus, result?: string, error?: string, params?: Record<string, unknown>) {
  switch (status) {
    case 'done':
      if (result) return <Text color={theme.colors.muted}>{truncateLines(result, 4)}</Text>
      return <Text color={theme.colors.success} dimColor>✓ 完成</Text>
    case 'running': {
      const summary = params ? Object.keys(params).map(k => `${k}: ${truncate(String(params[k] ?? ''), 30)}`).join(', ') : ''
      return summary ? <Text color={theme.colors.muted} dimColor>{summary}</Text> : null
    }
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

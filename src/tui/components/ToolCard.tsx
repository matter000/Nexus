/**
 * 工具调用卡片 — 默认折叠为单行，运行中自动展开，按 T 全局切换
 */

import { Box, Text } from 'ink'
import React, { useEffect, useState } from 'react'
import { theme } from '../theme'

export type ToolStatus = 'pending' | 'running' | 'done' | 'error' | 'approval'

interface ToolCardProps {
  tool: string
  params: Record<string, unknown>
  status: ToolStatus
  result?: string
  error?: string
  forceExpand?: boolean
}

const TOOL_EMOJIS: Record<string, string> = {
  read_file: '📄',
  edit_file: '✏️',
  bash: '⚡',
  grep: '🔍',
  glob: '📂',
  fetch_url: '🌐',
  search_symbol: '🔍',
  lsp: '🧭',
  list_directory: '📁',
  update_todo: '📋',
  update_notes: '📝',
  semantic_search: '🧠',
  dispatch_subagent: '🤖',
  dispatch_agent: '🤖',
  dispatch_subagents: '🤖',
  dispatch_agents: '🤖',
  run_pipeline: '🔗',
  team_task_list: '📌',
  team_task_claim: '📌',
  send_message: '✉️',
  read_messages: '✉️',
  create_file: '✨',
  web_search: '🌐',
  git_status: '🌱',
  git_commit: '🌱',
  git_push: '🌱',
  git_merge: '🌱',
  submit_plan: '🗺️',
  load_skill: '🎯',
}

export const ToolCard = React.memo(function ToolCard({
  tool,
  params,
  status,
  result,
  error,
  forceExpand,
}: ToolCardProps) {
  const emoji = TOOL_EMOJIS[tool] ?? '🔧'
  const detail = extractDetail(tool, params)
  const [collapsed, setCollapsed] = useState(true)

  useEffect(() => {
    if (forceExpand) {
      setCollapsed(false)
    } else if (status === 'running') {
      setCollapsed(false)
    } else {
      setCollapsed(true)
    }
  }, [status, forceExpand])

  const statusIcon = { pending: '○', running: '⟳', done: '✓', error: '✗', approval: '⚠️' }[status]
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

  // 折叠态：单行（无边框）
  if (collapsed) {
    const summary =
      status === 'done'
        ? result
          ? truncate(result.split('\n')[0], 60)
          : '完成'
        : status === 'error'
          ? error
            ? truncate(error, 60)
            : '失败'
          : ''
    return (
      <Box>
        <Text color={theme.colors.muted}>{emoji} </Text>
        <Text color={theme.colors.tool}>{tool.padEnd(20)}</Text>
        {detail ? <Text color={theme.colors.muted}> ─ {detail}</Text> : null}
        <Text color={statusColor}> {statusIcon}</Text>
        {summary ? (
          <Text color={theme.colors.muted} dimColor>
            {' '}
            · {summary}
          </Text>
        ) : null}
      </Box>
    )
  }

  // 展开态：完整卡片（带边框）
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={borderColor} paddingX={1}>
      <Box justifyContent="space-between">
        <Box>
          <Text>{emoji} </Text>
          <Text color={theme.colors.tool} bold>
            {tool}
          </Text>
          {detail ? <Text color={theme.colors.muted}> ─ {detail}</Text> : null}
        </Box>
        <Text color={statusColor}>{statusIcon}</Text>
      </Box>
      {renderContent(status, result, error)}
    </Box>
  )
})

function renderContent(status: ToolStatus, result?: string, error?: string) {
  if (status === 'done' && result)
    return <Text color={theme.colors.muted}>{truncateLines(result, 4)}</Text>
  if (status === 'error' && error)
    return <Text color={theme.colors.error}>{truncate(error, 200)}</Text>
  return null
}

function extractDetail(tool: string, params: Record<string, unknown>): string {
  switch (tool) {
    case 'read_file':
    case 'edit_file':
      return String(params.path ?? '')
    case 'bash':
      return truncate(String(params.command ?? ''), 40)
    case 'grep':
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

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + '…'
}

function truncateLines(text: string, maxLines: number): string {
  const lines = text.split('\n')
  return lines.length <= maxLines ? text : lines.slice(0, maxLines).join('\n') + '\n…'
}

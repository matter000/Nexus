/**
 * 子 Agent 执行卡片列表 — 多智能体协作可见性
 * 渲染 agent_start/agent_done 事件：引擎名、任务 ID、运行状态与结果摘要。
 * 单行紧凑卡片，运行中着色，与任务时间线同区展示。
 */

import { Box, Text } from 'ink'
import React from 'react'
import { theme } from '../theme'

export interface AgentRun {
  engine: string
  taskId: string
  status: 'running' | 'done' | 'failed'
  summary?: string
}

interface AgentRunListProps {
  runs: AgentRun[]
}

const STATUS_ICON = { running: '⟳', done: '✓', failed: '✗' } as const
const STATUS_COLOR = {
  running: theme.colors.warning,
  done: theme.colors.success,
  failed: theme.colors.error,
} as const

export const AgentRunList = React.memo(function AgentRunList({ runs }: AgentRunListProps) {
  if (runs.length === 0) return null
  return (
    <Box flexDirection="column" paddingLeft={2} marginTop={1}>
      <Text color={theme.colors.muted} dimColor>
        ── 子智能体 ──
      </Text>
      {runs.map((run) => (
        <Box key={`${run.engine}-${run.taskId}`}>
          <Text>🤖 </Text>
          <Text color={run.status === 'running' ? theme.colors.primary : theme.colors.tool} bold>
            {run.engine}
          </Text>
          <Text color={theme.colors.muted}> ─ {truncate(run.taskId, 16)}</Text>
          <Text color={STATUS_COLOR[run.status]}> {STATUS_ICON[run.status]}</Text>
          {run.summary ? (
            <Text color={theme.colors.muted} dimColor>
              {' '}
              {truncate(run.summary.replace(/\s+/g, ' '), 60)}
            </Text>
          ) : null}
        </Box>
      ))}
    </Box>
  )
})

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + '…'
}

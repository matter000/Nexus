/**
 * 计划审批面板组件 — 纯展示，输入由 App.tsx 的 useInput 统一处理
 */

import { Box, Text } from 'ink'
import React from 'react'
import type { Plan, Todo } from '../../agent/types'
import { theme } from '../theme'

interface PlanApprovalPanelProps {
  plan: Plan
  /** 修改意见输入模式（e 激活）：显示输入行 */
  reasonMode?: boolean
  reasonDraft?: string
}

export function PlanApprovalPanel({
  plan,
  reasonMode = false,
  reasonDraft = '',
}: PlanApprovalPanelProps) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.colors.warning} paddingX={1}>
      <Box>
        <Text color={theme.colors.warning} bold>
          📋 计划审批
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text bold>摘要: </Text>
        <Text>{plan.summary}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text bold>执行步骤:</Text>
        {plan.todos.length > 0 ? (
          plan.todos.map((todo: Todo, i: number) => (
            <Box key={todo.id || i} paddingLeft={1}>
              <Text color={theme.colors.muted}>{i + 1}.</Text>
              <Text> {todo.content}</Text>
            </Box>
          ))
        ) : (
          <Text color={theme.colors.muted} dimColor>
            {' '}
            (无步骤，将在执行中自主拆解)
          </Text>
        )}
      </Box>
      {plan.filesToModify.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>涉及文件:</Text>
          {plan.filesToModify.map((file: string, i: number) => (
            <Box key={i} paddingLeft={1}>
              <Text color={theme.colors.muted}>•</Text>
              <Text color={theme.colors.accent}> {file}</Text>
            </Box>
          ))}
        </Box>
      )}
      {plan.estimatedSteps > 0 && (
        <Box marginTop={1}>
          <Text color={theme.colors.muted} dimColor>
            预估 {plan.estimatedSteps} 步
          </Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={theme.colors.success} bold>
          [Enter] 批准
        </Text>
        <Text color={theme.colors.muted}> · </Text>
        <Text color={theme.colors.error} bold>
          [N] 拒绝
        </Text>
        <Text color={theme.colors.muted}> · </Text>
        <Text color={theme.colors.accent} bold>
          [E] 修改意见（重规划）
        </Text>
      </Box>

      {/* 修改意见输入行（e 激活）：Enter 提交触发带反馈重规划 */}
      {reasonMode && (
        <Box marginTop={1}>
          <Text color={theme.colors.warning} bold>
            修改意见:
          </Text>
          <Text color={theme.colors.fg}>{reasonDraft || ' '}</Text>
          <Text color={theme.colors.primary}>▌</Text>
          <Text color={theme.colors.muted} dimColor>
            {' '}
            [Enter 提交重规划 · Esc 取消]
          </Text>
        </Box>
      )}
    </Box>
  )
}

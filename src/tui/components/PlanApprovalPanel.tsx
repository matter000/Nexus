/**
 * 计划审批面板组件
 * 展示完整计划（summary + todos + filesToModify），支持批准/拒绝/反馈重规划
 * 由 plan_approval_request 事件触发
 */

import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { theme } from '../theme'
import type { Plan, Todo } from '../../agent/types'

interface PlanApprovalPanelProps {
  plan: Plan
  onApprove: () => void
  onReject: () => void
  /** 提交反馈文本，触发重规划 */
  onFeedback: (feedback: string) => void
}

type PanelMode = 'menu' | 'input_feedback'

export function PlanApprovalPanel({ plan, onApprove, onReject, onFeedback }: PlanApprovalPanelProps) {
  const [mode, setMode] = useState<PanelMode>('menu')
  const [feedback, setFeedback] = useState('')

  // ─── useInput: 在所有条件分支之前调用，遵守 React Hooks 规则 ───────────────
  useInput((input, key) => {
    if (mode === 'input_feedback') {
      // 反馈输入模式
      if (key.escape) {
        setMode('menu')
        setFeedback('')
        return
      }
      if (key.return) {
        const trimmed = feedback.trim()
        if (!trimmed) {
          setMode('menu')
          return
        }
        onFeedback(trimmed)
        return
      }
      if (key.backspace || key.delete) {
        setFeedback((v) => v.slice(0, -1))
        return
      }
      if (key.ctrl || key.meta) return
      if (input) {
        setFeedback((v) => v + input)
      }
      return
    }

    // 菜单模式
    if (input === 'y' || key.return) {
      onApprove()
    } else if (input === 'n' || key.escape) {
      onReject()
    } else if (input === 'f' || input === 'F') {
      setMode('input_feedback')
      setFeedback('')
    }
  })

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.colors.warning} paddingX={1}>
      {/* 标题 */}
      <Box>
        <Text color={theme.colors.warning} bold>📋 计划审批</Text>
      </Box>

      {/* 计划摘要 */}
      <Box marginTop={1}>
        <Text bold>摘要: </Text>
        <Text>{plan.summary}</Text>
      </Box>

      {/* 步骤列表 */}
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
          <Text color={theme.colors.muted} dimColor>  (无步骤，将在执行中自主拆解)</Text>
        )}
      </Box>

      {/* 待修改文件 */}
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

      {/* 预估步数 */}
      {plan.estimatedSteps > 0 && (
        <Box marginTop={1}>
          <Text color={theme.colors.muted} dimColor>
            预估 {plan.estimatedSteps} 步
          </Text>
        </Box>
      )}

      {/* 操作模式 */}
      {mode === 'menu' ? (
        <Box marginTop={1}>
          <Text color={theme.colors.success} bold>[Y] 批准</Text>
          <Text color={theme.colors.muted}> · </Text>
          <Text color={theme.colors.error} bold>[N] 拒绝</Text>
          <Text color={theme.colors.muted}> · </Text>
          <Text color={theme.colors.accent} bold>[F] 反馈重规划</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.colors.accent}>输入反馈（Enter 提交重规划 · Esc 取消）:</Text>
          <Box>
            <Text color={theme.colors.primary}>{'> '}</Text>
            <Text>{feedback || ''}</Text>
            <Text color={theme.colors.primary}>▌</Text>
          </Box>
        </Box>
      )}
    </Box>
  )
}

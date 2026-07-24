/**
 * 审批提示组件
 * 紧凑布局：批准 / 拒绝 / 查看 diff / 自动批准
 * 默认展示 diff 摘要（前 5 行），D 键展开/折叠完整 DiffView
 */

import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { theme } from '../theme'
import { DiffView } from './DiffView'

interface ApprovalPromptProps {
  tool: string
  description: string
  diff?: string
  onApprove: () => void
  onReject: (reason?: string) => void
  onAutoApprove?: () => void
}

export function ApprovalPrompt({ tool, description, diff, onApprove, onReject, onAutoApprove }: ApprovalPromptProps) {
  const [showFullDiff, setShowFullDiff] = useState(false)

  useInput((input, key) => {
    if (input === 'y' || key.return) {
      onApprove()
    } else if (input === 'n' || key.escape) {
      onReject()
    } else if (input === 'd' && diff) {
      setShowFullDiff((prev) => !prev)
    } else if (input === 'a' && onAutoApprove) {
      onAutoApprove()
    }
  })

  // diff 摘要：前 5 行
  const diffSummary = diff ? diff.split('\n').slice(0, 5).join('\n') : null
  const hasMoreLines = diff ? diff.split('\n').length > 5 : false

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.colors.warning} paddingX={1}>
      {/* 标题行 */}
      <Box>
        <Text color={theme.colors.warning} bold>⚠️ 需要审批</Text>
        <Text> </Text>
        <Text bold>{tool}</Text>
        <Text color={theme.colors.muted}> {description}</Text>
      </Box>

      {/* Diff 区域 */}
      {diff && showFullDiff ? (
        // 展开：完整 DiffView
        <Box marginTop={1} flexDirection="column">
          <DiffView diff={diff} />
        </Box>
      ) : diff && diffSummary ? (
        // 折叠：摘要
        <Box marginTop={1} flexDirection="column">
          {diffSummary.split('\n').map((line, i) => (
            <DiffSummaryLine key={i} line={line} />
          ))}
          {hasMoreLines && (
            <Text color={theme.colors.muted} dimColor>…</Text>
          )}
        </Box>
      ) : null}

      {/* 按钮行 */}
      <Box marginTop={1}>
        <Text color={theme.colors.success} bold>[Y] 批准</Text>
        <Text color={theme.colors.muted}> · </Text>
        <Text color={theme.colors.error} bold>[N] 拒绝</Text>
        {diff && (
          <>
            <Text color={theme.colors.muted}> · </Text>
            <Text color={theme.colors.primary} bold>[D] {showFullDiff ? '折叠' : '展开'}</Text>
          </>
        )}
        {onAutoApprove && (
          <>
            <Text color={theme.colors.muted}> · </Text>
            <Text color={theme.colors.accent} bold>[A] 自动</Text>
          </>
        )}
      </Box>
    </Box>
  )
}

/** Diff 摘要行 — 复用 DiffView 的着色逻辑 */
function DiffSummaryLine({ line }: { line: string }) {
  if (line.startsWith('+') && !line.startsWith('+++')) {
    return <Text color="green">{line}</Text>
  }
  if (line.startsWith('-') && !line.startsWith('---')) {
    return <Text color="red">{line}</Text>
  }
  if (line.startsWith('@@')) {
    return <Text color="cyan">{line}</Text>
  }
  return <Text color={theme.colors.muted}>{line}</Text>
}

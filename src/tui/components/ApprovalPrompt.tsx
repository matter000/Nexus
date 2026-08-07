/**
 * 审批提示组件 - 纯展示，输入由 App.tsx 的 useInput 统一处理
 */

import { Box, Text } from 'ink'
import React, { useState } from 'react'
import { theme } from '../theme'
import { DiffView } from './DiffView'

interface ApprovalPromptProps {
  tool: string
  description: string
  diff?: string
}

export function ApprovalPrompt({ tool, description, diff }: ApprovalPromptProps) {
  const [showFullDiff, setShowFullDiff] = useState(false)
  // D 键切换 diff 展开/折叠 — 仅在 App 未拦截时作为备用

  const diffSummary = diff ? diff.split('\n').slice(0, 5).join('\n') : null
  const hasMoreLines = diff ? diff.split('\n').length > 5 : false

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.colors.warning} paddingX={1}>
      <Box>
        <Text color={theme.colors.warning} bold>
          ⚠️ 需要审批
        </Text>
        <Text> </Text>
        <Text bold>{tool}</Text>
        <Text color={theme.colors.muted}> {description}</Text>
      </Box>

      {diff && showFullDiff ? (
        <Box marginTop={1} flexDirection="column">
          <DiffView diff={diff} />
        </Box>
      ) : diff && diffSummary ? (
        <Box marginTop={1} flexDirection="column">
          {diffSummary.split('\n').map((line, i) => (
            <DiffSummaryLine key={i} line={line} />
          ))}
          {hasMoreLines && (
            <Text color={theme.colors.muted} dimColor>
              …
            </Text>
          )}
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text color={theme.colors.success} bold>
          [Y] 批准
        </Text>
        <Text color={theme.colors.muted}> · </Text>
        <Text color={theme.colors.error} bold>
          [N] 拒绝
        </Text>
        {diff && (
          <>
            <Text color={theme.colors.muted}> · </Text>
            <Text color={theme.colors.primary} bold>
              [D] {showFullDiff ? '折叠' : '展开'}
            </Text>
          </>
        )}
        <Text color={theme.colors.muted}> · </Text>
        <Text color={theme.colors.accent} bold>
          [A] 自动批准此类
        </Text>
      </Box>
    </Box>
  )
}

function DiffSummaryLine({ line }: { line: string }) {
  if (line.startsWith('+') && !line.startsWith('+++'))
    return <Text color={theme.colors.success}>{line}</Text>
  if (line.startsWith('-') && !line.startsWith('---'))
    return <Text color={theme.colors.error}>{line}</Text>
  if (line.startsWith('@@')) return <Text color={theme.colors.primary}>{line}</Text>
  return <Text color={theme.colors.muted}>{line}</Text>
}

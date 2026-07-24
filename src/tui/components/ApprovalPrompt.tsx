/**
 * 审批提示组件
 * 批准 / 拒绝(可附原因) / 查看 diff
 */

import React from 'react'
import { Box, Text, useInput } from 'ink'
import { theme } from '../theme'

interface ApprovalPromptProps {
  tool: string
  description: string
  diff?: string
  onApprove: () => void
  onReject: (reason?: string) => void
}

export function ApprovalPrompt({ tool, description, diff, onApprove, onReject }: ApprovalPromptProps) {
  useInput((input, key) => {
    if (input === 'y' || key.return) {
      onApprove()
    } else if (input === 'n' || key.escape) {
      onReject()
    }
  })

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Box>
        <Text color={theme.colors.warning} bold>⚠️ 需要审批</Text>
      </Box>
      <Box marginTop={1}>
        <Text bold>{tool}</Text>
        <Text color={theme.colors.muted}> {description}</Text>
      </Box>
      {diff && (
        <Box marginTop={1} flexDirection="column">
          {diff.split('\n').slice(0, 15).map((line, i) => {
            if (line.startsWith('+') && !line.startsWith('+++')) {
              return <Text key={i} color="green">{line}</Text>
            }
            if (line.startsWith('-') && !line.startsWith('---')) {
              return <Text key={i} color="red">{line}</Text>
            }
            return <Text key={i} color="gray">{line}</Text>
          })}
        </Box>
      )}
      <Box marginTop={1}>
        <Text color="green" bold>[Y] 批准</Text>
        <Text> </Text>
        <Text color="red" bold>[N] 拒绝</Text>
      </Box>
    </Box>
  )
}

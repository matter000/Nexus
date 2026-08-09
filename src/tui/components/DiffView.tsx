/**
 * Diff 视图组件
 * 内联展示 git diff 格式，绿增红删，支持截断和统计
 */

import { Box, Text } from 'ink'
import React from 'react'
import { theme } from '../theme'

interface DiffViewProps {
  diff: string
  fileName?: string
  /** 最大显示行数（超过则截断） */
  maxLines?: number
}

export function DiffView({ diff, fileName, maxLines = 30 }: DiffViewProps) {
  const lines = diff.split('\n')
  const truncated = lines.length > maxLines
  const displayLines = truncated ? lines.slice(0, maxLines) : lines

  // 统计增删行数
  let added = 0
  let removed = 0
  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++
    if (line.startsWith('-') && !line.startsWith('---')) removed++
  }

  return (
    <Box flexDirection="column">
      {fileName && (
        <Box>
          <Text bold color={theme.colors.fg}>
            {fileName}
          </Text>
          {(added > 0 || removed > 0) && <Text color={theme.colors.muted}> </Text>}
          {added > 0 && <Text color={theme.colors.success}>+{added}</Text>}
          {added > 0 && removed > 0 && <Text color={theme.colors.muted}> </Text>}
          {removed > 0 && <Text color={theme.colors.error}>-{removed}</Text>}
        </Box>
      )}
      {displayLines.map((line, i) => (
        <DiffLine key={i} line={line} />
      ))}
      {truncated && (
        <Text color={theme.colors.muted} dimColor>
          {' '}
          ... 还有 {lines.length - maxLines} 行
        </Text>
      )}
    </Box>
  )
}

function DiffLine({ line }: { line: string }) {
  if (line.startsWith('+') && !line.startsWith('+++')) {
    return <Text color={theme.colors.success}>{line}</Text>
  }
  if (line.startsWith('-') && !line.startsWith('---')) {
    return <Text color={theme.colors.error}>{line}</Text>
  }
  if (line.startsWith('@@')) {
    return (
      <Text color={theme.colors.primary} dimColor>
        {line}
      </Text>
    )
  }
  if (line.startsWith('+++') || line.startsWith('---')) {
    return (
      <Text color={theme.colors.muted} bold>
        {line}
      </Text>
    )
  }
  return <Text color={theme.colors.muted}>{line}</Text>
}

/**
 * Diff 视图组件
 * 内联展示 git diff 格式，绿增红删，支持截断和统计
 */

import React from 'react'
import { Box, Text } from 'ink'

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
          <Text bold color="white">{fileName}</Text>
          {(added > 0 || removed > 0) && (
            <Text color="gray"> </Text>
          )}
          {added > 0 && <Text color="green">+{added}</Text>}
          {added > 0 && removed > 0 && <Text color="gray"> </Text>}
          {removed > 0 && <Text color="red">-{removed}</Text>}
        </Box>
      )}
      {displayLines.map((line, i) => (
        <DiffLine key={i} line={line} />
      ))}
      {truncated && (
        <Text color="gray" dimColor>  ... 还有 {lines.length - maxLines} 行</Text>
      )}
    </Box>
  )
}

function DiffLine({ line }: { line: string }) {
  if (line.startsWith('+') && !line.startsWith('+++')) {
    return <Text color="green">{line}</Text>
  }
  if (line.startsWith('-') && !line.startsWith('---')) {
    return <Text color="red">{line}</Text>
  }
  if (line.startsWith('@@')) {
    return <Text color="cyan" dimColor>{line}</Text>
  }
  if (line.startsWith('+++') || line.startsWith('---')) {
    return <Text color="gray" bold>{line}</Text>
  }
  return <Text color="gray">{line}</Text>
}

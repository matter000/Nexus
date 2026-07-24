/**
 * Diff 视图组件
 * 内联展示 git diff 格式,绿增红删
 */

import React from 'react'
import { Box, Text } from 'ink'

interface DiffViewProps {
  diff: string
  fileName?: string
}

export function DiffView({ diff, fileName }: DiffViewProps) {
  const lines = diff.split('\n')

  return (
    <Box flexDirection="column">
      {fileName && (
        <Text bold color="white">{fileName}</Text>
      )}
      {lines.map((line, i) => (
        <DiffLine key={i} line={line} />
      ))}
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
    return <Text color="cyan">{line}</Text>
  }
  return <Text color="gray">{line}</Text>
}

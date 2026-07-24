/**
 * 输入框组件
 * 支持多行输入、斜杠命令提示
 */

import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { theme } from '../theme'

interface InputBoxProps {
  onSubmit: (text: string) => void
  disabled?: boolean
  placeholder?: string
}

export function InputBox({ onSubmit, disabled = false, placeholder = '输入任务...' }: InputBoxProps) {
  const [value, setValue] = useState('')

  useInput((input, key) => {
    if (disabled) return

    if (key.return) {
      if (value.trim()) {
        onSubmit(value.trim())
        setValue('')
      }
      return
    }

    if (key.backspace || key.delete) {
      setValue((v) => v.slice(0, -1))
      return
    }

    if (key.escape) {
      setValue('')
      return
    }

    // 忽略控制字符
    if (key.ctrl || key.meta) return

    if (input) {
      setValue((v) => v + input)
    }
  })

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.colors.primary} bold>{'> '}</Text>
        <Text>
          {value || <Text color={theme.colors.muted} dimColor>{placeholder}</Text>}
        </Text>
        <Text color={theme.colors.primary}>▌</Text>
      </Box>
      <Box>
        <Text color={theme.colors.muted} dimColor>
          [Enter 发送] [Ctrl+C 中断] [/ 命令]
        </Text>
      </Box>
    </Box>
  )
}

/**
 * 输入框组件
 * 支持多行输入、斜杠命令提示与 Tab 自动补全
 */

import { Box, Text, useInput } from 'ink'
import React, { useMemo, useState } from 'react'
import { getAvailableCommands, getCommandCompletions } from '../../cli/commands'
import { theme } from '../theme'

interface InputBoxProps {
  onSubmit: (text: string) => void
  disabled?: boolean
  placeholder?: string
}

export function InputBox({
  onSubmit,
  disabled = false,
  placeholder = '输入任务...',
}: InputBoxProps) {
  const [value, setValue] = useState('')
  const [completionIndex, setCompletionIndex] = useState(-1)

  // 当输入以 / 开头时，计算匹配的命令补全列表
  const completions = useMemo(() => {
    if (!value.startsWith('/') || value.includes(' ')) return []
    return getCommandCompletions(value)
  }, [value])

  // 当输入 / 且无更多字符时，显示所有命令
  const showAllCommands = value === '/'
  const displayCommands = showAllCommands
    ? getAvailableCommands().map((c) => ({ name: `/${c.name}`, description: c.description }))
    : completions.length > 0 && completions.length <= 5
      ? completions.map((name) => {
          const cmd = getAvailableCommands().find((c) => `/${c.name}` === name)
          return { name, description: cmd?.description ?? '' }
        })
      : []

  useInput((input, key) => {
    if (disabled) return

    if (key.return) {
      if (value.trim()) {
        onSubmit(value.trim())
        setValue('')
        setCompletionIndex(-1)
      }
      return
    }

    // Tab 键补全斜杠命令
    if (key.tab && completions.length > 0) {
      const nextIndex = (completionIndex + 1) % completions.length
      setCompletionIndex(nextIndex)
      setValue(completions[nextIndex])
      return
    }

    if (key.backspace || key.delete) {
      setValue((v) => v.slice(0, -1))
      setCompletionIndex(-1)
      return
    }

    if (key.escape) {
      setValue('')
      setCompletionIndex(-1)
      return
    }

    // 忽略带修饰键的输入（Shift+P 留给 TodoProgress 折叠等全局快捷键）
    if (key.shift || key.ctrl || key.meta) return

    if (input) {
      setValue((v) => v + input)
      setCompletionIndex(-1)
    }
  })

  return (
    <Box flexDirection="column">
      {/* 斜杠命令自动补全提示 */}
      {displayCommands.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          {displayCommands.map((cmd) => (
            <Box key={cmd.name}>
              <Text color={theme.colors.primary} bold>
                {cmd.name}
              </Text>
              {cmd.description && (
                <Text color={theme.colors.muted} dimColor>
                  {' '}
                  — {cmd.description}
                </Text>
              )}
            </Box>
          ))}
          {completions.length > 0 && (
            <Text color={theme.colors.muted} dimColor italic>
              [Tab 切换补全]
            </Text>
          )}
        </Box>
      )}
      <Box>
        <Text color={disabled ? theme.colors.muted : theme.colors.primary} bold dimColor={disabled}>
          {'> '}
        </Text>
        <Text>
          {value || (
            <Text color={theme.colors.muted} dimColor>
              {disabled ? '执行中，无法输入' : placeholder}
            </Text>
          )}
        </Text>
        {!disabled && <Text color={theme.colors.primary}>▌</Text>}
      </Box>
    </Box>
  )
}

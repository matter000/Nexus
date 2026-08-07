/**
 * 输入框组件
 * 支持多行输入（Alt+Enter 换行，Enter 提交）、斜杠命令提示与 Tab 自动补全
 */

import { Box, Text, useInput } from 'ink'
import React, { useMemo, useRef, useState } from 'react'
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

    // Alt+Enter 换行（meta 即 Alt 键）
    if (key.return && key.meta) {
      setValue((v) => v + '\n')
      setCompletionIndex(-1)
      return
    }

    // Enter 提交
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
    // 但允许 Alt（meta）在 Alt+Enter 中已处理
    if (key.shift || key.ctrl) return

    if (input) {
      setValue((v) => v + input)
      setCompletionIndex(-1)
    }
  })

  // 显示多行内容：将 \n 拆分为多行 Text
  const displayLines = value.split('\n')
  const fieldBg = theme.surfaces.field

  return (
    <Box flexDirection="column" width="70%">
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
      <Box flexDirection="column">
        {/* 输入框：圆角边框 + 面背景，对齐画布 promptline 样式 */}
        <Box borderStyle="round" borderColor={theme.colors.border}>
          <Box>
            <Text
              color={disabled ? theme.colors.muted : theme.colors.primary}
              bold
              dimColor={disabled}
              backgroundColor={fieldBg}
            >
              {' ❯ '}
            </Text>
            {value ? (
              <Box flexDirection="column">
                {displayLines.map((line, i) => (
                  <Text key={i} backgroundColor={fieldBg}>
                    {line || ' '}
                  </Text>
                ))}
              </Box>
            ) : (
              <Text color={theme.colors.muted} dimColor backgroundColor={fieldBg}>
                {disabled ? '执行中，无法输入 ' : `${placeholder} `}
              </Text>
            )}
            {!disabled && (
              <Text color={theme.colors.primary} backgroundColor={fieldBg}>
                ▌
              </Text>
            )}
          </Box>
        </Box>
        {/* 多行提示 */}
        {value.includes('\n') && (
          <Text color={theme.colors.muted} dimColor italic>
            [Alt+Enter 换行 · Enter 提交]
          </Text>
        )}
      </Box>
    </Box>
  )
}

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
  /** 外部填入值（欢迎屏示例任务等）：变化时同步到输入框 */
  externalValue?: string
}

export function InputBox({
  onSubmit,
  disabled = false,
  placeholder = '输入任务...',
  externalValue,
}: InputBoxProps) {
  const [value, setValue] = useState('')
  const [completionIndex, setCompletionIndex] = useState(-1)
  /** 会话级输入历史栈（提交时入栈，↑/↓ 回溯） */
  const historyRef = useRef<string[]>([])
  /** 历史浏览索引：-1 表示不在浏览状态 */
  const historyIndexRef = useRef(-1)
  /** Ctrl+R 历史搜索模式：查询词 + 过滤结果选择索引 */
  const [searchMode, setSearchMode] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchIndex, setSearchIndex] = useState(0)

  // 当输入以 / 开头时，计算匹配的命令补全列表
  const completions = useMemo(() => {
    if (!value.startsWith('/') || value.includes(' ')) return []
    return getCommandCompletions(value)
  }, [value])

  // 外部填入（欢迎屏示例）：externalValue 变化时同步到输入框并清空外部态
  const externalHandledRef = useRef('')
  if (externalValue && externalValue !== externalHandledRef.current) {
    externalHandledRef.current = externalValue
    setValue(externalValue)
    setCompletionIndex(-1)
  }

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

    // Ctrl+R：激活历史搜索模式（输入关键词过滤，↑↓ 选择，Enter 提交）
    if (key.ctrl && input === 'r') {
      if (historyRef.current.length === 0) return
      setSearchMode(true)
      setSearchQuery('')
      setSearchIndex(0)
      return
    }

    // 历史搜索模式：字符累积查询词，↑↓ 选择，Enter 提交选中，Esc 退出
    if (searchMode) {
      const filtered = historyRef.current.filter((h) => h.includes(searchQuery))
      if (key.return) {
        if (filtered.length > 0) {
          const pick = filtered[Math.min(searchIndex, filtered.length - 1)]
          setValue(pick)
        }
        setSearchMode(false)
        setSearchQuery('')
        return
      }
      if (key.escape) {
        setSearchMode(false)
        setSearchQuery('')
        return
      }
      if (key.upArrow) {
        setSearchIndex((i) => Math.min(filtered.length - 1, i + 1))
        return
      }
      if (key.downArrow) {
        setSearchIndex((i) => Math.max(0, i - 1))
        return
      }
      if (key.backspace || key.delete) {
        setSearchQuery((q) => q.slice(0, -1))
        setSearchIndex(0)
        return
      }
      if (input && !key.shift && !key.ctrl) {
        setSearchQuery((q) => q + input)
        setSearchIndex(0)
        return
      }
      return
    }

    // 补全选择器激活时：↑↓ 选择补全项（优先于历史回溯），Enter/Tab 选中
    const selActive = completions.length > 0

    // Alt+Enter 换行（meta 即 Alt 键）
    if (key.return && key.meta) {
      setValue((v) => v + '\n')
      setCompletionIndex(-1)
      return
    }

    // Enter 提交：补全激活时优先选中当前补全项
    if (key.return) {
      if (selActive && completionIndex >= 0) {
        // 选中命令后追加空格（便于继续输参数，如 /goal ）
        setValue(completions[completionIndex] + ' ')
        setCompletionIndex(-1)
        return
      }
      if (value.trim()) {
        // 入历史栈（连续重复不叠加）并重置浏览索引
        const history = historyRef.current
        if (history[history.length - 1] !== value.trim()) {
          history.push(value.trim())
        }
        historyIndexRef.current = -1
        onSubmit(value.trim())
        setValue('')
        setCompletionIndex(-1)
      }
      return
    }

    // ↑ 回溯历史 / 选择补全上一项（补全激活时优先）
    if (key.upArrow) {
      if (selActive && completions.length > 0) {
        const next = completionIndex <= 0 ? completions.length - 1 : completionIndex - 1
        setCompletionIndex(next)
        setValue(completions[next])
        return
      }
      const history = historyRef.current
      if (history.length === 0) return
      const nextIndex =
        historyIndexRef.current === -1
          ? history.length - 1
          : Math.max(0, historyIndexRef.current - 1)
      historyIndexRef.current = nextIndex
      setValue(history[nextIndex])
      setCompletionIndex(-1)
      return
    }
    if (key.downArrow) {
      if (selActive && completions.length > 0) {
        const next = (completionIndex + 1) % completions.length
        setCompletionIndex(next)
        setValue(completions[next])
        return
      }
      const history = historyRef.current
      if (historyIndexRef.current === -1) return
      const nextIndex = historyIndexRef.current + 1
      if (nextIndex >= history.length) {
        historyIndexRef.current = -1
        setValue('')
      } else {
        historyIndexRef.current = nextIndex
        setValue(history[nextIndex])
      }
      setCompletionIndex(-1)
      return
    }

    // Tab 键循环补全斜杠命令（与 ↑↓ 选择同源索引）
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

    // 忽略带修饰键的输入（Shift 等组合键留给全局快捷键）
    // 但允许 Alt（meta）在 Alt+Enter 中已处理
    if (key.shift || key.ctrl) return

    if (input) {
      setValue((v) => v + input)
      setCompletionIndex(-1)
      // 手动编辑后退出历史浏览状态（再按 ↑ 从最新一条重新开始）
      historyIndexRef.current = -1
    }
  })

  // 显示多行内容：将 \n 拆分为多行 Text
  const displayLines = value.split('\n')
  const fieldBg = theme.surfaces.field

  return (
    <Box flexDirection="column" width="70%">
      {/* Ctrl+R 历史搜索：查询词 + 过滤结果（↑↓ 选择，Enter 填入输入框） */}
      {searchMode && (
        <Box flexDirection="column" marginBottom={1}>
          <Box>
            <Text color={theme.colors.accent} bold>
              🔍 历史搜索:
            </Text>
            <Text color={theme.colors.fg}>{searchQuery}</Text>
            <Text color={theme.colors.primary}>▌</Text>
          </Box>
          {historyRef.current
            .filter((h) => h.includes(searchQuery))
            .slice(0, 5)
            .map((h, i) => (
              <Box key={h + i}>
                <Text
                  color={i === searchIndex ? theme.colors.primary : theme.colors.muted}
                  bold={i === searchIndex}
                >
                  {i === searchIndex ? '▶ ' : '  '}
                  {h.length > 60 ? h.slice(0, 60) + '…' : h}
                </Text>
              </Box>
            ))}
          <Text color={theme.colors.muted} dimColor italic>
            [↑↓ 选择 · Enter 填入 · Esc 退出]
          </Text>
        </Box>
      )}

      {/* 斜杠命令自动补全提示（↑↓ 选择，当前项高亮；Tab 循环；Enter 选中） */}
      {displayCommands.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          {displayCommands.map((cmd, i) => (
            <Box key={cmd.name}>
              <Text
                color={i === completionIndex ? theme.colors.primary : theme.colors.muted}
                bold={i === completionIndex}
              >
                {i === completionIndex ? '▶ ' : '  '}
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
              [↑↓ 选择 · Tab 循环 · Enter 选中]
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
              <Text color={theme.colors.placeholder} italic backgroundColor={fieldBg}>
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

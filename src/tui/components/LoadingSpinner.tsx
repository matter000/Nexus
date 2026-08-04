/**
 * LoadingSpinner - LLM 加载动画组件
 * 在 Agent 处于 planning/executing 阶段时显示旋转动画
 */

import { Box, Text } from 'ink'
import React, { useEffect, useState } from 'react'
import { theme } from '../theme'

interface LoadingSpinnerProps {
  phase: 'planning' | 'executing' | 'verifying'
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const PHASE_LABELS: Record<string, string> = {
  planning: '正在思考方案...',
  executing: '正在执行任务...',
  verifying: '正在验证结果...',
}

export function LoadingSpinner({ phase }: LoadingSpinnerProps) {
  const [frameIndex, setFrameIndex] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => {
      setFrameIndex((i) => (i + 1) % FRAMES.length)
    }, 80)
    return () => clearInterval(timer)
  }, [])

  return (
    <Box marginY={1} marginLeft={2}>
      <Text color={theme.colors.primary}>{FRAMES[frameIndex]}</Text>
      <Text color={theme.colors.muted} italic>
        {' '}
        {PHASE_LABELS[phase] ?? '处理中...'}
      </Text>
    </Box>
  )
}

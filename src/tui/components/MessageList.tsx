/**
 * 消息列表组件
 * 渲染用户输入、assistant 输出、系统消息
 * Claude Code 风格：紧凑、角色标记清晰
 */

import { Box, Text } from 'ink'
import React from 'react'
import { theme } from '../theme'
import { Markdown } from './Markdown'

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
}

interface MessageListProps {
  messages: Message[]
}

export function MessageList({ messages }: MessageListProps) {
  return (
    <Box flexDirection="column">
      {messages.map((msg, i) => (
        <Box key={msg.id} flexDirection="column" marginTop={i > 0 ? 1 : 0}>
          <MessageItem message={msg} />
        </Box>
      ))}
    </Box>
  )
}

/** 单条消息渲染（导出供 Ink <Static> 沉降复用；memo 化避免历史消息重复重布局） */
export const MessageItem = React.memo(function MessageItem({ message }: { message: Message }) {
  if (message.role === 'user') {
    return (
      // 用户消息：右对齐，标签在框内第一行与内容连成一体（Claude Code 气泡风格）
      <Box flexDirection="column" alignItems="flex-end" marginLeft={4}>
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={theme.colors.border}
          paddingX={2}
          paddingY={1}
          width="80%"
        >
          <Text color={theme.colors.user} bold>
            {theme.symbols.user} 用户
          </Text>
          <Text>{message.content}</Text>
        </Box>
      </Box>
    )
  }

  if (message.role === 'assistant') {
    return (
      // assistant 消息：扇平极简（仿 OpenCode）——角色标记 + 缩进内容，无竖线边框
      <Box flexDirection="column">
        <Text color={theme.colors.assistant} bold>
          {theme.symbols.assistant} Nexus
        </Text>
        <Box paddingLeft={2} marginTop={0}>
          <Markdown content={message.content} />
        </Box>
      </Box>
    )
  }

  // system 消息：斜杠命令结果、错误提示等
  if (message.role === 'system') {
    return (
      <Box>
        <Text color={theme.colors.primary}>⚙ {message.content}</Text>
      </Box>
    )
  }

  return null
})

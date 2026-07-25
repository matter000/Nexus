/**
 * 消息列表组件
 * 渲染用户输入、assistant 输出、系统消息
 * Claude Code 风格：紧凑、角色标记清晰
 */

import React from 'react'
import { Box, Text } from 'ink'
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

function MessageItem({ message }: { message: Message }) {
  if (message.role === 'user') {
    return (
      <Box flexDirection="column">
        <Text color={theme.colors.user} bold>
          {theme.symbols.user} 用户
        </Text>
        <Box paddingLeft={2}>
          <Text>{message.content}</Text>
        </Box>
      </Box>
    )
  }

  if (message.role === 'assistant') {
    return (
      <Box flexDirection="column">
        <Text color={theme.colors.assistant} bold>
          {theme.symbols.assistant} Nexus
        </Text>
        <Box paddingLeft={2}>
          <Markdown content={message.content} />
        </Box>
      </Box>
    )
  }

  // system 消息：斜杠命令结果、错误提示等
  if (message.role === 'system') {
    return (
      <Box>
        <Text color={theme.colors.primary}>
          ⚙ {message.content}
        </Text>
      </Box>
    )
  }

  return null
}

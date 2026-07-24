/**
 * 消息列表组件
 * 渲染用户输入、assistant 流式输出、工具调用结果
 */

import React from 'react'
import { Box, Text } from 'ink'
import { theme } from '../theme'

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  streaming?: boolean
}

interface MessageListProps {
  messages: Message[]
}

export function MessageList({ messages }: MessageListProps) {
  return (
    <Box flexDirection="column" gap={1}>
      {messages.map((msg) => (
        <MessageItem key={msg.id} message={msg} />
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
        <Text>{message.content}</Text>
      </Box>
    )
  }

  if (message.role === 'assistant') {
    return (
      <Box flexDirection="column">
        <Text color={theme.colors.assistant} bold>
          {theme.symbols.assistant} Nexus{message.streaming ? ' (思考中...)' : ''}
        </Text>
        <Text>{message.content}</Text>
      </Box>
    )
  }

  return null
}

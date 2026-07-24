/**
 * 上下文压缩策略
 * 长会话必然爆窗口,需要分级压缩
 * - 近期完整保留
 * - 早期摘要
 * - 工具结果分级
 */

import type { ChatMessage } from '../agent/types'
import { estimateTokens } from './TokenBudget'

export interface CompressionResult {
  messages: ChatMessage[]
  originalTokens: number
  compressedTokens: number
  compressedCount: number
}

/**
 * 压缩对话历史
 * @param messages 完整消息列表
 * @param recentKeep 近期完整保留的轮数
 * @param maxTokens 目标 token 上限
 */
export function compressHistory(
  messages: ChatMessage[],
  recentKeep: number,
  maxTokens: number
): CompressionResult {
  const originalTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0)

  if (originalTokens <= maxTokens) {
    return { messages, originalTokens, compressedTokens: originalTokens, compressedCount: 0 }
  }

  // 分离:近期消息完整保留,早期消息压缩
  const recentMessages = messages.slice(-recentKeep * 2) // 每轮约 2 条(user + assistant)
  const earlyMessages = messages.slice(0, -recentKeep * 2)

  if (earlyMessages.length === 0) {
    return { messages, originalTokens, compressedTokens: originalTokens, compressedCount: 0 }
  }

  // 压缩早期消息
  const compressedEarly = compressEarlyMessages(earlyMessages)
  const result = [...compressedEarly, ...recentMessages]

  const compressedTokens = result.reduce((sum, m) => sum + estimateTokens(m.content), 0)

  return {
    messages: result,
    originalTokens,
    compressedTokens,
    compressedCount: earlyMessages.length - compressedEarly.length,
  }
}

/** 压缩早期消息为摘要 */
function compressEarlyMessages(messages: ChatMessage[]): ChatMessage[] {
  const summaryParts: string[] = []
  let currentToolResults: string[] = []

  for (const msg of messages) {
    if (msg.role === 'user') {
      // 保留用户请求的摘要
      const truncated = msg.content.length > 200 ? msg.content.slice(0, 200) + '...' : msg.content
      summaryParts.push(`用户请求: ${truncated}`)
    } else if (msg.role === 'assistant') {
      // 保留 assistant 的关键决策
      const truncated = msg.content.length > 300 ? msg.content.slice(0, 300) + '...' : msg.content
      if (truncated.trim()) {
        summaryParts.push(`执行: ${truncated}`)
      }
    } else if (msg.role === 'tool') {
      // 工具结果分级压缩
      const compressed = compressToolResult(msg)
      if (compressed) {
        currentToolResults.push(compressed)
      }
    }
  }

  // 将工具结果摘要合并
  if (currentToolResults.length > 0) {
    summaryParts.push(`工具调用摘要: ${currentToolResults.join('; ')}`)
  }

  if (summaryParts.length === 0) {
    return []
  }

  // 生成一条摘要消息
  return [{
    role: 'user',
    content: `[历史摘要 - 早期 ${messages.length} 条消息已压缩]\n${summaryParts.join('\n')}`,
  }]
}

/** 工具结果分级压缩 */
function compressToolResult(msg: ChatMessage): string | null {
  const content = msg.content
  const name = msg.name ?? 'unknown'

  // bash 失败输出:完整保留(错误信息对 debug 至关重要)
  if (name === 'bash' && content.includes('Exit code:') && !content.includes('Exit code: 0')) {
    return `[bash 失败] ${content.slice(0, 500)}`
  }

  // read_file 结果:只保留文件路径
  if (name === 'read_file') {
    const firstLine = content.split('\n')[0] ?? ''
    return `[读取了 ${firstLine}]`
  }

  // grep 结果:保留匹配数
  if (name === 'grep') {
    const firstLine = content.split('\n')[0] ?? ''
    return `[${firstLine}]`
  }

  // bash 成功输出:保留 exit code + 摘要
  if (name === 'bash') {
    const lines = content.split('\n')
    const exitLine = lines.find((l) => l.startsWith('Exit code:')) ?? ''
    return `[bash ${exitLine}]`
  }

  // edit_file:保留文件路径
  if (name === 'edit_file') {
    const firstLine = content.split('\n')[0] ?? ''
    return `[${firstLine}]`
  }

  // 其他:截断
  return `[${name}] ${content.slice(0, 100)}`
}

/** 压缩单条工具结果(用于实时压缩) */
export function compressSingleToolResult(toolName: string, result: string, hasError: boolean): string {
  // 错误完整保留
  if (hasError) return result

  // 成功结果按类型压缩
  switch (toolName) {
    case 'read_file': {
      const firstLine = result.split('\n')[0] ?? ''
      return `[已读取 ${firstLine}，如需再次查看请重新调用 read_file]`
    }
    case 'bash': {
      const lines = result.split('\n')
      const exitLine = lines.find((l) => l.startsWith('Exit code:')) ?? 'Exit code: 0'
      const outputLines = lines.slice(2, 7).join('\n')
      return `${exitLine}\n${outputLines}${lines.length > 7 ? '\n...(输出已压缩)' : ''}`
    }
    default:
      return result.length > 1000 ? result.slice(0, 1000) + '\n...(已截断)' : result
  }
}

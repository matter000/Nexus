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

/** 压缩早期消息为摘要，按轮次分组 */
function compressEarlyMessages(messages: ChatMessage[]): ChatMessage[] {
  // 按轮次分组：每轮 = user + assistant(+ tool results)
  const rounds: ChatMessage[][] = []
  let currentRound: ChatMessage[] = []

  for (const msg of messages) {
    if (msg.role === 'user' && currentRound.length > 0) {
      rounds.push(currentRound)
      currentRound = []
    }
    currentRound.push(msg)
  }
  if (currentRound.length > 0) rounds.push(currentRound)

  // 每轮压缩为一条摘要
  const roundSummaries: string[] = []
  for (let i = 0; i < rounds.length; i++) {
    const round = rounds[i]
    const summary = summarizeRound(round, i + 1)
    if (summary) roundSummaries.push(summary)
  }

  if (roundSummaries.length === 0) return []

  // 生成一条摘要消息
  return [{
    role: 'user',
    content: `[历史摘要 - 早期 ${messages.length} 条消息(${rounds.length} 轮)已压缩]\n${roundSummaries.join('\n')}`,
  }]
}

/** 将单轮对话压缩为摘要行 */
function summarizeRound(round: ChatMessage[], roundNum: number): string | null {
  let userRequest = ''
  const agentActions: string[] = []
  const toolResults: string[] = []

  for (const msg of round) {
    if (msg.role === 'user') {
      userRequest = msg.content.length > 120 ? msg.content.slice(0, 120) + '...' : msg.content
    } else if (msg.role === 'assistant') {
      const truncated = msg.content.length > 200 ? msg.content.slice(0, 200) + '...' : msg.content
      if (truncated.trim()) agentActions.push(truncated)
    } else if (msg.role === 'tool') {
      const compressed = compressToolResult(msg)
      if (compressed) toolResults.push(compressed)
    }
  }

  if (!userRequest && agentActions.length === 0 && toolResults.length === 0) return null

  const parts: string[] = [`[轮次${roundNum}]`]
  if (userRequest) parts.push(`用户请求: ${userRequest}`)
  if (agentActions.length > 0) parts.push(`Agent 操作: ${agentActions.join('; ')}`)
  if (toolResults.length > 0) parts.push(`结果: ${toolResults.join('; ')}`)
  return parts.join(' | ')
}

/** 工具结果分级压缩(用于早期消息摘要) */
function compressToolResult(msg: ChatMessage): string | null {
  const content = msg.content
  const name = msg.name ?? 'unknown'

  // bash 失败输出:完整保留(错误信息对 debug 至关重要)
  if (name === 'bash' && content.includes('Exit code:') && !content.includes('Exit code: 0')) {
    return `[bash 失败] ${content.slice(0, 500)}`
  }

  // read_file 结果:只保留文件路径，丢弃内容(agent 可重新读取)
  if (name === 'read_file') {
    const firstLine = content.split('\n')[0] ?? ''
    return `[读取了 ${firstLine}]`
  }

  // grep 结果:保留命中的 文件:行号，丢弃上下文行
  if (name === 'grep') {
    const lines = content.split('\n')
    const matchLines = lines.filter((l) => /^\S+:\d+/.test(l))
    if (matchLines.length > 0) {
      const summary = matchLines.slice(0, 5).join(', ')
      return `[grep 命中: ${summary}${matchLines.length > 5 ? ` ...共${matchLines.length}处` : ''}]`
    }
    const firstLine = lines[0] ?? ''
    return `[${firstLine}]`
  }

  // bash 成功输出:保留 exit code + 前 5 行摘要
  if (name === 'bash') {
    const lines = content.split('\n')
    const exitLine = lines.find((l) => l.startsWith('Exit code:')) ?? 'Exit code: 0'
    const outputPreview = lines.filter((l) => !l.startsWith('Exit code:') && l.trim()).slice(0, 3).join('; ')
    return `[bash ${exitLine}${outputPreview ? ' | ' + outputPreview : ''}]`
  }

  // edit_file:保留路径和 diff 摘要
  if (name === 'edit_file') {
    const lines = content.split('\n')
    const pathLine = lines[0] ?? ''
    // 提取 diff 关键信息：增删行数
    const added = lines.filter((l) => l.startsWith('+')).length
    const removed = lines.filter((l) => l.startsWith('-')).length
    const diffSummary = added || removed ? ` (+${added}/-${removed})` : ''
    return `[编辑 ${pathLine}${diffSummary}]`
  }

  // 其他:截断
  return `[${name}] ${content.slice(0, 100)}`
}

/** 压缩单条工具结果(用于实时压缩，在喂回 LLM 之前调用) */
export function compressSingleToolResult(toolName: string, result: string, hasError: boolean): string {
  // 错误完整保留(错误信息对 debug 至关重要)
  if (hasError) return result

  // 成功结果按类型压缩
  switch (toolName) {
    case 'read_file': {
      // 只保留文件路径，丢弃内容(agent 可重新读取)
      const firstLine = result.split('\n')[0] ?? ''
      return `[已读取 ${firstLine}，如需再次查看请重新调用 read_file]`
    }
    case 'grep': {
      // 保留命中的 文件:行号，丢弃上下文行
      const lines = result.split('\n')
      const matchLines = lines.filter((l) => /^\S+:\d+/.test(l))
      if (matchLines.length > 0) {
        return matchLines.join('\n') + (matchLines.length < lines.length ? '\n...(上下文行已省略)' : '')
      }
      return result.length > 1000 ? result.slice(0, 1000) + '\n...(已截断)' : result
    }
    case 'bash': {
      const lines = result.split('\n')
      // 检查是否为失败
      const isFailed = lines.some((l) => l.startsWith('Exit code:') && l !== 'Exit code: 0')
      if (isFailed) return result // 失败完整保留
      // 成功：保留 exit code + 前 5 行摘要
      const exitLine = lines.find((l) => l.startsWith('Exit code:')) ?? 'Exit code: 0'
      const outputLines = lines.filter((l) => !l.startsWith('Exit code:') && l.trim()).slice(0, 5)
      const output = outputLines.join('\n')
      const totalOutput = lines.filter((l) => !l.startsWith('Exit code:') && l.trim()).length
      return `${exitLine}\n${output}${totalOutput > 5 ? `\n...(输出已压缩，共${totalOutput}行)` : ''}`
    }
    case 'edit_file': {
      // 保留路径和 diff 摘要
      const lines = result.split('\n')
      const pathLine = lines[0] ?? ''
      const added = lines.filter((l) => l.startsWith('+')).length
      const removed = lines.filter((l) => l.startsWith('-')).length
      const diffSummary = added || removed ? `\n变更: +${added}/-${removed} 行` : ''
      return `[已编辑 ${pathLine}${diffSummary}]`
    }
    default:
      return result.length > 1000 ? result.slice(0, 1000) + '\n...(已截断)' : result
  }
}

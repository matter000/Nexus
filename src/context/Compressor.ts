/**
 * 上下文压缩策略
 * 长会话必然爆窗口,需要分级压缩
 * - 近期完整保留
 * - 早期摘要
 * - 工具结果分级
 */

import type { LanguageModel } from 'ai'
import { generateText } from 'ai'
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
  maxTokens: number,
): CompressionResult {
  const originalTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0)

  if (originalTokens <= maxTokens) {
    return { messages, originalTokens, compressedTokens: originalTokens, compressedCount: 0 }
  }

  // 分离:近期消息完整保留,早期消息压缩
  // 按 user 消息数切分，而非假设每轮 2 条（实际可能含多条 tool 消息）
  const recentMessages = keepRecentTurns(messages, recentKeep)
  const earlyMessages = messages.slice(0, messages.length - recentMessages.length)

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

/** 从消息列表末尾保留指定轮次的完整消息（按 user 消息计数） */
function keepRecentTurns(messages: ChatMessage[], turnsToKeep: number): ChatMessage[] {
  let userCount = 0
  let splitIndex = messages.length
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      userCount++
      if (userCount > turnsToKeep) {
        splitIndex = i + 1
        break
      }
    }
  }
  return messages.slice(splitIndex)
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
  return [
    {
      role: 'user',
      content: `[历史摘要 - 早期 ${messages.length} 条消息(${rounds.length} 轮)已压缩]\n${roundSummaries.join('\n')}`,
    },
  ]
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

/** 检查 bash 工具结果是否执行失败（基于 Exit code 行精确定位） */
function isBashFailed(result: string): boolean {
  const lines = result.split('\n')
  return lines.some((l) => {
    const trimmed = l.trim()
    return /^Exit code:\s*[1-9]\d*$/.test(trimmed)
  })
}

/** 工具结果分级压缩(用于早期消息摘要) */
function compressToolResult(msg: ChatMessage): string | null {
  const content = msg.content
  const name = msg.name ?? 'unknown'

  // bash 失败输出:完整保留(错误信息对 debug 至关重要)
  if (name === 'bash') {
    const isFailed = isBashFailed(content)
    if (isFailed) return `[bash 失败] ${content.slice(0, 500)}`
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
    const outputPreview = lines
      .filter((l) => !l.startsWith('Exit code:') && l.trim())
      .slice(0, 3)
      .join('; ')
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
export function compressSingleToolResult(
  toolName: string,
  result: string,
  hasError: boolean,
): string {
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
        return (
          matchLines.join('\n') + (matchLines.length < lines.length ? '\n...(上下文行已省略)' : '')
        )
      }
      return result.length > 1000 ? result.slice(0, 1000) + '\n...(已截断)' : result
    }
    case 'bash': {
      const lines = result.split('\n')
      // 失败完整保留
      if (isBashFailed(result)) return result
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

// ─── LLM 驱动的智能压缩 ────────────────────────────────────────────────────────

export interface LLMCompressionResult {
  /** 压缩后的消息列表（摘要 + 近期消息） */
  messages: ChatMessage[]
  /** 压缩前的 token 数 */
  originalTokens: number
  /** 压缩后的 token 数 */
  compressedTokens: number
  /** 是否实际执行了压缩 */
  compressed: boolean
}

/**
 * LLM 驱动的智能压缩
 * 用 summarizer 模型将旧对话压缩为结构化摘要，保留关键决策和文件路径
 */
export async function llmCompressHistory(
  messages: ChatMessage[],
  model: LanguageModel,
  recentKeep: number,
  maxTokens: number,
): Promise<LLMCompressionResult> {
  const originalTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0)

  // 未超阈值，不压缩
  if (originalTokens <= maxTokens * 0.7) {
    return { messages, originalTokens, compressedTokens: originalTokens, compressed: false }
  }

  // 分离近期和早期消息（按 user 消息计数）
  const recentMessages = keepRecentTurns(messages, recentKeep)
  const earlyMessages = messages.slice(0, messages.length - recentMessages.length)

  if (earlyMessages.length < 4) {
    return { messages, originalTokens, compressedTokens: originalTokens, compressed: false }
  }

  // 构建早期消息的简化文本（截断过长的单条消息）
  const earlyText = earlyMessages
    .map((m) => {
      const prefix = m.role === 'user' ? '用户' : m.role === 'assistant' ? 'Agent' : '工具'
      const content = m.content.length > 500 ? m.content.slice(0, 500) + '...' : m.content
      return `[${prefix}] ${content}`
    })
    .join('\n\n')

  const summaryPrompt = `请将以下对话历史压缩为结构化摘要。保留：
1. 用户的原始需求和关键决策
2. 修改过的文件路径和具体操作
3. 未解决的问题或待办事项
4. 重要的错误信息和解决方案

丢弃：冗余的工具输出、重复的文件读取、中间探索过程。

输出格式：
## 对话摘要
- 需求: ...
- 已完成: ...
- 修改文件: ...
- 待处理: ...

--- 历史对话 ---
${earlyText}`

  try {
    const result = await generateText({
      model,
      system: '你是对话压缩助手。将冗长的对话历史压缩为简洁的结构化摘要，保留关键信息。',
      messages: [{ role: 'user', content: summaryPrompt }],
      maxTokens: 1000,
    })

    const summary = result.text
    if (!summary || summary.length < 50) {
      // LLM 压缩失败，回退到规则压缩
      const fallback = compressHistory(messages, recentKeep, maxTokens)
      return {
        messages: fallback.messages,
        originalTokens,
        compressedTokens: fallback.compressedTokens,
        compressed: fallback.compressedCount > 0,
      }
    }

    const compressedMessages: ChatMessage[] = [
      {
        role: 'user',
        content: `[历史摘要 - ${earlyMessages.length} 条消息已由 LLM 压缩]\n${summary}`,
      },
      ...recentMessages,
    ]

    const compressedTokens = compressedMessages.reduce(
      (sum, m) => sum + estimateTokens(m.content),
      0,
    )

    return {
      messages: compressedMessages,
      originalTokens,
      compressedTokens,
      compressed: true,
    }
  } catch {
    // LLM 调用失败，回退到规则压缩
    const fallback = compressHistory(messages, recentKeep, maxTokens)
    return {
      messages: fallback.messages,
      originalTokens,
      compressedTokens: fallback.compressedTokens,
      compressed: fallback.compressedCount > 0,
    }
  }
}

/**
 * Compactor - 执行循环内自适应上下文压实
 *
 * 目标：让执行循环主动维持高水位上下文利用——窗口充裕时全量保留（不浪费），
 * 水位升高时按“便宜的先跑、贵的后跑”分级压实：
 * - none：低于 compactionThreshold，不压实（最大化利用窗口）
 * - micro：介于两阈值之间，零 API 成本压缩早期工具结果（复用 Compressor 分级规则）
 * - emergency：超过 emergencyThreshold，用 summarizer 模型把前期迭代摘要为一条消息
 *
 * 结构安全约束：压实只替换消息内容或以“完整轮次边界”裁剪，
 * 绝不拆散 assistant(tool-call) 与 tool(result) 的配对
 * （DeepSeek/OpenAI 硬约束，normalizeMessagesForSDK 依赖此结构）。
 */

import type { LanguageModel } from 'ai'
import { generateText } from 'ai'
import type { ExecMessage } from '../agent/types'
import { compressSingleToolResult } from './Compressor'
import { estimateTokens } from './TokenBudget'

export interface CompactorConfig {
  /** 当前模型的上下文窗口大小（token） */
  contextWindow: number
  /** 开始微压实的水位（占窗口比例） */
  compactionThreshold: number
  /** 触发紧急压实的水位（占窗口比例） */
  emergencyThreshold: number
  /** 保持完整不压缩的最近工具结果条数 */
  keepRecentResultsFull: number
}

export type CompactionLevel = 'none' | 'micro' | 'emergency'

/** 根据当前 prompt token 占用判定压实档位 */
export function compactionLevel(promptTokens: number, cfg: CompactorConfig): CompactionLevel {
  if (cfg.contextWindow <= 0) return 'none'
  const ratio = promptTokens / cfg.contextWindow
  if (ratio > cfg.emergencyThreshold) return 'emergency'
  if (ratio > cfg.compactionThreshold) return 'micro'
  return 'none'
}

/** tool 消息中单个结果的失败判定（失败输出必须完整保留，错误信息是 debug 关键） */
function isFailedResult(toolName: string, result: string): boolean {
  if (result.startsWith('[错误]') || result.startsWith('[拒绝]')) return true
  if (toolName === 'bash') {
    return result.split('\n').some((l) => /^Exit code:\s*[1-9]\d*$/.test(l.trim()))
  }
  return false
}

/** 判断 tool 消息整体是否为失败输出（任一分片失败即视为失败） */
function isFailedToolMessage(msg: Extract<ExecMessage, { role: 'tool' }>): boolean {
  return msg.content.some((part) => isFailedResult(part.toolName, part.result))
}

export interface CompactionResult {
  messages: ExecMessage[]
  /** 是否实际发生了压实 */
  changed: boolean
}

/**
 * 微压实：压缩早期 tool 消息的内容（零 API 成本）。
 * 保留最近 keepRecent 条 tool 结果完整；失败输出始终完整保留。
 * 只替换内容，不增删消息，tool-call/tool-result 配对天然不变。
 */
export function microCompactMessages(
  messages: ExecMessage[],
  keepRecentResultsFull: number,
): CompactionResult {
  const toolIndices: number[] = []
  messages.forEach((m, i) => {
    if (m.role === 'tool') toolIndices.push(i)
  })

  if (toolIndices.length <= keepRecentResultsFull) {
    return { messages, changed: false }
  }

  // 最近 keepRecent 条 tool 消息的分界索引（该索引及之后保持完整）
  const boundary = toolIndices[toolIndices.length - keepRecentResultsFull]
  let changed = false

  const result = messages.map((m, i) => {
    if (m.role !== 'tool' || i >= boundary) return m
    if (isFailedToolMessage(m)) return m // 失败输出完整保留
    // 已压缩过的结果再压缩是幂等的（短文本原样返回），无需额外标记
    const compressedParts = m.content.map((part) => ({
      ...part,
      result: compressSingleToolResult(
        part.toolName,
        part.result,
        isFailedResult(part.toolName, part.result),
      ),
    }))
    const before = m.content.reduce((s, p) => s + p.result.length, 0)
    const after = compressedParts.reduce((s, p) => s + p.result.length, 0)
    if (after < before) changed = true
    return { ...m, content: compressedParts }
  })

  return { messages: result, changed }
}

/**
 * 紧急压实：用 summarizer 模型把前期迭代摘要为一条消息，保留最近若干轮工具结果完整。
 * 裁剪点回退到完整轮次边界（配对的 assistant + tool 一起保留），不拆配对。
 * LLM 失败时回退微压实，绝不阻塞执行循环。
 */
export async function emergencyCompactMessages(
  messages: ExecMessage[],
  model: LanguageModel,
  keepRecentResultsFull: number,
): Promise<CompactionResult> {
  const toolIndices: number[] = []
  messages.forEach((m, i) => {
    if (m.role === 'tool') toolIndices.push(i)
  })

  if (toolIndices.length <= keepRecentResultsFull) {
    return { messages, changed: false }
  }

  // 保留段的起点：第 (n - keepRecent) 条 tool 消息，再回退到它配对的 assistant 消息
  const firstKeptToolIdx = toolIndices[toolIndices.length - keepRecentResultsFull]
  let cutIdx = firstKeptToolIdx
  for (let i = firstKeptToolIdx - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      cutIdx = i
      break
    }
  }

  const early = messages.slice(0, cutIdx)
  const recent = messages.slice(cutIdx)
  if (early.length === 0) {
    return microCompactMessages(messages, keepRecentResultsFull)
  }

  // 早期消息的简化文本（单条截断，防摘要请求自身爆窗口）
  const earlyText = early
    .map((m) => {
      const prefix = m.role === 'user' ? '用户' : m.role === 'assistant' ? 'Agent' : '工具结果'
      const content = m.role === 'tool' ? summarizeToolParts(m) : m.content
      const truncated = content.length > 500 ? `${content.slice(0, 500)}...` : content
      return `[${prefix}] ${truncated}`
    })
    .join('\n\n')

  const summaryPrompt = `请将以下 Agent 执行历史压缩为结构化摘要，供 Agent 继续后续工作。必须保留：
1. 当前任务目标与已批准的执行计划
2. 已完成的步骤与修改过的文件路径
3. 关键的代码事实（函数签名、约束、已确认的行为）
4. 未解决的问题与待办事项

丢弃：冗余的工具输出细节、重复读取、已确认无误的中间状态。

输出格式：
## 执行摘要
- 目标: ...
- 已完成: ...
- 关键文件与事实: ...
- 待处理: ...

--- 执行历史 ---
${earlyText}`

  try {
    const result = await generateText({
      model,
      system:
        '你是上下文压缩助手。将 Agent 执行历史压缩为简洁准确的结构化摘要，保留继续工作所需的关键信息，不臆造事实。',
      messages: [{ role: 'user', content: summaryPrompt }],
      maxOutputTokens: 1500,
    })

    const summary = result.text
    if (!summary || summary.length < 50) {
      return microCompactMessages(messages, keepRecentResultsFull)
    }

    return {
      messages: [
        {
          role: 'user',
          content: `[上下文压实 - 前期 ${early.length} 条消息已摘要，最近工具结果完整保留]\n${summary}`,
        },
        ...recent,
      ],
      changed: true,
    }
  } catch {
    // LLM 摘要失败：回退零成本微压实，绝不阻塞执行
    return microCompactMessages(messages, keepRecentResultsFull)
  }
}

/** tool 消息转摘要输入文本（各分片结果拼接） */
function summarizeToolParts(msg: Extract<ExecMessage, { role: 'tool' }>): string {
  return msg.content.map((p) => `${p.toolName}: ${p.result}`).join(' | ')
}

/** 估算 ExecMessage 列表的总 token 数（供水位观测/测试） */
export function estimateExecMessagesTokens(messages: ExecMessage[]): number {
  let total = 0
  for (const m of messages) {
    if (m.role === 'tool') {
      total += m.content.reduce((s, p) => s + estimateTokens(p.result), 0)
    } else {
      total += estimateTokens(m.content)
    }
  }
  return total
}

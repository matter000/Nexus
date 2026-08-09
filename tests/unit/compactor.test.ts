/**
 * 单元测试: Compactor 执行循环自适应压实
 * 覆盖水位分档、微压实（保留最近 N 条/失败不压缩/配对安全）、紧急压实 LLM 失败回退。
 */

import { describe, expect, it, mock } from 'bun:test'
import type { ExecMessage } from '../../src/agent/types'

// 紧急压实依赖 generateText：此套件中令其失败，验证回退微压实路径
;(mock as any).module('ai', () => ({
  generateText: async () => {
    throw new Error('summarizer unavailable')
  },
}))

import {
  compactionLevel,
  emergencyCompactMessages,
  estimateExecMessagesTokens,
  microCompactMessages,
} from '../../src/context/Compactor'

const CFG = {
  contextWindow: 1000,
  compactionThreshold: 0.6,
  emergencyThreshold: 0.9,
  keepRecentResultsFull: 2,
}

function toolMsg(callId: string, toolName: string, result: string): ExecMessage {
  return {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: callId, toolName, result }],
  }
}

function asstMsg(toolCallIds: string[]): ExecMessage {
  return {
    role: 'assistant',
    content: '执行中',
    toolCalls: toolCallIds.map((id) => ({
      toolCallId: id,
      toolName: 'read_file',
      args: { path: 'src/a.ts' },
    })),
  }
}

function userMsg(text: string): ExecMessage {
  return { role: 'user', content: text }
}

describe('compactionLevel 水位分档', () => {
  it('低于阈值不压实', () => {
    expect(compactionLevel(500, CFG)).toBe('none')
    expect(compactionLevel(600, CFG)).toBe('none')
  })

  it('介于两阈值之间为微压实', () => {
    expect(compactionLevel(601, CFG)).toBe('micro')
    expect(compactionLevel(900, CFG)).toBe('micro')
  })

  it('超过紧急阈值为紧急压实', () => {
    expect(compactionLevel(901, CFG)).toBe('emergency')
  })

  it('窗口为 0 时不压实（防除零）', () => {
    expect(compactionLevel(999, { ...CFG, contextWindow: 0 })).toBe('none')
  })
})

describe('microCompactMessages 微压实', () => {
  it('工具结果数不超过 keep 时不压实', () => {
    const messages: ExecMessage[] = [
      userMsg('计划'),
      asstMsg(['c1']),
      toolMsg('c1', 'read_file', 'src/a.ts 内容'.repeat(50)),
    ]
    const result = microCompactMessages(messages, 2)
    expect(result.changed).toBe(false)
    expect(result.messages).toBe(messages)
  })

  it('压缩早期工具结果，最近 keep 条完整保留', () => {
    const longRead = 'x'.repeat(3000)
    const messages: ExecMessage[] = [
      userMsg('计划'),
      asstMsg(['c1']),
      toolMsg('c1', 'read_file', `src/a.ts (100 行)\n${longRead}`),
      asstMsg(['c2']),
      toolMsg('c2', 'read_file', `src/b.ts (100 行)\n${longRead}`),
      asstMsg(['c3']),
      toolMsg('c3', 'read_file', `src/c.ts (100 行)\n${longRead}`),
      asstMsg(['c4']),
      toolMsg('c4', 'read_file', `src/d.ts (100 行)\n${longRead}`),
    ]

    const before = estimateExecMessagesTokens(messages)
    const result = microCompactMessages(messages, 2)
    const after = estimateExecMessagesTokens(result.messages)

    expect(result.changed).toBe(true)
    expect(after).toBeLessThan(before)

    // 早期 read_file 被压缩为占位摘要
    const early = result.messages[2] as Extract<ExecMessage, { role: 'tool' }>
    expect(early.content[0].result).toContain('如需再次查看请重新调用 read_file')
    // 最近 2 条完整保留
    const recent1 = result.messages[6] as Extract<ExecMessage, { role: 'tool' }>
    const recent2 = result.messages[8] as Extract<ExecMessage, { role: 'tool' }>
    expect(recent1.content[0].result).toContain(longRead)
    expect(recent2.content[0].result).toContain(longRead)
  })

  it('失败输出始终完整保留', () => {
    const errorMsg = `[错误] 测试失败\n${'stack line\n'.repeat(100)}`
    const messages: ExecMessage[] = [
      asstMsg(['c1']),
      toolMsg('c1', 'bash', errorMsg),
      asstMsg(['c2']),
      toolMsg('c2', 'read_file', 'src/b.ts\n' + 'y'.repeat(3000)),
      asstMsg(['c3']),
      toolMsg('c3', 'read_file', 'src/c.ts\n' + 'z'.repeat(3000)),
    ]
    const result = microCompactMessages(messages, 2)
    const failed = result.messages[1] as Extract<ExecMessage, { role: 'tool' }>
    expect(failed.content[0].result).toBe(errorMsg)
  })

  it('压实不增删消息、不拆 tool-call/tool-result 配对', () => {
    const longRead = 'src/a.ts\n' + 'q'.repeat(3000)
    const messages: ExecMessage[] = [
      asstMsg(['c1']),
      toolMsg('c1', 'read_file', longRead),
      asstMsg(['c2']),
      toolMsg('c2', 'read_file', longRead),
      asstMsg(['c3']),
      toolMsg('c3', 'read_file', longRead),
    ]
    const result = microCompactMessages(messages, 1)

    expect(result.messages.length).toBe(messages.length)
    const toolCountBefore = messages.filter((m) => m.role === 'tool').length
    const toolCountAfter = result.messages.filter((m) => m.role === 'tool').length
    expect(toolCountAfter).toBe(toolCountBefore)

    // assistant 消息（含 toolCalls）原样保留 → 配对结构不变
    messages.forEach((m, i) => {
      if (m.role === 'assistant') {
        expect(result.messages[i]).toBe(m)
      }
    })
  })
})

describe('emergencyCompactMessages 紧急压实', () => {
  it('LLM 摘要失败时回退微压实（不阻塞执行）', async () => {
    const longRead = 'src/a.ts\n' + 'w'.repeat(3000)
    const messages: ExecMessage[] = [
      userMsg('计划'),
      asstMsg(['c1']),
      toolMsg('c1', 'read_file', longRead),
      asstMsg(['c2']),
      toolMsg('c2', 'read_file', longRead),
      asstMsg(['c3']),
      toolMsg('c3', 'read_file', longRead),
    ]
    // generateText 被 mock 为抛错 → 应回退微压实而非抛出
    const result = await emergencyCompactMessages(messages, {} as never, 1)
    expect(result.changed).toBe(true)
    // 回退后仍是全量消息（微压实不增删消息）
    expect(result.messages.length).toBe(messages.length)
  })

  it('工具结果不足 keep 时不压实', async () => {
    const messages: ExecMessage[] = [userMsg('计划'), asstMsg(['c1']), toolMsg('c1', 'bash', 'ok')]
    const result = await emergencyCompactMessages(messages, {} as never, 2)
    expect(result.changed).toBe(false)
  })
})

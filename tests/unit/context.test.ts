/**
 * 单元测试: TokenBudget 和 Compressor
 */

import { describe, it, expect } from 'bun:test'
import { estimateTokens, TokenBudget } from '../../src/context/TokenBudget'
import { compressHistory, compressSingleToolResult } from '../../src/context/Compressor'
import type { ChatMessage } from '../../src/agent/types'

describe('TokenBudget', () => {
  describe('estimateTokens', () => {
    it('空字符串返回 0', () => {
      expect(estimateTokens('')).toBe(0)
    })

    it('英文文本估算合理', () => {
      const tokens = estimateTokens('Hello, world! This is a test.')
      expect(tokens).toBeGreaterThan(0)
      expect(tokens).toBeLessThan(20)
    })

    it('中文文本估算合理', () => {
      const tokens = estimateTokens('你好世界，这是一个测试。')
      expect(tokens).toBeGreaterThan(0)
      expect(tokens).toBeLessThan(20)
    })

    it('长文本 token 数大于短文本', () => {
      const short = estimateTokens('hi')
      const long = estimateTokens('This is a much longer text that should have more tokens than the short one.')
      expect(long).toBeGreaterThan(short)
    })
  })

  describe('TokenBudget class', () => {
    it('正确计算输入预算', () => {
      const budget = new TokenBudget(200000, 0.8, 4096)
      const inputBudget = budget.getInputBudget()
      // 200000 * 0.8 - 4096 = 155904
      expect(inputBudget).toBe(155904)
    })

    it('正确分配各层预算', () => {
      const budget = new TokenBudget(200000, 0.8, 4096)
      const allocation = budget.allocate()
      expect(allocation.systemPrompt).toBeGreaterThan(0)
      expect(allocation.history).toBeGreaterThan(0)
      expect(allocation.toolResults).toBeGreaterThan(0)
      expect(allocation.reserved).toBe(4096)
      // 各层之和应接近输入预算(Math.floor 可能导致 1-2 token 误差)
      const sum = allocation.systemPrompt + allocation.history + allocation.toolResults
      expect(Math.abs(sum - budget.getInputBudget())).toBeLessThanOrEqual(2)
    })

    it('正确判断超预算', () => {
      const budget = new TokenBudget(1000, 0.8, 100)
      // 输入预算 = 1000 * 0.8 - 100 = 700
      expect(budget.isOverBudget(600)).toBe(false)
      expect(budget.isOverBudget(800)).toBe(true)
    })

    it('正确计算溢出量', () => {
      const budget = new TokenBudget(1000, 0.8, 100)
      expect(budget.getOverflow(600)).toBe(0)
      expect(budget.getOverflow(800)).toBe(100) // 800 - 700
    })
  })
})

describe('Compressor', () => {
  describe('compressHistory', () => {
    it('短历史不压缩', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      ]
      const result = compressHistory(messages, 5, 10000)
      expect(result.messages.length).toBe(2)
      expect(result.compressedCount).toBe(0)
    })

    it('长历史触发压缩', () => {
      const messages: ChatMessage[] = []
      for (let i = 0; i < 30; i++) {
        messages.push({ role: 'user', content: `Message ${i} with some content to fill space` })
        messages.push({ role: 'assistant', content: `Response ${i} with some content` })
      }
      const result = compressHistory(messages, 3, 500)
      expect(result.messages.length).toBeLessThan(messages.length)
      expect(result.compressedCount).toBeGreaterThan(0)
    })
  })

  describe('compressSingleToolResult', () => {
    it('错误结果完整保留', () => {
      const error = 'File not found: src/missing.ts'
      const result = compressSingleToolResult('read_file', error, true)
      expect(result).toBe(error)
    })

    it('read_file 成功结果压缩', () => {
      const content = 'src/index.ts (100 行)\n1│import express from "express"\n2│const app = express()\n3│app.listen(3000)'
      const result = compressSingleToolResult('read_file', content, false)
      expect(result).toContain('已读取')
      expect(result.length).toBeLessThan(content.length)
    })

    it('bash 成功结果压缩', () => {
      const content = '$ bun test\nExit code: 0\n\nAll tests passed!\nDone in 1.2s'
      const result = compressSingleToolResult('bash', content, false)
      expect(result).toContain('Exit code: 0')
    })
  })
})

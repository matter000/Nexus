/**
 * 单元测试: 共享工具函数
 * 测试 Result 类型、截断策略、二进制清理、行尾处理
 */

import { describe, it, expect } from 'bun:test'
import {
  ok,
  err,
  getOrThrow,
  toError,
  truncateHead,
  truncateTail,
  formatSize,
  sanitizeBinaryOutput,
  detectLineEnding,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
} from '../../src/utils'

describe('Result 类型', () => {
  it('ok 创建成功结果', () => {
    const result = ok(42)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe(42)
  })

  it('err 创建失败结果', () => {
    const result = err(new Error('fail'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toBe('fail')
  })

  it('getOrThrow 成功时返回值', () => {
    expect(getOrThrow(ok('hello'))).toBe('hello')
  })

  it('getOrThrow 失败时抛异常', () => {
    expect(() => getOrThrow(err(new Error('boom')))).toThrow('boom')
  })

  it('toError 规范化各种错误', () => {
    expect(toError('string error').message).toBe('string error')
    expect(toError(new Error('real')).message).toBe('real')
    expect(toError(123).message).toBe('123')
  })
})

describe('截断工具', () => {
  it('短内容不截断', () => {
    const result = truncateHead('line1\nline2\nline3')
    expect(result.truncated).toBe(false)
    expect(result.content).toBe('line1\nline2\nline3')
  })

  it('truncateHead 按行数截断', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`)
    const content = lines.join('\n')
    const result = truncateHead(content, { maxLines: 10 })
    expect(result.truncated).toBe(true)
    expect(result.truncatedBy).toBe('lines')
    expect(result.outputLines).toBe(10)
    expect(result.content).toContain('line 1')
    expect(result.content).toContain('line 10')
    expect(result.content).not.toContain('line 11')
  })

  it('truncateTail 保留末尾', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`)
    const content = lines.join('\n')
    const result = truncateTail(content, { maxLines: 10 })
    expect(result.truncated).toBe(true)
    expect(result.truncatedBy).toBe('lines')
    expect(result.outputLines).toBe(10)
    expect(result.content).toContain('line 100')
    expect(result.content).toContain('line 91')
    expect(result.content).not.toContain('line 90')
  })

  it('truncateTail 按字节截断', () => {
    const content = 'a'.repeat(1000)
    const result = truncateTail(content, { maxBytes: 100, maxLines: 9999 })
    expect(result.truncated).toBe(true)
    expect(result.truncatedBy).toBe('bytes')
  })

  it('formatSize 格式化', () => {
    expect(formatSize(500)).toBe('500B')
    expect(formatSize(2048)).toBe('2.0KB')
    expect(formatSize(1048576)).toBe('1.0MB')
  })
})

describe('二进制输出清理', () => {
  it('保留正常文本', () => {
    expect(sanitizeBinaryOutput('hello world\n')).toBe('hello world\n')
  })

  it('去除控制字符', () => {
    const input = 'hello\x00\x01\x02world'
    const result = sanitizeBinaryOutput(input)
    expect(result).toBe('helloworld')
  })

  it('保留 tab 和换行', () => {
    expect(sanitizeBinaryOutput('a\tb\nc\rd')).toBe('a\tb\nc\rd')
  })
})

describe('行尾处理', () => {
  it('检测 CRLF', () => {
    expect(detectLineEnding('line1\r\nline2\r\n')).toBe('crlf')
  })

  it('检测 LF', () => {
    expect(detectLineEnding('line1\nline2\n')).toBe('lf')
  })

  it('normalizeToLF 转换', () => {
    expect(normalizeToLF('a\r\nb\r\n')).toBe('a\nb\n')
  })

  it('restoreLineEndings 恢复 CRLF', () => {
    expect(restoreLineEndings('a\nb\n', 'crlf')).toBe('a\r\nb\r\n')
  })

  it('restoreLineEndings 保持 LF', () => {
    expect(restoreLineEndings('a\nb\n', 'lf')).toBe('a\nb\n')
  })

  it('stripBom 去除 BOM', () => {
    const withBom = '\uFEFFhello'
    const { bom, text } = stripBom(withBom)
    expect(bom).toBe('\uFEFF')
    expect(text).toBe('hello')
  })

  it('stripBom 无 BOM 时不变', () => {
    const { bom, text } = stripBom('hello')
    expect(bom).toBe('')
    expect(text).toBe('hello')
  })
})

/**
 * Nexus 共享工具函数
 * 借鉴 pi 的 Result 类型、截断策略、二进制清理等生产级设计
 */

// ─── Result 类型 ──────────────────────────────────────────────────────────────
// 借鉴 pi: 用 Result 替代 try/catch 处理预期失败,让错误路径显式化

export type Result<TValue, TError = Error> =
  | { ok: true; value: TValue }
  | { ok: false; error: TError }

export function ok<TValue, TError = Error>(value: TValue): Result<TValue, TError> {
  return { ok: true, value }
}

export function err<TValue, TError = Error>(error: TError): Result<TValue, TError> {
  return { ok: false, error }
}

export function getOrThrow<TValue, TError>(result: Result<TValue, TError>): TValue {
  if (!result.ok) throw result.error
  return result.value
}

/** 将未知 thrown 值规范化为 Error */
export function toError(error: unknown): Error {
  if (error instanceof Error) return error
  if (typeof error === 'string') return new Error(error)
  try {
    return new Error(JSON.stringify(error))
  } catch {
    return new Error(String(error))
  }
}

// ─── 截断工具 ──────────────────────────────────────────────────────────────────
// 借鉴 pi: 区分 head 截断(文件读取,保留开头)和 tail 截断(bash 输出,保留结尾/错误)

export const DEFAULT_MAX_LINES = 2000
export const DEFAULT_MAX_BYTES = 50 * 1024 // 50KB

export interface TruncationResult {
  content: string
  truncated: boolean
  truncatedBy: 'lines' | 'bytes' | null
  totalLines: number
  totalBytes: number
  outputLines: number
}

export interface TruncationOptions {
  maxLines?: number
  maxBytes?: number
}

function utf8ByteLength(content: string): number {
  return Buffer.byteLength(content, 'utf8')
}

function splitLines(content: string): string[] {
  if (content.length === 0) return []
  const lines = content.split('\n')
  if (content.endsWith('\n')) lines.pop()
  return lines
}

/**
 * 从头部截断(保留开头)——适用于 read_file
 * 永远不返回不完整的行
 */
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES

  const totalBytes = utf8ByteLength(content)
  const lines = splitLines(content)
  const totalLines = lines.length

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
    }
  }

  const outputLinesArr: string[] = []
  let outputBytesCount = 0
  let truncatedBy: 'lines' | 'bytes' = 'lines'

  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const lineBytes = utf8ByteLength(lines[i]) + (i > 0 ? 1 : 0)
    if (outputBytesCount + lineBytes > maxBytes) {
      truncatedBy = 'bytes'
      break
    }
    outputLinesArr.push(lines[i])
    outputBytesCount += lineBytes
  }

  if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
    truncatedBy = 'lines'
  }

  return {
    content: outputLinesArr.join('\n'),
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: outputLinesArr.length,
  }
}

/**
 * 从尾部截断(保留结尾)——适用于 bash 输出
 * 错误信息通常在末尾,保留尾部比保留头部更有价值
 */
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES

  const totalBytes = utf8ByteLength(content)
  const lines = splitLines(content)
  const totalLines = lines.length

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
    }
  }

  const outputLinesArr: string[] = []
  let outputBytesCount = 0
  let truncatedBy: 'lines' | 'bytes' = 'lines'

  for (let i = lines.length - 1; i >= 0 && outputLinesArr.length < maxLines; i--) {
    const lineBytes = utf8ByteLength(lines[i]) + (outputLinesArr.length > 0 ? 1 : 0)
    if (outputBytesCount + lineBytes > maxBytes) {
      truncatedBy = 'bytes'
      break
    }
    outputLinesArr.unshift(lines[i])
    outputBytesCount += lineBytes
  }

  if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
    truncatedBy = 'lines'
  }

  return {
    content: outputLinesArr.join('\n'),
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: outputLinesArr.length,
  }
}

/** 格式化字节数为人类可读大小 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

// ─── 二进制输出清理 ────────────────────────────────────────────────────────────
// 借鉴 pi: 去除 shell 输出中的控制字符,防止终端渲染异常

export function sanitizeBinaryOutput(str: string): string {
  return Array.from(str)
    .filter((char) => {
      const code = char.codePointAt(0)
      if (code === undefined) return false
      // 保留 tab, newline, carriage return
      if (code === 0x09 || code === 0x0a || code === 0x0d) return true
      // 去除其他控制字符
      if (code <= 0x1f) return false
      // 去除 Unicode 特殊字符
      if (code >= 0xfff9 && code <= 0xfffb) return false
      return true
    })
    .join('')
}

// ─── 行尾处理 ──────────────────────────────────────────────────────────────────
// 借鉴 pi: 编辑文件时保留原始行尾风格(CRLF/LF)

export type LineEnding = 'lf' | 'crlf'

export function detectLineEnding(content: string): LineEnding {
  const crlfCount = (content.match(/\r\n/g) ?? []).length
  const lfCount = (content.match(/(?<!\r)\n/g) ?? []).length
  return crlfCount > lfCount ? 'crlf' : 'lf'
}

export function normalizeToLF(content: string): string {
  return content.replace(/\r\n/g, '\n')
}

export function restoreLineEndings(content: string, ending: LineEnding): string {
  if (ending === 'crlf') {
    return content.replace(/\n/g, '\r\n')
  }
  return content
}

/** 去除 BOM 并返回是否有 BOM */
export function stripBom(content: string): { bom: string; text: string } {
  if (content.charCodeAt(0) === 0xfeff) {
    return { bom: content[0], text: content.slice(1) }
  }
  return { bom: '', text: content }
}

// ─── LLM 调用重试 ─────────────────────────────────────────────────────────────

/** 判断错误是否可重试（HTTP 429/5xx、网络超时等） */
export function isRetryable(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase()
    return (
      msg.includes('rate limit') ||
      msg.includes('429') ||
      msg.includes('500') ||
      msg.includes('502') ||
      msg.includes('503') ||
      msg.includes('504') ||
      msg.includes('timeout') ||
      msg.includes('network') ||
      msg.includes('econnrefused') ||
      msg.includes('enotfound') ||
      msg.includes('overloaded') ||
      msg.includes('connection')
    )
  }
  return false
}

export interface CallWithRetryOptions {
  maxRetries?: number
  baseDelay?: number
  /** 每次重试前的回调，参数为 { attempt, delay, error } */
  onRetry?: (info: { attempt: number; delay: number; error: Error }) => void
}

/**
 * 带指数退避的异步调用封装
 * 默认最多 3 次重试，退避间隔 1s → 2s → 4s
 * 仅对可重试错误（429/5xx/网络错误）进行重试
 */
export async function callWithRetry<T>(
  fn: () => Promise<T>,
  options: CallWithRetryOptions = {},
): Promise<T> {
  const { maxRetries = 3, baseDelay = 1000, onRetry } = options
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (!isRetryable(error) || attempt === maxRetries) break

      const delay = baseDelay * 2 ** attempt
      onRetry?.({ attempt: attempt + 1, delay, error: lastError })
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  throw lastError!
}

// ─── 路径安全 ──────────────────────────────────────────────────────────────

import { isAbsolute, relative, resolve } from 'path'

/**
 * 检查目标路径是否在项目根目录内（防止路径遍历攻击）。
 * 使用 relative() + .. 检测，比 startsWith 前缀匹配更可靠。
 * @returns true 表示安全（在项目内），false 表示越界
 */
export function isInsideProject(projectRoot: string, targetPath: string): boolean {
  const resolvedRoot = resolve(projectRoot)
  const resolvedTarget = resolve(projectRoot, targetPath)
  const rel = relative(resolvedRoot, resolvedTarget)
  // 如果相对路径以 .. 开头或为绝对路径，说明目标在项目外
  return !rel.startsWith('..') && !isAbsolute(rel)
}

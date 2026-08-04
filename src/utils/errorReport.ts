/**
 * 错误报告自动收集
 * 将运行时错误记录到 .nexus/errors/ 目录下，便于诊断和排查
 */

import { appendFile, mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { logError, newCallId, sessionId } from './debugLog'

export interface ErrorReport {
  /** 错误发生时间戳 */
  timestamp: number
  /** 错误类型（如 'llm_error', 'tool_error', 'checkpoint_error'） */
  type: string
  /** 错误消息 */
  message: string
  /** 错误堆栈（可选） */
  stack?: string
  /** 上下文信息（如当前阶段、模型名称等） */
  context?: Record<string, unknown>
  /** 项目根目录 */
  projectRoot: string
}

const ERROR_DIR = '.nexus'
const ERROR_FILE = 'error-log.jsonl'
const MAX_ERRORS = 100
const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5MB

/** 获取错误日志文件路径 */
function getErrorLogPath(projectRoot: string): string {
  return join(projectRoot, ERROR_DIR, ERROR_FILE)
}

/** 确保错误日志目录存在 */
async function ensureDir(projectRoot: string): Promise<void> {
  await mkdir(join(projectRoot, ERROR_DIR), { recursive: true })
}

/** 记录错误报告 */
export async function recordError(
  report: Omit<ErrorReport, 'timestamp' | 'projectRoot'> & { projectRoot?: string },
): Promise<void> {
  const projectRoot = report.projectRoot ?? process.cwd()
  const callId = newCallId()
  const fullReport: ErrorReport = {
    ...report,
    timestamp: Date.now(),
    projectRoot,
    context: {
      ...report.context,
      sessionId,
      callId,
    },
  }

  try {
    await ensureDir(projectRoot)
    const logPath = getErrorLogPath(projectRoot)

    // 检查文件大小，超过限制时截断
    try {
      const stat = await import('fs/promises').then((m) => m.stat(logPath))
      if (stat.size > MAX_FILE_SIZE) {
        // 保留最近的一半
        const content = await readFile(logPath, 'utf-8')
        const lines = content.trim().split('\n')
        const kept = lines.slice(-Math.floor(MAX_ERRORS / 2))
        await writeFile(logPath, kept.join('\n') + '\n', 'utf-8')
      }
    } catch {
      // 文件不存在，首次写入
    }

    await appendFile(logPath, JSON.stringify(fullReport) + '\n', 'utf-8')

    // 也通过 debugLog 输出
    await logError(`error-report:${report.type}`, new Error(report.message))
  } catch (err) {
    // 错误记录本身失败时静默处理，避免级联错误
    console.warn('[ErrorReport] 记录错误报告失败:', err)
  }
}

/** 读取最近的错误报告 */
export async function getRecentErrors(projectRoot: string, limit = 20): Promise<ErrorReport[]> {
  try {
    const logPath = getErrorLogPath(projectRoot)
    const content = await readFile(logPath, 'utf-8')
    const lines = content.trim().split('\n')
    return lines
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line) as ErrorReport
        } catch {
          return null
        }
      })
      .filter((r): r is ErrorReport => r !== null)
      .reverse()
  } catch {
    return []
  }
}

/** 清除错误日志 */
export async function clearErrors(projectRoot: string): Promise<void> {
  try {
    const logPath = getErrorLogPath(projectRoot)
    await writeFile(logPath, '', 'utf-8')
  } catch {
    // 静默
  }
}

/** 获取错误统计 */
export async function getErrorStats(projectRoot: string): Promise<{
  total: number
  byType: Record<string, number>
  recentErrors: ErrorReport[]
}> {
  const errors = await getRecentErrors(projectRoot, 1000)
  const byType: Record<string, number> = {}
  for (const err of errors) {
    byType[err.type] = (byType[err.type] ?? 0) + 1
  }
  return {
    total: errors.length,
    byType,
    recentErrors: errors.slice(0, 10),
  }
}

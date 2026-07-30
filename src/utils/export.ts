/**
 * 会话导出工具
 * 将当前会话导出为 Markdown 格式，包含需求、计划、操作和结果
 */

import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import type { ChatMessage, Todo } from '../agent/types'

export interface ExportData {
  /** 对话历史 */
  history: ChatMessage[]
  /** 当前 todos */
  todos: Todo[]
  /** 会话花费 */
  cost: { total: number; inputTokens: number; outputTokens: number }
  /** 项目根目录 */
  projectRoot: string
}

/**
 * 将会话导出为 Markdown 文件
 * @returns 导出文件的路径
 */
export async function exportSession(data: ExportData, outputPath?: string): Promise<string> {
  const { history, todos, cost, projectRoot } = data

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const defaultPath = join(projectRoot, '.nexus', 'exports', `session-${timestamp}.md`)
  const filePath = outputPath ?? defaultPath

  // 确保目录存在
  const dir = filePath.substring(
    0,
    filePath.lastIndexOf('\\') > filePath.lastIndexOf('/')
      ? filePath.lastIndexOf('\\')
      : filePath.lastIndexOf('/'),
  )
  await mkdir(dir, { recursive: true })

  const md = buildMarkdown(history, todos, cost)
  await writeFile(filePath, md, 'utf-8')

  return filePath
}

/** 构建 Markdown 内容 */
function buildMarkdown(
  history: ChatMessage[],
  todos: Todo[],
  cost: { total: number; inputTokens: number; outputTokens: number },
): string {
  const parts: string[] = []

  // 头部
  parts.push(`# Nexus 会话记录`)
  parts.push(`> 导出时间: ${new Date().toLocaleString()}`)
  parts.push(
    `> 花费: $${cost.total.toFixed(4)} (${cost.inputTokens} in / ${cost.outputTokens} out)`,
  )
  parts.push('')

  // Todos
  if (todos.length > 0) {
    parts.push('## 任务清单')
    for (const todo of todos) {
      const icon =
        todo.status === 'complete'
          ? '✅'
          : todo.status === 'in_progress'
            ? '🔄'
            : todo.status === 'cancelled'
              ? '❌'
              : '⬜'
      parts.push(`${icon} ${todo.content}`)
    }
    parts.push('')
  }

  // 对话历史
  parts.push('## 对话记录')
  parts.push('')

  for (const msg of history) {
    if (msg.role === 'user') {
      parts.push(`### 🧑 用户`)
      parts.push(msg.content)
      parts.push('')
    } else if (msg.role === 'assistant') {
      parts.push(`### 🤖 Nexus`)
      // 截断过长的 assistant 消息
      const content =
        msg.content.length > 3000 ? msg.content.slice(0, 3000) + '\n\n...(已截断)' : msg.content
      parts.push(content)
      parts.push('')
    }
  }

  // 尾部
  parts.push('---')
  parts.push(`*由 Nexus 终端 AI 编程助手导出*`)

  return parts.join('\n')
}

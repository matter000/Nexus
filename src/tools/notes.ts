/**
 * update_notes 工具
 * 任务笔记外置（Anthropic 长时程 harness 的"结构化笔记"模式）：
 * 把关键决策/进度写到上下文窗口之外的磁盘文件（.nexus/task-notes.md），
 * 上下文被压实（emergency compaction）后可随时读回，避免长任务状态丢失。
 *
 * 特性：无需审批、plan/execute 双阶段可用、不创建 checkpoint（非代码产物）。
 */

import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import type { ToolDefinition, ToolResult } from '../agent/types'
import type { ToolContext, ToolHandler } from './registry'

/** 笔记文件相对项目根的路径 */
const NOTES_REL_PATH = join('.nexus', 'task-notes.md')
/** 读回时的最大字符数（防笔记膨胀后反过来撑爆上下文） */
const READ_MAX_CHARS = 8000

const definition: ToolDefinition = {
  name: 'update_notes',
  description:
    '读写任务笔记（.nexus/task-notes.md，上下文窗口之外的持久便签）。长任务中应把关键决策、已完成事项、下一步计划用 append 写入；当上下文被压缩或会话恢复后感觉丢失了细节时，先 read 回读。replace 用于笔记过长时重写为精炼版。笔记不是代码产物，不需审批、不进 git。',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['read', 'append', 'replace'],
        description: 'read=读取全部笔记; append=追加内容; replace=整体替换为精炼版',
      },
      content: {
        type: 'string',
        description:
          'append/replace 时写入的内容（建议带时间线格式，如 "- [步骤3] 已改 X，下一步 Y"）',
      },
    },
    required: ['action'],
  },
  requiresApproval: false,
  phase: 'both',
}

async function execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const { callId, projectRoot } = context
  const action = params.action as string
  const content = params.content as string | undefined
  const notesPath = join(projectRoot, NOTES_REL_PATH)

  try {
    if (action === 'read') {
      let body: string
      try {
        body = await readFile(notesPath, 'utf-8')
      } catch {
        return {
          callId,
          tool: 'update_notes',
          result:
            '笔记为空（尚未创建）。长任务中建议随时用 append 记录关键决策与进度，以便上下文压缩后回读。',
        }
      }
      const truncated = body.length > READ_MAX_CHARS
      const text = truncated ? `${body.slice(0, READ_MAX_CHARS)}\n...（笔记过长已截断）` : body
      return { callId, tool: 'update_notes', result: text }
    }

    if (action === 'append' || action === 'replace') {
      if (!content || content.trim().length === 0) {
        return {
          callId,
          tool: 'update_notes',
          result: '',
          error: 'append/replace 需要提供 content',
        }
      }
      let next: string
      if (action === 'replace') {
        next = content
      } else {
        let prev = ''
        try {
          prev = await readFile(notesPath, 'utf-8')
        } catch {
          // 首次写入
        }
        next = prev.length > 0 ? `${prev}\n${content}` : content
      }
      // 首次写入时 .nexus 目录可能不存在（新项目/eval 临时目录）
      await mkdir(dirname(notesPath), { recursive: true })
      await writeFile(notesPath, next, 'utf-8')
      return {
        callId,
        tool: 'update_notes',
        result: `笔记已${action === 'append' ? '追加' : '替换'}（${next.length} 字符，位于 ${NOTES_REL_PATH}）`,
      }
    }

    return { callId, tool: 'update_notes', result: '', error: `未知 action: ${action}` }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return { callId, tool: 'update_notes', result: '', error: `笔记操作失败: ${message}` }
  }
}

export const updateNotesTool: ToolHandler = { definition, execute }

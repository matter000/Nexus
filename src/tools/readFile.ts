/**
 * read_file 工具
 * 读取文件内容,支持行数截断、二进制检测、行号格式化
 */

import { readFile, stat } from 'fs/promises'
import { relative, resolve } from 'path'
import type { ToolDefinition, ToolResult } from '../agent/types'
import { isInsideProject } from '../utils'
import type { ToolContext, ToolHandler } from './registry'

const definition: ToolDefinition = {
  name: 'read_file',
  description:
    '读取文件内容。返回带行号的文件内容。超过 2000 行的文件会被截断(只显示头尾)。二进制文件会被拒绝。',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '要读取的文件路径(相对于项目根目录)',
      },
      start_line: {
        type: 'number',
        description: '起始行号(可选,从 1 开始)',
      },
      end_line: {
        type: 'number',
        description: '结束行号(可选)',
      },
    },
    required: ['path'],
  },
  requiresApproval: false,
  phase: 'both',
}

/** 检测是否为二进制文件 */
function isBinary(buffer: Buffer): boolean {
  // 检查前 8KB 中是否有 null 字节
  const slice = buffer.subarray(0, 8192)
  return slice.includes(0)
}

/** 格式化带行号的内容 */
function formatWithLineNumbers(content: string, startLine: number): string {
  const lines = content.split('\n')
  const maxLineNum = startLine + lines.length - 1
  const padding = String(maxLineNum).length
  return lines.map((line, i) => `${String(startLine + i).padStart(padding)}│${line}`).join('\n')
}

async function execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const { callId, projectRoot, maxReadLines } = context
  const filePath = params.path as string
  const startLine = (params.start_line as number) ?? 1
  const endLine = params.end_line as number | undefined

  try {
    const fullPath = resolve(projectRoot, filePath)
    const relPath = relative(projectRoot, fullPath)

    // 安全检查:不允许读取项目外的文件（使用 relative 检测，比 startsWith 更可靠）
    if (!isInsideProject(projectRoot, filePath)) {
      return {
        callId,
        tool: 'read_file',
        result: '',
        error: `路径越界: ${filePath} 不在项目目录内`,
      }
    }

    // 检查文件是否存在
    const fileStat = await stat(fullPath)
    if (!fileStat.isFile()) {
      return {
        callId,
        tool: 'read_file',
        result: '',
        error: `${relPath} 不是一个文件`,
      }
    }

    // 读取文件
    const buffer = await readFile(fullPath)

    // 二进制检测
    if (isBinary(buffer)) {
      return {
        callId,
        tool: 'read_file',
        result: '',
        error: `${relPath} 是二进制文件,无法读取`,
      }
    }

    const content = buffer.toString('utf-8')
    const allLines = content.split('\n')
    const totalLines = allLines.length

    // 如果指定了范围
    if (endLine !== undefined) {
      const start = Math.max(1, startLine) - 1
      const end = Math.min(totalLines, endLine)
      const slice = allLines.slice(start, end)
      return {
        callId,
        tool: 'read_file',
        result: `${relPath} (行 ${start + 1}-${end}/${totalLines})\n${formatWithLineNumbers(slice.join('\n'), start + 1)}`,
      }
    }

    // 行数截断策略
    if (totalLines > maxReadLines) {
      const headLines = Math.floor(maxReadLines * 0.7)
      const tailLines = Math.floor(maxReadLines * 0.3)
      const head = allLines.slice(0, headLines)
      const tail = allLines.slice(-tailLines)
      const omitted = totalLines - headLines - tailLines

      const result = [
        `${relPath} (${totalLines} 行, 已截断)`,
        formatWithLineNumbers(head.join('\n'), 1),
        `\n... 省略 ${omitted} 行 (使用 start_line/end_line 参数读取特定范围,或用 grep 搜索) ...\n`,
        formatWithLineNumbers(tail.join('\n'), totalLines - tailLines + 1),
      ].join('\n')

      return { callId, tool: 'read_file', result, truncated: true }
    }

    // 正常返回
    return {
      callId,
      tool: 'read_file',
      result: `${relPath} (${totalLines} 行)\n${formatWithLineNumbers(content, 1)}`,
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      callId,
      tool: 'read_file',
      result: '',
      error: `读取失败: ${message}`,
    }
  }
}

export const readFileTool: ToolHandler = { definition, execute }

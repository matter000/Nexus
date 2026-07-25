/**
 * create_file 工具
 * 创建新文件，支持模板。文件已存在时报错（不覆盖）
 */

import { writeFile, mkdir, access } from 'fs/promises'
import { resolve, relative, dirname } from 'path'
import type { ToolDefinition, ToolResult } from '../agent/types'
import type { ToolHandler, ToolContext } from './registry'
import { isInsideProject } from '../utils'

const definition: ToolDefinition = {
  name: 'create_file',
  description:
    '创建新文件。如果文件已存在则报错（不覆盖）。使用 edit_file(old_string="") 也可以创建文件，但 create_file 语义更清晰。',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '要创建的文件路径（相对于项目根目录）',
      },
      content: {
        type: 'string',
        description: '文件内容',
      },
    },
    required: ['path', 'content'],
  },
  requiresApproval: true,
  phase: 'execute',
}

async function execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const { callId, projectRoot } = context
  const filePath = params.path as string
  const content = params.content as string

  try {
    const fullPath = resolve(projectRoot, filePath)
    const relPath = relative(projectRoot, fullPath)

    // 安全检查
    if (!isInsideProject(projectRoot, filePath)) {
      return {
        callId,
        tool: 'create_file',
        result: '',
        error: `路径越界: ${filePath} 不在项目目录内`,
      }
    }

    // 检查文件是否已存在
    try {
      await access(fullPath)
      return {
        callId,
        tool: 'create_file',
        result: '',
        error: `文件已存在: ${relPath}。如需修改请使用 edit_file。`,
      }
    } catch {
      // 文件不存在，可以继续创建
    }

    // 确保目录存在
    await mkdir(dirname(fullPath), { recursive: true })

    // 写入文件
    await writeFile(fullPath, content, 'utf-8')

    const lines = content.split('\n').length
    return {
      callId,
      tool: 'create_file',
      result: `已创建文件: ${relPath} (${lines} 行)`,
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      callId,
      tool: 'create_file',
      result: '',
      error: `创建文件失败: ${message}`,
    }
  }
}

export const createFileTool: ToolHandler = { definition, execute }

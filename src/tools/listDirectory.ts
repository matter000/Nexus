/**
 * list_directory 工具
 * 列出指定目录下的文件和子目录,支持递归和过滤
 */

import { readdir, stat } from 'fs/promises'
import { join, relative, resolve } from 'path'
import type { ToolDefinition, ToolResult } from '../agent/types'
import { isInsideProject } from '../utils'
import type { ToolContext, ToolHandler } from './registry'

const definition: ToolDefinition = {
  name: 'list_directory',
  description:
    '列出指定目录下的文件和子目录。显示类型(文件/目录)、大小、修改时间。自动忽略 node_modules、.git、dist 等目录。只读操作,不需要审批。',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '目标目录路径(相对于项目根目录,默认为项目根目录)',
      },
      recursive: {
        type: 'boolean',
        description: '是否递归列出子目录(默认 false)',
      },
      pattern: {
        type: 'string',
        description: '文件名过滤模式(简单的子串匹配)',
      },
    },
    required: [],
  },
  requiresApproval: false,
  phase: 'both',
}

/** 自动忽略的目录 */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.nuxt',
  'coverage',
  '__pycache__',
  '.cache',
  '.svelte-kit',
  '.output',
])

/** 格式化文件大小 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

/** 格式化时间 */
function formatTime(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const h = String(date.getHours()).padStart(2, '0')
  const min = String(date.getMinutes()).padStart(2, '0')
  return `${y}-${m}-${d} ${h}:${min}`
}

interface DirEntry {
  type: 'file' | 'directory'
  name: string
  path: string
  size?: number
  modified?: Date
}

/** 读取目录内容 */
async function listDir(
  dir: string,
  rootDir: string,
  recursive: boolean,
  pattern: string | undefined,
  results: DirEntry[],
  depth: number,
): Promise<void> {
  if (depth > 10) return // 递归深度保护

  let entries: import('fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  // 按名称排序,目录在前
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    const relPath = relative(rootDir, fullPath).replace(/\\/g, '/')

    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue
      if (entry.name.startsWith('.') && entry.name !== '.nexus') continue

      if (pattern && !entry.name.includes(pattern)) {
        // 非递归时过滤,但递归时仍然进入子目录
        if (recursive) {
          await listDir(fullPath, rootDir, recursive, pattern, results, depth + 1)
        }
        continue
      }

      try {
        const st = await stat(fullPath)
        results.push({ type: 'directory', name: entry.name, path: relPath, modified: st.mtime })
      } catch {
        results.push({ type: 'directory', name: entry.name, path: relPath })
      }

      if (recursive) {
        await listDir(fullPath, rootDir, recursive, pattern, results, depth + 1)
      }
    } else if (entry.isFile()) {
      if (pattern && !entry.name.includes(pattern)) continue

      try {
        const st = await stat(fullPath)
        results.push({
          type: 'file',
          name: entry.name,
          path: relPath,
          size: st.size,
          modified: st.mtime,
        })
      } catch {
        results.push({ type: 'file', name: entry.name, path: relPath })
      }
    }
  }
}

/** 格式化输出为树状列表 */
function formatOutput(entries: DirEntry[], rootDir: string, targetPath: string): string {
  const lines: string[] = []
  lines.push(`📁 ${targetPath === '.' ? rootDir.split(/[\\/]/).pop() : targetPath}/`)

  for (const entry of entries) {
    const icon = entry.type === 'directory' ? '📁' : '📄'
    const sizeStr =
      entry.type === 'file' && entry.size !== undefined ? ` (${formatFileSize(entry.size)})` : ''
    const timeStr = entry.modified ? ` ${formatTime(entry.modified)}` : ''
    const depth = (entry.path.match(/\//g) ?? []).length
    const indent = '  '.repeat(depth + 1)
    lines.push(`${indent}${icon} ${entry.name}${sizeStr}${timeStr}`)
  }

  return lines.join('\n')
}

async function execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const { callId, projectRoot } = context
  const targetPath = (params.path as string) ?? '.'
  const recursive = (params.recursive as boolean) ?? false
  const pattern = params.pattern as string | undefined

  try {
    const rootDir = resolve(projectRoot)
    const targetDir = resolve(projectRoot, targetPath)

    // 安全检查
    if (!isInsideProject(projectRoot, targetPath)) {
      return {
        callId,
        tool: 'list_directory',
        result: '',
        error: `路径越界: ${targetPath} 不在项目目录内`,
      }
    }

    const dirStat = await stat(targetDir)
    if (!dirStat.isDirectory()) {
      return {
        callId,
        tool: 'list_directory',
        result: '',
        error: `${targetPath} 不是一个目录`,
      }
    }

    const results: DirEntry[] = []
    await listDir(targetDir, rootDir, recursive, pattern, results, 0)

    if (results.length === 0) {
      return {
        callId,
        tool: 'list_directory',
        result: `目录 ${targetPath} 为空${pattern ? ` (过滤: "${pattern}")` : ''}`,
      }
    }

    const output = formatOutput(results, rootDir, targetPath)

    return {
      callId,
      tool: 'list_directory',
      result: `${output}\n\n共 ${results.length} 项 (${results.filter((r) => r.type === 'directory').length} 个目录, ${results.filter((r) => r.type === 'file').length} 个文件)`,
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      callId,
      tool: 'list_directory',
      result: '',
      error: `列出目录失败: ${message}`,
    }
  }
}

export const listDirectoryTool: ToolHandler = { definition, execute }

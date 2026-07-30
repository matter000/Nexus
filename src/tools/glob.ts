/**
 * glob 工具
 * 文件模式搜索，基于 Bun 内置 Glob 或回退到目录遍历
 */

import { readdir } from 'fs/promises'
import { relative, resolve } from 'path'
import type { ToolDefinition, ToolResult } from '../agent/types'
import { isInsideProject } from '../utils'
import type { ToolContext, ToolHandler } from './registry'

const MAX_RESULTS = 100

const definition: ToolDefinition = {
  name: 'glob',
  description:
    '搜索匹配 glob 模式的文件路径。如 "**/*.ts"、"src/**/*.test.ts"。最多返回 100 个结果。只读操作，不需要审批。',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'glob 模式（如 **/*.ts、src/**/*.test.ts）',
      },
      path: {
        type: 'string',
        description: '搜索根目录（相对于项目根目录，默认为项目根目录）',
      },
    },
    required: ['pattern'],
  },
  requiresApproval: false,
  phase: 'both',
}

/**
 * 简单的 glob 模式匹配
 * 支持 * (任意非分隔符) 和 ** (任意路径段)
 */
function matchGlob(pattern: string, filePath: string): boolean {
  // 将 glob 模式转为正则
  // ** → 匹配任意路径段（包括 / ）
  // *  → 匹配单层文件名（不含 / ）
  // ?  → 匹配单个非 / 字符
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // 转义正则特殊字符（除了 * 和 ?）
    .replace(/\*\*/g, '{{DOUBLE_STAR}}') // 临时占位
    .replace(/\*/g, '[^/]*') // * → 非 / 字符
    .replace(/\?/g, '[^/]') // ? → 单个非 / 字符
    .replace(/\{\{DOUBLE_STAR\}\}/g, '.*') // ** → 任意字符（含 /）

  const regex = new RegExp(`^${regexStr}$`)
  return regex.test(filePath)
}

/** 递归遍历目录，收集匹配的文件 */
async function walkDir(
  dir: string,
  rootDir: string,
  pattern: string,
  results: string[],
): Promise<void> {
  if (results.length >= MAX_RESULTS) return

  let entries: Array<{ name: string; isDirectory: boolean }>
  try {
    const raw = await readdir(dir, { withFileTypes: true })
    entries = raw.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }))
  } catch {
    // 权限问题等，跳过该目录
    return
  }

  // 按名称排序保证输出稳定
  entries.sort((a, b) => a.name.localeCompare(b.name))

  for (const entry of entries) {
    if (results.length >= MAX_RESULTS) break

    const fullPath = `${dir}/${entry.name}`
    const relPath = relative(rootDir, fullPath).replace(/\\/g, '/')

    // 跳过常见的无关目录
    if (entry.isDirectory) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') {
        continue
      }
      await walkDir(fullPath, rootDir, pattern, results)
    } else {
      if (matchGlob(pattern, relPath)) {
        results.push(relPath)
      }
    }
  }
}

async function execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const { callId, projectRoot } = context
  const pattern = params.pattern as string
  const searchPath = (params.path as string) ?? '.'

  try {
    // 安全检查：搜索路径不能越出项目根
    if (!isInsideProject(projectRoot, searchPath)) {
      return {
        callId,
        tool: 'glob',
        result: '',
        error: `路径越界: ${searchPath} 不在项目目录内`,
      }
    }
    const rootDir = resolve(projectRoot, searchPath)
    const results: string[] = []

    await walkDir(rootDir, rootDir, pattern, results)

    if (results.length === 0) {
      return {
        callId,
        tool: 'glob',
        result: `未找到匹配 "${pattern}" 的文件`,
      }
    }

    const truncated = results.length >= MAX_RESULTS
    const output = results.join('\n')
    const suffix = truncated ? `\n\n... 已达最大结果数 (${MAX_RESULTS})，请缩小搜索范围 ...` : ''

    return {
      callId,
      tool: 'glob',
      result: `找到 ${results.length} 个匹配文件:\n${output}${suffix}`,
      truncated,
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      callId,
      tool: 'glob',
      result: '',
      error: `glob 搜索失败: ${message}`,
    }
  }
}

export const globTool: ToolHandler = { definition, execute }

/**
 * edit_file 工具
 * 精准替换文件中的字符串,强制唯一匹配,原子写入
 * 这是 agent 最容易翻车的工具,可靠性设计是重中之重
 */

import { readFile, writeFile, rename, mkdir } from 'fs/promises'
import { resolve, relative, dirname } from 'path'
import { createPatch } from 'diff'
import type { ToolDefinition, ToolResult } from '../agent/types'
import type { ToolHandler, ToolContext } from './registry'
import { isInsideProject } from '../utils'
import { stripBom, detectLineEnding, normalizeToLF, restoreLineEndings } from '../utils'

const definition: ToolDefinition = {
  name: 'edit_file',
  description:
    '精准替换文件中的字符串。old_string 必须在文件中唯一匹配(0处匹配报错,>1处匹配也报错)。提供足够的上下文行确保唯一性。',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '要编辑的文件路径(相对于项目根目录)',
      },
      old_string: {
        type: 'string',
        description: '要替换的原文,必须在文件中唯一匹配。包含足够上下文以确保唯一性。',
      },
      new_string: {
        type: 'string',
        description: '替换后的新内容',
      },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  requiresApproval: true,
  phase: 'execute',
}

/** 计算字符串在文本中出现的次数 */
function countOccurrences(text: string, search: string): number {
  if (search === '') return 0
  let count = 0
  let pos = 0
  while ((pos = text.indexOf(search, pos)) !== -1) {
    count++
    pos += search.length
  }
  return count
}

/** 原子写入:写临时文件 → rename */
async function atomicWrite(filePath: string, content: string): Promise<void> {
  const dir = dirname(filePath)
  await mkdir(dir, { recursive: true })
  const tmpPath = `${filePath}.nexus-tmp-${Date.now()}`
  await writeFile(tmpPath, content, 'utf-8')
  await rename(tmpPath, filePath)
}

async function execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const { callId, projectRoot } = context
  const filePath = params.path as string
  const oldString = params.old_string as string
  const newString = params.new_string as string

  try {
    const fullPath = resolve(projectRoot, filePath)
    const relPath = relative(projectRoot, fullPath)

    // 安全检查:不允许编辑项目外的文件
    if (!isInsideProject(projectRoot, filePath)) {
      return {
        callId,
        tool: 'edit_file',
        result: '',
        error: `路径越界: ${filePath} 不在项目目录内`,
      }
    }

    // 1. 读文件原文
    let rawContent: string
    try {
      rawContent = await readFile(fullPath, 'utf-8')
    } catch {
      // 文件不存在时,如果 old_string 为空则创建新文件
      if (oldString === '') {
        await atomicWrite(fullPath, newString)
        return {
          callId,
          tool: 'edit_file',
          result: `已创建新文件: ${relPath}\n${generateDiff(relPath, '', newString)}`,
        }
      }
      return {
        callId,
        tool: 'edit_file',
        result: '',
        error: `文件不存在: ${relPath}。如果要创建新文件,请将 old_string 设为空字符串。`,
      }
    }

    // 借鉴 pi: 处理 BOM 和行尾,确保编辑后保留原始格式
    const { bom, text: contentWithoutBom } = stripBom(rawContent)
    const originalEnding = detectLineEnding(contentWithoutBom)
    const originalContent = normalizeToLF(contentWithoutBom)
    const normalizedOld = normalizeToLF(oldString)
    const normalizedNew = normalizeToLF(newString)

    // 2. 查找 old_string 的匹配数(在 LF 规范化后的内容中匹配)
    const matchCount = countOccurrences(originalContent, normalizedOld)

    if (matchCount === 0) {
      return {
        callId,
        tool: 'edit_file',
        result: '',
        error: `未找到匹配。old_string 在 ${relPath} 中不存在。文件可能已变更,请重新 read_file 获取最新内容。`,
      }
    }

    if (matchCount > 1) {
      return {
        callId,
        tool: 'edit_file',
        result: '',
        error: `匹配不唯一: old_string 在 ${relPath} 中出现了 ${matchCount} 次。请提供更多上下文行以确保唯一匹配。`,
      }
    }

    // 3. 应用替换
    const newContentLF = originalContent.replace(normalizedOld, normalizedNew)

    // 4. 生成 diff(用 LF 版本对比)
    const diff = generateDiff(relPath, originalContent, newContentLF)

    // 5. 恢复原始行尾 + BOM,原子写入
    const finalContent = bom + restoreLineEndings(newContentLF, originalEnding)
    await atomicWrite(fullPath, finalContent)

    // 6. 返回 diff 给 LLM
    return {
      callId,
      tool: 'edit_file',
      result: `已编辑: ${relPath}\n${diff}`,
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      callId,
      tool: 'edit_file',
      result: '',
      error: `编辑失败: ${message}`,
    }
  }
}

/** 生成 unified diff */
function generateDiff(fileName: string, oldContent: string, newContent: string): string {
  const patch = createPatch(fileName, oldContent, newContent, '原文', '修改后')
  // 只保留 diff 主体(去掉头部信息)
  const lines = patch.split('\n')
  const diffStart = lines.findIndex((l) => l.startsWith('@@'))
  if (diffStart === -1) return '(无变更)'
  return lines.slice(diffStart).join('\n')
}

export const editFileTool: ToolHandler = { definition, execute }
export { generateDiff }

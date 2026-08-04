/**
 * search_symbol 工具
 * 搜索函数、类、接口、变量等符号的定义和引用
 * 使用 CodeGraph (TypeScript Compiler API) 进行符号搜索
 */

import { readFile } from 'fs/promises'
import { resolve } from 'path'
import type { ToolDefinition, ToolResult } from '../agent/types'
import { createGraphEngine } from '../context/CodeGraph'
import type { ToolContext, ToolHandler } from './registry'

const definition: ToolDefinition = {
  name: 'search_symbol',
  description:
    '搜索代码符号(函数、类、接口、类型、变量)的定义和引用。使用 TypeScript Compiler API 解析 AST,返回匹配的文件路径、行号和代码行。只读操作,不需要审批。',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description: '要搜索的符号名称(如 "ToolHandler", "createToolRegistry")',
      },
      type: {
        type: 'string',
        description: '搜索类型: definition(定义,默认), all(定义+引用)。reference 搜索暂未实现。',
        enum: ['definition', 'all'],
      },
    },
    required: ['symbol'],
  },
  requiresApproval: false,
  phase: 'both',
}

/** 从文件中读取指定行附近的内容 */
async function readLinesAround(
  filePath: string,
  line: number,
  contextLines: number = 1,
): Promise<string> {
  try {
    const content = await readFile(resolve(filePath), 'utf-8')
    const lines = content.split('\n')
    const start = Math.max(0, line - 1 - contextLines)
    const end = Math.min(lines.length, line + contextLines)
    const selected = lines.slice(start, end)
    return selected
      .map((l, i) => {
        const lineNum = start + i + 1
        const marker = lineNum === line ? '→' : ' '
        return `  ${marker} ${String(lineNum).padStart(4)}│ ${l}`
      })
      .join('\n')
  } catch {
    return '  (无法读取文件内容)'
  }
}

async function execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const { callId, projectRoot } = context
  const symbolName = params.symbol as string
  const searchType = (params.type as string) ?? 'all'

  try {
    const engine = createGraphEngine()

    // 构建代码图谱
    const graph = await engine.buildGraph(projectRoot)

    // 查询符号
    const symbols = await engine.querySymbol(symbolName)

    if (symbols.length === 0) {
      return {
        callId,
        tool: 'search_symbol',
        result: `未找到符号 "${symbolName}" 的定义。提示: CodeGraph 目前索引 .ts/.tsx/.js/.jsx 文件,如果目标文件不在索引范围内,可使用 grep 工具搜索。`,
      }
    }

    // 过滤符号类型（reference 未实现，只支持 definition 和 all）
    const filtered = symbols.filter((s) => {
      // querySymbol 返回的就是定义，definition 和 all 都返回全部
      return true
    })

    if (filtered.length === 0) {
      return {
        callId,
        tool: 'search_symbol',
        result: `符号 "${symbolName}" 有 ${symbols.length} 处定义,但无匹配的 ${searchType === 'reference' ? '引用' : '定义'}`,
      }
    }

    // 格式化结果
    const results: string[] = []
    for (let i = 0; i < filtered.length && i < 20; i++) {
      const s = filtered[i]
      const absPath = resolve(projectRoot, s.filePath)
      const codeSnippet = await readLinesAround(absPath, s.startLine)
      results.push(
        `### [${i + 1}] ${s.kind} ${s.name}\n` +
          `📁 ${s.filePath}:${s.startLine}-${s.endLine}${s.exports ? ' (exported)' : ''}\n` +
          (s.docstring ? `📝 ${s.docstring.split('\n')[0]}\n` : '') +
          `\`\`\`\n${codeSnippet}\n\`\`\``,
      )
    }

    const truncated = filtered.length > 20
    const summary = `找到 ${filtered.length} 处定义`

    return {
      callId,
      tool: 'search_symbol',
      result: `${summary}:\n\n${results.join('\n\n')}${truncated ? '\n\n... 结果过多,已截断前 20 条 ...' : ''}`,
      truncated,
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      callId,
      tool: 'search_symbol',
      result: '',
      error: `符号搜索失败: ${message}`,
    }
  }
}

export const searchSymbolTool: ToolHandler = { definition, execute }

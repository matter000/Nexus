/**
 * web_search 工具
 * 通过搜索引擎 API 搜索网络信息
 * 使用 DuckDuckGo 的零 API 搜索接口（无需 API Key）
 */

import type { ToolDefinition, ToolResult } from '../agent/types'
import { isPrivateUrl } from '../utils/ssrf'
import type { ToolContext, ToolHandler } from './registry'

const definition: ToolDefinition = {
  name: 'web_search',
  description:
    '搜索网络信息。返回搜索结果摘要，包含标题、URL 和简短描述。适用于查找最新文档、API 用法、错误解决方案等。',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '搜索关键词',
      },
      count: {
        type: 'number',
        description: '返回结果数量（默认 5，最大 10）',
      },
    },
    required: ['query'],
  },
  requiresApproval: true,
  phase: 'both',
}

/** 提取 HTML 中的文本内容 */
function extractText(html: string, tag: string): string[] {
  const results: string[] = []
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi')
  let match: RegExpExecArray | null
  while ((match = regex.exec(html)) !== null) {
    const text = match[1].replace(/<[^>]+>/g, '').trim()
    if (text) results.push(text)
  }
  return results
}

/** 使用 DuckDuckGo Lite API 搜索 */
async function searchDuckDuckGo(query: string, count: number): Promise<string> {
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Nexus-Coding-Agent/1.0',
      },
    })
    clearTimeout(timeout)

    if (!response.ok) {
      return `搜索请求失败: HTTP ${response.status}`
    }

    const html = await response.text()

    // 解析结果表格
    const lines: string[] = [`搜索结果: ${query}\n`]
    const rows = html.split('\n')

    let currentResult: { title: string; snippet: string; url: string } | null = null
    let resultCount = 0

    for (let i = 0; i < rows.length && resultCount < count; i++) {
      const line = rows[i].trim()

      // 查找结果链接
      if (line.startsWith('<a rel="nofollow" href="')) {
        const urlMatch = line.match(/href="([^"]+)"/)
        const titleMatch = line.match(/>(.*?)<\/a>/)
        if (urlMatch && titleMatch) {
          if (currentResult) {
            lines.push(
              `${resultCount + 1}. ${currentResult.title}\n   链接: ${currentResult.url}\n   摘要: ${currentResult.snippet}\n`,
            )
            resultCount++
          }
          currentResult = {
            title: titleMatch[1].replace(/<[^>]+>/g, '').trim(),
            url: urlMatch[1],
            snippet: '',
          }
        }
      } else if (currentResult && line.startsWith('<td class="result-snippet">')) {
        const snippetMatch = line.match(/<td class="result-snippet">(.*?)<\/td>/)
        if (snippetMatch) {
          currentResult.snippet = snippetMatch[1].replace(/<[^>]+>/g, '').trim()
        }
      }
    }

    // 最后一个结果
    if (currentResult && resultCount < count) {
      lines.push(
        `${resultCount + 1}. ${currentResult.title}\n   链接: ${currentResult.url}\n   摘要: ${currentResult.snippet}\n`,
      )
    }

    if (lines.length <= 1) {
      return `未找到 "${query}" 的相关结果`
    }

    lines.push('---\n提示: 使用 fetch_url 工具获取具体页面内容')
    return lines.join('\n')
  } catch (err: unknown) {
    clearTimeout(timeout)
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('aborted')) {
      return '搜索请求超时'
    }
    return `搜索失败: ${message}`
  }
}

async function execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const { callId } = context
  const query = params.query as string
  const count = Math.min((params.count as number) ?? 5, 10)

  if (!query || !query.trim()) {
    return {
      callId,
      tool: 'web_search',
      result: '',
      error: '搜索关键词不能为空',
    }
  }

  const result = await searchDuckDuckGo(query, count)

  return {
    callId,
    tool: 'web_search',
    result,
  }
}

export const webSearchTool: ToolHandler = { definition, execute }

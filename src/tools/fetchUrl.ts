/**
 * fetch_url 工具
 * 获取指定 URL 的网页内容,提取主要文本
 * 使用 Bun 内置 fetch API,30 秒超时
 */

import type { ToolDefinition, ToolResult } from '../agent/types'
import type { ToolHandler, ToolContext } from './registry'

const definition: ToolDefinition = {
  name: 'fetch_url',
  description:
    '获取网页内容并提取主要文本。移除 HTML 标签、脚本和样式,保留正文内容。超时 30 秒。需要审批(网络请求)。',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: '目标 URL(必须是 http 或 https 协议)',
      },
      max_length: {
        type: 'number',
        description: '最大返回字符数(默认 10000)',
      },
    },
    required: ['url'],
  },
  requiresApproval: true,
  phase: 'both',
}

/** 简单 HTML 标签剥离 */
function stripHtml(html: string): string {
  // 移除 script 和 style 标签及其内容
  let text = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
  text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')

  // 移除 nav, footer, header 标签及其内容(减少噪音)
  text = text.replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, '')
  text = text.replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, '')

  // 将 br 和 p 标签转为换行
  text = text.replace(/<br\s*\/?>/gi, '\n')
  text = text.replace(/<\/p>/gi, '\n\n')

  // 将 h1-h6 转为标记 + 换行
  text = text.replace(/<h([1-6])[^>]*>(.*?)<\/h\1>/gi, '\n## $2\n')

  // 移除所有其他 HTML 标签
  text = text.replace(/<[^>]+>/g, ' ')

  // 解码常见 HTML 实体
  text = text.replace(/&nbsp;/g, ' ')
  text = text.replace(/&amp;/g, '&')
  text = text.replace(/&lt;/g, '<')
  text = text.replace(/&gt;/g, '>')
  text = text.replace(/&quot;/g, '"')
  text = text.replace(/&#39;/g, "'")

  // 合并多个空格和换行
  text = text.replace(/[ \t]+/g, ' ')
  text = text.replace(/\n{3,}/g, '\n\n')

  return text.trim()
}

/** 从 Content-Type 判断是否为 HTML */
function isHtmlContentType(contentType: string | null): boolean {
  if (!contentType) return false
  return contentType.includes('text/html') || contentType.includes('application/xhtml')
}

/** 检查 URL 是否指向内网/私有地址（SSRF 防护） */
function isPrivateUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr)
    const hostname = parsed.hostname.toLowerCase()

    // localhost / 短主机名
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]') {
      return true
    }

    // 云元数据端点
    if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal') {
      return true
    }

    // IPv4 私有范围
    const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
    if (ipv4Match) {
      const [_, a, b] = ipv4Match.map(Number) as unknown as [string, number, number, number, number]
      // 10.0.0.0/8
      if (a === 10) return true
      // 172.16.0.0/12
      if (a === 172 && b >= 16 && b <= 31) return true
      // 192.168.0.0/16
      if (a === 192 && b === 168) return true
      // 127.0.0.0/8 (loopback)
      if (a === 127) return true
      // 169.254.0.0/16 (link-local)
      if (a === 169 && b === 254) return true
      // 0.0.0.0/8
      if (a === 0) return true
    }

    // .local / .internal 后缀
    if (hostname.endsWith('.local') || hostname.endsWith('.internal')) {
      return true
    }

    return false
  } catch {
    return true // URL 解析失败，保守拒绝
  }
}

async function execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const { callId } = context
  const url = params.url as string
  const maxLength = (params.max_length as number) ?? 10000

  // URL 协议校验
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return {
      callId,
      tool: 'fetch_url',
      result: '',
      error: `无效的 URL 协议: 必须是 http 或 https`,
    }
  }

  // SSRF 防护：拒绝内网/私有地址
  if (isPrivateUrl(url)) {
    return {
      callId,
      tool: 'fetch_url',
      result: '',
      error: `出于安全原因，不允许访问内网或私有地址: ${url}`,
    }
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30000)

    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'manual', // 不自动跟随重定向，防止 302 到内网
      headers: {
        'User-Agent': 'Nexus-Coding-Agent/1.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8',
      },
    })

    clearTimeout(timeout)

    if (!response.ok) {
      // 重定向（手动模式下的 3xx）
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        return {
          callId,
          tool: 'fetch_url',
          result: '',
          error: `重定向到 ${location ?? '(未知)'}（出于安全考虑不自动跟随重定向，请直接请求目标 URL）`,
        }
      }
      return {
        callId,
        tool: 'fetch_url',
        result: '',
        error: `HTTP 错误: ${response.status} ${response.statusText}`,
      }
    }

    const contentType = response.headers.get('content-type')
    const body = await response.text()

    let content: string
    if (isHtmlContentType(contentType)) {
      content = stripHtml(body)
    } else {
      content = body
    }

    // 长度截断
    let truncated = false
    if (content.length > maxLength) {
      content = content.slice(0, maxLength) + '\n\n... [内容已截断,超出最大长度限制]'
      truncated = true
    }

    if (!content.trim()) {
      return {
        callId,
        tool: 'fetch_url',
        result: `页面内容为空或无法解析: ${url}`,
      }
    }

    return {
      callId,
      tool: 'fetch_url',
      result: `URL: ${url}\nContent-Type: ${contentType ?? 'unknown'}\n\n${content}`,
      truncated,
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('aborted')) {
      return {
        callId,
        tool: 'fetch_url',
        result: '',
        error: `请求超时(30秒): ${url}`,
      }
    }
    return {
      callId,
      tool: 'fetch_url',
      result: '',
      error: `获取失败: ${message}`,
    }
  }
}

export const fetchUrlTool: ToolHandler = { definition, execute }

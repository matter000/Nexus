#!/usr/bin/env bun
/**
 * Nexus MCP Server
 * 将 Nexus 的核心工具暴露为 MCP Server,可被 Cursor/VSCode/Claude Desktop 挂载
 * 使用 stdio transport (JSON-RPC over stdin/stdout)
 *
 * 独立启动: bun run packages/nexus-mcp-server/src/index.ts
 * 协议: @modelcontextprotocol/sdk 标准 McpServer.tool() 注册
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { readFile, writeFile, rename, mkdir } from 'fs/promises'
import { resolve, relative, dirname } from 'path'
import { spawn } from 'child_process'

// ─── 配置 ─────────────────────────────────────────────────────────────────────

const PROJECT_ROOT = resolve(process.cwd())
const MAX_OUTPUT_BYTES = 100 * 1024 // 100KB
const DEFAULT_TIMEOUT_SECONDS = 30
const MAX_READ_LINES = 2000

// ─── 安全工具 ─────────────────────────────────────────────────────────────────

/** 路径越界校验: resolve 后检查是否在 PROJECT_ROOT 内 */
function assertPathSafe(filePath: string): string {
  const fullPath = resolve(PROJECT_ROOT, filePath)
  if (!fullPath.startsWith(PROJECT_ROOT)) {
    throw new PathError(`路径越界: ${filePath} 不在项目目录内`)
  }
  return fullPath
}

class PathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PathError'
  }
}

/** 危险命令检测(内联版本,与 src/sandbox/CommandGuard.ts 保持一致) */
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/(\s|$)/, reason: '删除根目录' },
  { pattern: /rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?~\/?(\s|$)/, reason: '删除用户主目录' },
  { pattern: /rm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+\//, reason: '递归强制删除根路径' },
  { pattern: /\bdd\b.*of=\/dev\//, reason: '直接写入块设备' },
  { pattern: /\bmkfs\b/, reason: '格式化文件系统' },
  { pattern: /\bshred\b/, reason: '安全擦除文件' },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: 'Fork 炸弹' },
  { pattern: /curl\s+.*\|\s*(bash|sh|zsh)/, reason: '远程代码执行' },
  { pattern: /wget\s+.*\|\s*(bash|sh|zsh)/, reason: '远程代码执行' },
  { pattern: /sudo\s+rm\s+-[a-zA-Z]*r/, reason: '以 root 递归删除' },
  { pattern: /format\s+[a-zA-Z]:/i, reason: '格式化磁盘分区' },
  { pattern: /git\s+push\s+.*--force.*\s+(main|master)/, reason: '强制推送到主分支' },
]

function checkCommandSafety(command: string): { safe: boolean; reason: string } {
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return { safe: false, reason }
    }
  }
  return { safe: true, reason: '' }
}

/** BOM 和行尾处理(与 src/tools/editFile.ts 保持一致) */
function stripBom(content: string): { bom: string; text: string } {
  if (content.charCodeAt(0) === 0xfeff) {
    return { bom: content[0], text: content.slice(1) }
  }
  return { bom: '', text: content }
}

function detectLineEnding(content: string): 'lf' | 'crlf' {
  const crlfCount = (content.match(/\r\n/g) ?? []).length
  const lfCount = (content.match(/(?<!\r)\n/g) ?? []).length
  return crlfCount > lfCount ? 'crlf' : 'lf'
}

function normalizeToLF(content: string): string {
  return content.replace(/\r\n/g, '\n')
}

function restoreLineEndings(content: string, ending: 'lf' | 'crlf'): string {
  return ending === 'crlf' ? content.replace(/\n/g, '\r\n') : content
}

/** 二进制输出清理 */
function sanitizeOutput(str: string): string {
  return Array.from(str)
    .filter((char) => {
      const code = char.codePointAt(0)
      if (code === undefined) return false
      if (code === 0x09 || code === 0x0a || code === 0x0d) return true
      if (code <= 0x1f) return false
      return true
    })
    .join('')
}

/** 结构化错误返回 */
function errorResult(errorType: string, message: string, suggestion?: string) {
  const parts = [`[${errorType}] ${message}`]
  if (suggestion) parts.push(`建议: ${suggestion}`)
  return { content: [{ type: 'text' as const, text: parts.join('\n') }], isError: true }
}

// ─── MCP Server 实例 ──────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'nexus',
  version: '0.1.0',
})

// ─── read_file ────────────────────────────────────────────────────────────────

server.tool(
  'read_file',
  '读取文件内容,返回带行号的文件内容。超过 2000 行的文件会被截断(只显示头部)。二进制文件会被拒绝。',
  {
    path: z.string().describe('要读取的文件路径(相对于项目根目录)'),
    start_line: z.number().optional().describe('起始行号(从 1 开始)'),
    end_line: z.number().optional().describe('结束行号(包含)'),
  },
  async ({ path: filePath, start_line, end_line }) => {
    try {
      const fullPath = assertPathSafe(filePath)
      const buffer = await readFile(fullPath)

      // 二进制检测
      if (buffer.subarray(0, 8192).includes(0)) {
        return errorResult('BINARY_FILE', `${filePath} 是二进制文件,无法读取`)
      }

      const content = buffer.toString('utf-8')
      const allLines = content.split('\n')
      const totalLines = allLines.length

      // 范围读取
      const start = Math.max(1, start_line ?? 1) - 1
      const end = Math.min(totalLines, end_line ?? totalLines)

      // 截断策略
      if (end - start > MAX_READ_LINES && end_line === undefined) {
        const slice = allLines.slice(0, MAX_READ_LINES)
        const numbered = slice.map((l, i) => `${i + 1}│${l}`).join('\n')
        return {
          content: [{ type: 'text', text: `${filePath} (${totalLines} 行, 已截断至前 ${MAX_READ_LINES} 行)\n${numbered}\n\n... 使用 start_line/end_line 读取更多,或用 grep 搜索 ...` }],
        }
      }

      const slice = allLines.slice(start, end)
      const numbered = slice.map((l, i) => `${start + i + 1}│${l}`).join('\n')
      return { content: [{ type: 'text', text: `${filePath} (${totalLines} 行)\n${numbered}` }] }
    } catch (err) {
      if (err instanceof PathError) return errorResult('PATH_ERROR', err.message)
      const msg = err instanceof Error ? err.message : String(err)
      return errorResult('READ_ERROR', `读取失败: ${msg}`, '检查文件路径是否正确')
    }
  }
)

// ─── edit_file ────────────────────────────────────────────────────────────────

server.tool(
  'edit_file',
  '精准替换文件中的字符串。old_string 必须在文件中唯一匹配(0处匹配报错,>1处匹配也报错)。保留原始 BOM 和行尾风格。使用原子写入(写临时文件→rename)。',
  {
    path: z.string().describe('要编辑的文件路径(相对于项目根目录)'),
    old_string: z.string().describe('要替换的原文,必须在文件中唯一匹配。包含足够上下文以确保唯一性。'),
    new_string: z.string().describe('替换后的新内容'),
  },
  async ({ path: filePath, old_string, new_string }) => {
    try {
      const fullPath = assertPathSafe(filePath)

      let rawContent: string
      try {
        rawContent = await readFile(fullPath, 'utf-8')
      } catch {
        // 文件不存在: old_string 为空时创建新文件
        if (old_string === '') {
          await mkdir(dirname(fullPath), { recursive: true })
          await writeFile(fullPath, new_string, 'utf-8')
          return { content: [{ type: 'text', text: `已创建新文件: ${filePath}` }] }
        }
        return errorResult('FILE_NOT_FOUND', `文件不存在: ${filePath}`, '如果要创建新文件,请将 old_string 设为空字符串')
      }

      // BOM + 行尾处理
      const { bom, text: withoutBom } = stripBom(rawContent)
      const originalEnding = detectLineEnding(withoutBom)
      const normalizedContent = normalizeToLF(withoutBom)
      const normalizedOld = normalizeToLF(old_string)
      const normalizedNew = normalizeToLF(new_string)

      // 唯一匹配校验
      const count = normalizedContent.split(normalizedOld).length - 1
      if (count === 0) {
        return errorResult('NO_MATCH', `old_string 在 ${filePath} 中未找到匹配`, '文件可能已变更,请重新 read_file 获取最新内容')
      }
      if (count > 1) {
        return errorResult('MULTIPLE_MATCH', `old_string 在 ${filePath} 中出现了 ${count} 次`, '请提供更多上下文行以确保唯一匹配')
      }

      // 应用替换 + 恢复格式
      const newContentLF = normalizedContent.replace(normalizedOld, normalizedNew)
      const finalContent = bom + restoreLineEndings(newContentLF, originalEnding)

      // 原子写入
      const tmpPath = `${fullPath}.nexus-tmp-${Date.now()}`
      await writeFile(tmpPath, finalContent, 'utf-8')
      await rename(tmpPath, fullPath)

      return { content: [{ type: 'text', text: `已编辑: ${filePath}` }] }
    } catch (err) {
      if (err instanceof PathError) return errorResult('PATH_ERROR', err.message)
      const msg = err instanceof Error ? err.message : String(err)
      return errorResult('EDIT_ERROR', `编辑失败: ${msg}`)
    }
  }
)

// ─── bash ─────────────────────────────────────────────────────────────────────

server.tool(
  'bash',
  '在项目目录中执行 shell 命令。有超时限制和输出大小限制。危险命令(如 rm -rf /、mkfs、curl|bash)会被拒绝执行。',
  {
    command: z.string().describe('要执行的 shell 命令'),
    timeout: z.number().optional().default(DEFAULT_TIMEOUT_SECONDS).describe('超时时间(秒),默认 30'),
  },
  async ({ command, timeout }) => {
    // 危险命令检测: dangerous 级别直接拒绝
    const safety = checkCommandSafety(command)
    if (!safety.safe) {
      return errorResult('DANGEROUS_COMMAND', `命令被拒绝: ${safety.reason}`, '此命令被安全策略拦截,无法执行')
    }

    try {
      const result = await new Promise<{ stdout: string; stderr: string; code: number; timedOut: boolean }>((res) => {
        const isWin = process.platform === 'win32'
        // 使用 spawn + argv 数组,防止 shell 注入
        const shell = isWin ? 'powershell.exe' : '/bin/bash'
        const shellArgs = isWin ? ['-NoProfile', '-Command', command] : ['-c', command]

        const child = spawn(shell, shellArgs, {
          cwd: PROJECT_ROOT,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, TERM: 'dumb' },
          ...(isWin ? { windowsHide: true } : { detached: true }),
        })

        let stdout = ''
        let stderr = ''
        let timedOut = false
        let settled = false

        const timer = setTimeout(() => {
          timedOut = true
          if (isWin) {
            if (child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
          } else {
            try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
          }
        }, (timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000)

        child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
        child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
        child.on('close', (code) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          res({ stdout, stderr, code: code ?? 1, timedOut })
        })
        child.on('error', (e) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          res({ stdout, stderr: e.message, code: 1, timedOut: false })
        })
      })

      // 清理 + 截断输出
      const cleanStdout = sanitizeOutput(result.stdout).slice(0, MAX_OUTPUT_BYTES)
      const cleanStderr = sanitizeOutput(result.stderr).slice(0, MAX_OUTPUT_BYTES)

      const parts: string[] = [`$ ${command}`, `Exit code: ${result.code}`]
      if (result.timedOut) parts.push(`⚠️ 命令超时 (${timeout}s)`)
      if (cleanStdout.trim()) parts.push(`\n--- stdout ---\n${cleanStdout}`)
      if (cleanStderr.trim()) parts.push(`\n--- stderr ---\n${cleanStderr}`)

      return { content: [{ type: 'text', text: parts.join('\n') }], isError: result.code !== 0 }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return errorResult('EXEC_ERROR', `执行失败: ${msg}`)
    }
  }
)

// ─── grep ─────────────────────────────────────────────────────────────────────

server.tool(
  'grep',
  '使用 ripgrep 在项目中搜索代码。支持正则表达式、文件类型过滤和上下文行。返回匹配的文件:行号:内容。',
  {
    pattern: z.string().describe('搜索模式(支持正则表达式)'),
    path: z.string().optional().describe('搜索路径(相对于项目根目录,默认整个项目)'),
    include: z.string().optional().describe('文件名 glob 过滤(如 "*.ts", "*.{js,jsx}")'),
    context_lines: z.number().optional().describe('显示匹配行前后的上下文行数'),
    case_insensitive: z.boolean().optional().describe('是否忽略大小写'),
  },
  async ({ pattern, path: searchPath, include, context_lines, case_insensitive }) => {
    try {
      // 构建 rg 参数(argv 数组,安全)
      const args = ['--line-number', '--no-heading', '--color', 'never', '--max-count', '100']
      if (case_insensitive) args.push('--ignore-case')
      if (context_lines && context_lines > 0) args.push('--context', String(context_lines))
      if (include) args.push('--glob', include)
      args.push('--', pattern, searchPath ?? '.')

      const result = await new Promise<{ stdout: string; stderr: string; code: number }>((res) => {
        const child = spawn('rg', args, {
          cwd: PROJECT_ROOT,
          stdio: ['ignore', 'pipe', 'pipe'],
          ...(process.platform === 'win32' ? { windowsHide: true } : {}),
        })
        let stdout = ''
        let stderr = ''
        child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
        child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
        child.on('close', (code) => res({ stdout, stderr, code: code ?? 1 }))
        child.on('error', () => res({ stdout: '', stderr: 'ripgrep (rg) 未安装', code: 127 }))
      })

      if (result.code === 127) {
        return errorResult('TOOL_MISSING', 'ripgrep (rg) 未安装', '请安装: https://github.com/BurntSushi/ripgrep#installation')
      }
      if (result.code === 1) {
        return { content: [{ type: 'text', text: `未找到匹配: "${pattern}"` }] }
      }
      if (result.code >= 2) {
        return errorResult('SEARCH_ERROR', `搜索出错: ${result.stderr}`)
      }

      const output = result.stdout.slice(0, MAX_OUTPUT_BYTES)
      const matchCount = output.split('\n').filter(Boolean).length
      return { content: [{ type: 'text', text: `找到 ${matchCount} 处匹配:\n${output}` }] }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return errorResult('SEARCH_ERROR', `搜索失败: ${msg}`)
    }
  }
)

// ─── 启动 + 优雅退出 ──────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`[nexus-mcp] Server running on stdio (project: ${PROJECT_ROOT})`)
  console.error(`[nexus-mcp] Tools: read_file, edit_file, bash, grep`)
  console.error(`[nexus-mcp] Waiting for JSON-RPC requests on stdin...`)
}

// 优雅退出处理
process.on('SIGINT', () => {
  console.error('[nexus-mcp] Received SIGINT, shutting down...')
  process.exit(0)
})

process.on('SIGTERM', () => {
  console.error('[nexus-mcp] Received SIGTERM, shutting down...')
  process.exit(0)
})

main().catch((err) => {
  console.error('[nexus-mcp] Failed to start:', err)
  process.exit(1)
})

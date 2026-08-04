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
import { spawn } from 'child_process'
import { mkdir, readdir, readFile, rename, writeFile } from 'fs/promises'
import { dirname, relative, resolve } from 'path'
import { z } from 'zod'
import { isDangerousCommand } from '../../../src/sandbox/CommandGuard'
import {
  detectLineEnding,
  isInsideProject,
  normalizeToLF,
  restoreLineEndings,
  sanitizeBinaryOutput,
  stripBom,
} from '../../../src/utils/index'

// ─── 配置 ─────────────────────────────────────────────────────────────────────

const PROJECT_ROOT = resolve(process.cwd())
const MAX_OUTPUT_BYTES = 100 * 1024 // 100KB
const DEFAULT_TIMEOUT_SECONDS = 30
const MAX_READ_LINES = 2000

// ─── 安全工具 ─────────────────────────────────────────────────────────────────

/** 路径越界校验: 使用 relative() 检测是否在 PROJECT_ROOT 内，防范前缀匹配绕过 */
function assertPathSafe(filePath: string): string {
  if (!isInsideProject(PROJECT_ROOT, filePath)) {
    throw new PathError(`路径越界: ${filePath} 不在项目目录内`)
  }
  return resolve(PROJECT_ROOT, filePath)
}

class PathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PathError'
  }
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
          content: [
            {
              type: 'text',
              text: `${filePath} (${totalLines} 行, 已截断至前 ${MAX_READ_LINES} 行)\n${numbered}\n\n... 使用 start_line/end_line 读取更多,或用 grep 搜索 ...`,
            },
          ],
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
  },
)

// ─── edit_file ────────────────────────────────────────────────────────────────

server.tool(
  'edit_file',
  '精准替换文件中的字符串。old_string 必须在文件中唯一匹配(0处匹配报错,>1处匹配也报错)。保留原始 BOM 和行尾风格。使用原子写入(写临时文件→rename)。',
  {
    path: z.string().describe('要编辑的文件路径(相对于项目根目录)'),
    old_string: z
      .string()
      .describe('要替换的原文,必须在文件中唯一匹配。包含足够上下文以确保唯一性。'),
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
        return errorResult(
          'FILE_NOT_FOUND',
          `文件不存在: ${filePath}`,
          '如果要创建新文件,请将 old_string 设为空字符串',
        )
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
        return errorResult(
          'NO_MATCH',
          `old_string 在 ${filePath} 中未找到匹配`,
          '文件可能已变更,请重新 read_file 获取最新内容',
        )
      }
      if (count > 1) {
        return errorResult(
          'MULTIPLE_MATCH',
          `old_string 在 ${filePath} 中出现了 ${count} 次`,
          '请提供更多上下文行以确保唯一匹配',
        )
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
  },
)

// ─── bash ─────────────────────────────────────────────────────────────────────

server.tool(
  'bash',
  '在项目目录中执行 shell 命令。有超时限制和输出大小限制。危险命令(如 rm -rf /、mkfs、curl|bash)会被拒绝执行。',
  {
    command: z.string().describe('要执行的 shell 命令'),
    timeout: z
      .number()
      .optional()
      .default(DEFAULT_TIMEOUT_SECONDS)
      .describe('超时时间(秒),默认 30'),
  },
  async ({ command, timeout }) => {
    // 危险命令检测: dangerous 级别直接拒绝(使用核心 CommandGuard 统一检测)
    const assessment = isDangerousCommand(command)
    if (assessment.level === 'dangerous') {
      return errorResult(
        'DANGEROUS_COMMAND',
        `命令被拒绝: ${assessment.reason}`,
        '此命令被安全策略拦截,无法执行',
      )
    }

    try {
      const result = await new Promise<{
        stdout: string
        stderr: string
        code: number
        timedOut: boolean
      }>((res) => {
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

        const timer = setTimeout(
          () => {
            timedOut = true
            if (isWin) {
              if (child.pid)
                spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
            } else {
              try {
                if (child.pid) process.kill(-child.pid, 'SIGKILL')
              } catch {
                child.kill('SIGKILL')
              }
            }
          },
          (timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
        )

        child.stdout?.on('data', (d: Buffer) => {
          stdout += d.toString()
        })
        child.stderr?.on('data', (d: Buffer) => {
          stderr += d.toString()
        })
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

      // 清理 + 截断输出(复用核心 sanitizeBinaryOutput)
      const cleanStdout = sanitizeBinaryOutput(result.stdout).slice(0, MAX_OUTPUT_BYTES)
      const cleanStderr = sanitizeBinaryOutput(result.stderr).slice(0, MAX_OUTPUT_BYTES)

      const parts: string[] = [`$ ${command}`, `Exit code: ${result.code}`]
      if (result.timedOut) parts.push(`⚠️ 命令超时 (${timeout}s)`)
      if (cleanStdout.trim()) parts.push(`\n--- stdout ---\n${cleanStdout}`)
      if (cleanStderr.trim()) parts.push(`\n--- stderr ---\n${cleanStderr}`)

      return { content: [{ type: 'text', text: parts.join('\n') }], isError: result.code !== 0 }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return errorResult('EXEC_ERROR', `执行失败: ${msg}`)
    }
  },
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
        child.stdout?.on('data', (d: Buffer) => {
          stdout += d.toString()
        })
        child.stderr?.on('data', (d: Buffer) => {
          stderr += d.toString()
        })
        child.on('close', (code) => res({ stdout, stderr, code: code ?? 1 }))
        child.on('error', () => res({ stdout: '', stderr: 'ripgrep (rg) 未安装', code: 127 }))
      })

      if (result.code === 127) {
        return errorResult(
          'TOOL_MISSING',
          'ripgrep (rg) 未安装',
          '请安装: https://github.com/BurntSushi/ripgrep#installation',
        )
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
  },
)

// ─── Resources ────────────────────────────────────────────────────────────────

/** nexus://config — 返回当前 Nexus 配置 */
server.resource(
  'nexus-config',
  'nexus://config',
  { description: '当前 Nexus 项目配置（.nexus/config.toml）' },
  async () => {
    try {
      const configPath = resolve(PROJECT_ROOT, '.nexus', 'config.toml')
      const content = await readFile(configPath, 'utf-8')
      return { contents: [{ uri: 'nexus://config', mimeType: 'text/plain', text: content }] }
    } catch {
      return {
        contents: [
          { uri: 'nexus://config', mimeType: 'text/plain', text: '# 配置文件不存在，使用默认配置' },
        ],
      }
    }
  },
)

/** nexus://project-structure — 返回项目目录树 */
server.resource(
  'nexus-project-structure',
  'nexus://project-structure',
  { description: '项目目录树结构（最多 3 层）' },
  async () => {
    try {
      const tree = await buildDirectoryTree(PROJECT_ROOT, 3)
      return {
        contents: [{ uri: 'nexus://project-structure', mimeType: 'text/plain', text: tree }],
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        contents: [
          {
            uri: 'nexus://project-structure',
            mimeType: 'text/plain',
            text: `读取目录结构失败: ${msg}`,
          },
        ],
      }
    }
  },
)

/** 递归构建目录树 */
async function buildDirectoryTree(
  dir: string,
  maxDepth: number,
  prefix = '',
  depth = 0,
): Promise<string> {
  if (depth >= maxDepth) return prefix + '...\n'
  const entries = await readdir(dir, { withFileTypes: true })
  const filtered = entries
    .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'dist')
    .sort((a, b) => {
      // 目录优先
      if (a.isDirectory() && !b.isDirectory()) return -1
      if (!a.isDirectory() && b.isDirectory()) return 1
      return a.name.localeCompare(b.name)
    })

  let result = ''
  for (let i = 0; i < filtered.length; i++) {
    const entry = filtered[i]
    const isLast = i === filtered.length - 1
    const connector = isLast ? '└── ' : '├── '
    const childPrefix = isLast ? '    ' : '│   '
    if (entry.isDirectory()) {
      result += `${prefix}${connector}${entry.name}/\n`
      try {
        const subDir = resolve(dir, entry.name)
        result += await buildDirectoryTree(subDir, maxDepth, prefix + childPrefix, depth + 1)
      } catch {
        // 无权限读取的子目录跳过
      }
    } else {
      result += `${prefix}${connector}${entry.name}\n`
    }
  }
  return result
}

// ─── Prompts ──────────────────────────────────────────────────────────────────

/** nexus://plan — 规划模板 prompt */
server.prompt(
  'nexus-plan',
  '制定任务执行计划',
  { task: z.string().describe('需要规划的任务描述') },
  ({ task }) => ({
    messages: [
      {
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `请为以下任务制定详细的执行计划：\n\n${task}\n\n要求：\n1. 将任务分解为可执行的小步骤\n2. 标注每个步骤需要修改的文件\n3. 评估潜在风险和注意事项\n4. 给出预估步骤数`,
        },
      },
    ],
  }),
)

/** nexus://review — 代码审查模板 prompt */
server.prompt(
  'nexus-review',
  '代码审查',
  {
    file_path: z.string().describe('要审查的文件路径'),
    focus: z.string().optional().describe('审查重点（如性能、安全、可读性）'),
  },
  ({ file_path, focus }) => ({
    messages: [
      {
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `请审查以下文件的代码：\n\n文件: ${file_path}${focus ? `\n审查重点: ${focus}` : ''}\n\n请检查：\n1. 代码质量和可读性\n2. 潜在 bug 和边界情况\n3. 性能问题\n4. 安全风险\n5. 是否符合项目编码规范\n\n请给出具体的改进建议，附带代码示例。`,
        },
      },
    ],
  }),
)

// ─── 启动 + 优雅退出 ──────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`[nexus-mcp] Server running on stdio (project: ${PROJECT_ROOT})`)
  console.error(`[nexus-mcp] Tools: read_file, edit_file, bash, grep`)
  console.error(`[nexus-mcp] Resources: nexus://config, nexus://project-structure`)
  console.error(`[nexus-mcp] Prompts: nexus-plan, nexus-review`)
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

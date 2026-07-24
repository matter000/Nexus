/**
 * bash 工具
 * 执行 shell 命令,带危险命令检测、超时、输出截断、工作目录锁定
 */

import { spawn } from 'child_process'
import { resolve } from 'path'
import type { ToolDefinition, ToolResult } from '../agent/types'
import type { ToolHandler, ToolContext } from './registry'
import { isDangerousCommand } from '../sandbox/CommandGuard'
import { truncateTail, sanitizeBinaryOutput, formatSize } from '../utils'

const definition: ToolDefinition = {
  name: 'bash',
  description:
    '在项目目录中执行 shell 命令。有超时限制和输出大小限制。危险命令会被拦截。工作目录锁定在项目根目录。',
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: '要执行的 shell 命令',
      },
      timeout: {
        type: 'number',
        description: '超时时间(秒),默认 30',
      },
    },
    required: ['command'],
  },
  requiresApproval: true,
  phase: 'execute',
}

interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
}

/** 执行命令,带超时和进程组管理 */
function execCommand(command: string, cwd: string, timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolvePromise) => {
    const isWindows = process.platform === 'win32'
    const shell = isWindows ? 'powershell.exe' : '/bin/bash'
    const shellArgs = isWindows ? ['-Command', command] : ['-c', command]

    const child = spawn(shell, shellArgs, {
      cwd,
      env: { ...process.env, TERM: 'dumb' },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Windows 上用 windowsHide,Unix 上用 detached 以便进程组 kill
      ...(isWindows ? { windowsHide: true } : { detached: true }),
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      killProcessGroup(child, isWindows)
    }, timeoutMs)

    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString()
    })

    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ stdout, stderr, exitCode: code ?? 1, timedOut })
    })

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ stdout, stderr: err.message, exitCode: 1, timedOut: false })
    })
  })
}

/** 杀死整个进程组 */
function killProcessGroup(child: ReturnType<typeof spawn>, isWindows: boolean): void {
  try {
    if (isWindows) {
      // Windows: taskkill /T 杀进程树
      if (child.pid) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      }
    } else {
      // Unix: kill 整个进程组
      if (child.pid) {
        process.kill(-child.pid, 'SIGKILL')
      }
    }
  } catch {
    // 进程可能已退出
    child.kill('SIGKILL')
  }
}

/** 截断输出(借鉴 pi: bash 用尾部截断,保留错误信息) */
function truncateOutput(output: string, maxBytes: number): { text: string; truncated: boolean } {
  // 先清理二进制控制字符
  const sanitized = sanitizeBinaryOutput(output)
  const result = truncateTail(sanitized, { maxBytes, maxLines: 2000 })
  if (!result.truncated) return { text: sanitized, truncated: false }
  return {
    text: `... [输出已截断: 原始 ${result.totalLines} 行/${formatSize(result.totalBytes)}, 保留末尾 ${result.outputLines} 行] ...\n${result.content}`,
    truncated: true,
  }
}

async function execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const { callId, projectRoot, bashTimeout, maxOutputBytes } = context
  const command = params.command as string
  const timeout = ((params.timeout as number) ?? bashTimeout) * 1000

  try {
    // 危险命令检测(这里只做标记,实际拦截在审批层)
    const dangerInfo = isDangerousCommand(command)
    if (dangerInfo.dangerous) {
      // 危险命令仍然执行(审批层已处理),但在结果中标注
      // 实际拦截逻辑在 Orchestrator 的权限检查中
    }

    // 工作目录锁定在项目根
    const cwd = resolve(projectRoot)

    // 执行命令
    const result = await execCommand(command, cwd, timeout)

    // 截断输出
    const stdoutTrunc = truncateOutput(result.stdout, maxOutputBytes)
    const stderrTrunc = truncateOutput(result.stderr, maxOutputBytes)

    // 组装结果
    const parts: string[] = []
    parts.push(`$ ${command}`)
    parts.push(`Exit code: ${result.exitCode}`)

    if (result.timedOut) {
      parts.push(`⚠️ 命令超时 (${timeout / 1000}s)`)
    }

    if (stdoutTrunc.text.trim()) {
      parts.push(`\n--- stdout ---\n${stdoutTrunc.text}`)
    }

    if (stderrTrunc.text.trim()) {
      parts.push(`\n--- stderr ---\n${stderrTrunc.text}`)
    }

    if (dangerInfo.dangerous) {
      parts.push(`\n⚠️ 此命令被标记为潜在危险: ${dangerInfo.reason}`)
    }

    return {
      callId,
      tool: 'bash',
      result: parts.join('\n'),
      error: result.exitCode !== 0 ? `命令退出码: ${result.exitCode}` : undefined,
      truncated: stdoutTrunc.truncated || stderrTrunc.truncated,
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      callId,
      tool: 'bash',
      result: '',
      error: `执行失败: ${message}`,
    }
  }
}

export const bashTool: ToolHandler = { definition, execute }

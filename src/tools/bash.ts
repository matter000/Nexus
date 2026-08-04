/**
 * bash 工具
 * 执行 shell 命令,带危险命令检测、超时、输出截断、工作目录锁定
 * 通过 SandboxEngine 接口执行命令,复用统一的进程管理逻辑
 */

import { resolve } from 'path'
import type { ToolDefinition, ToolResult } from '../agent/types'
import { createSandboxEngine } from '../sandbox/SandboxEngine'
import { formatSize, sanitizeBinaryOutput, truncateTail } from '../utils'
import type { ToolContext, ToolHandler } from './registry'

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
  // 超时：优先用 LLM 指定值，回退到上下文默认值；下限 1 秒防止 0/负值
  const rawTimeout = (params.timeout as number) ?? bashTimeout
  const timeout = Math.max(1, rawTimeout) * 1000

  try {
    // 工作目录锁定在项目根
    const cwd = resolve(projectRoot)

    // 通过 SandboxEngine 执行命令(危险命令检测、超时、进程管理统一在引擎内)
    const engine = createSandboxEngine()
    const result = await engine.execute(command, {
      cwd,
      timeoutMs: timeout,
      maxOutputBytes,
    })

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

    if (result.dangerAssessment?.dangerous) {
      parts.push(`\n⚠️ 此命令被标记为潜在危险: ${result.dangerAssessment.reason}`)
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

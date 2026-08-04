/**
 * Git 操作工具集
 * 提供 git_status、git_commit、git_push 三个工具，让 Agent 能直接操作 Git
 */

import { spawn } from 'child_process'
import type { ToolDefinition, ToolResult } from '../agent/types'
import type { ToolContext, ToolHandler } from './registry'

/** 在项目目录中执行 git 命令 */
function git(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
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

    child.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 })
    })

    child.on('error', (err) => {
      resolve({ stdout: '', stderr: err.message, exitCode: 1 })
    })
  })
}

// ─── git_status ───────────────────────────────────────────────────────────────

const statusDefinition: ToolDefinition = {
  name: 'git_status',
  description: '查看当前 Git 仓库状态（修改、暂存、未跟踪文件）。相当于 git status --short',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  requiresApproval: false,
  phase: 'both',
}

async function statusExecute(
  _params: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  const { callId } = context

  const { stdout, stderr, exitCode } = await git(
    ['status', '--short', '--branch'],
    context.projectRoot,
  )

  if (exitCode !== 0 && stderr) {
    return {
      callId,
      tool: 'git_status',
      result: '',
      error: `Git 执行失败: ${stderr}`,
    }
  }

  // 额外获取更多信息
  const [statusResult, logResult] = await Promise.all([
    git(['status', '--short', '--branch'], context.projectRoot),
    git(['log', '--oneline', '-5'], context.projectRoot),
  ])

  const lines: string[] = []
  lines.push('=== Git 状态 ===')
  lines.push(statusResult.stdout.trim() || '(工作区干净)')
  lines.push('')
  lines.push('=== 最近提交 ===')
  lines.push(logResult.stdout.trim() || '(无提交记录)')

  return {
    callId,
    tool: 'git_status',
    result: lines.join('\n'),
  }
}

// ─── git_commit ───────────────────────────────────────────────────────────────

const commitDefinition: ToolDefinition = {
  name: 'git_commit',
  description: '暂存所有更改并创建 Git 提交。需要提交信息。',
  inputSchema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: '提交信息',
      },
      files: {
        type: 'string',
        description: '要暂存的文件路径（可选，多个文件用空格分隔）。默认暂存所有更改',
      },
    },
    required: ['message'],
  },
  requiresApproval: true,
  phase: 'execute',
}

async function commitExecute(
  params: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  const { callId } = context
  const message = params.message as string
  const files = (params.files as string) ?? '.'

  if (!message || !message.trim()) {
    return {
      callId,
      tool: 'git_commit',
      result: '',
      error: '提交信息不能为空',
    }
  }

  // 先 add
  const addResult = await git(['add', ...files.split(/\s+/)], context.projectRoot)
  if (addResult.exitCode !== 0 && addResult.stderr) {
    return {
      callId,
      tool: 'git_commit',
      result: '',
      error: `git add 失败: ${addResult.stderr}`,
    }
  }

  // 再 commit
  const commitResult = await git(['commit', '-m', message], context.projectRoot)
  if (commitResult.exitCode !== 0) {
    return {
      callId,
      tool: 'git_commit',
      result: '',
      error: `git commit 失败: ${commitResult.stderr}`,
    }
  }

  return {
    callId,
    tool: 'git_commit',
    result: `✅ 提交成功\n\n${commitResult.stdout}`,
  }
}

// ─── git_push ────────────────────────────────────────────────────────────────

const pushDefinition: ToolDefinition = {
  name: 'git_push',
  description: '将本地提交推送到远程仓库。可指定分支名，默认推送到当前分支。',
  inputSchema: {
    type: 'object',
    properties: {
      remote: {
        type: 'string',
        description: '远程仓库名（默认 origin）',
      },
      branch: {
        type: 'string',
        description: '要推送的分支名（可选，默认推送到当前分支的 upstream）',
      },
      force: {
        type: 'boolean',
        description: '是否强制推送（默认 false）',
      },
    },
    required: [],
  },
  requiresApproval: true,
  phase: 'execute',
}

async function pushExecute(
  params: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  const { callId } = context
  const remote = (params.remote as string) ?? 'origin'
  const branch = params.branch as string | undefined
  const force = (params.force as boolean) ?? false

  const args = ['push']
  if (force) args.push('--force')
  args.push(remote)
  if (branch) args.push(branch)

  const result = await git(args, context.projectRoot)
  if (result.exitCode !== 0) {
    return {
      callId,
      tool: 'git_push',
      result: '',
      error: `git push 失败: ${result.stderr}`,
    }
  }

  return {
    callId,
    tool: 'git_push',
    result: `✅ 推送成功\n\n${result.stdout}`,
  }
}

// ─── 导出 ─────────────────────────────────────────────────────────────────────

export const gitStatusTool: ToolHandler = { definition: statusDefinition, execute: statusExecute }
export const gitCommitTool: ToolHandler = { definition: commitDefinition, execute: commitExecute }
export const gitPushTool: ToolHandler = { definition: pushDefinition, execute: pushExecute }

/**
 * grep 工具
 * 封装 ripgrep,支持正则/文件过滤/上下文行
 */

import { spawn } from 'child_process'
import { resolve } from 'path'
import type { ToolDefinition, ToolResult } from '../agent/types'
import type { ToolHandler, ToolContext } from './registry'
import { isInsideProject } from '../utils'

const definition: ToolDefinition = {
  name: 'grep',
  description:
    '在项目中搜索代码。使用 ripgrep 进行快速正则搜索。支持文件类型过滤和上下文行。返回匹配的文件:行号:内容。',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: '搜索模式(支持正则表达式)',
      },
      path: {
        type: 'string',
        description: '搜索路径(相对于项目根目录,默认为整个项目)',
      },
      include: {
        type: 'string',
        description: '文件名 glob 过滤(如 "*.ts", "*.{js,jsx}")',
      },
      context_lines: {
        type: 'number',
        description: '显示匹配行前后的上下文行数(默认 0)',
      },
      case_insensitive: {
        type: 'boolean',
        description: '是否忽略大小写(默认 false)',
      },
    },
    required: ['pattern'],
  },
  requiresApproval: false,
  phase: 'both',
}

/** 执行 ripgrep 搜索 */
function runRipgrep(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolvePromise) => {
    // 尝试使用 rg,如果不存在则回退到 findstr/grep
    const isWindows = process.platform === 'win32'
    const cmd = 'rg'

    const child = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(isWindows ? { windowsHide: true } : {}),
    })

    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString()
    })

    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    child.on('close', (code) => {
      resolvePromise({ stdout, stderr, exitCode: code ?? 1 })
    })

    child.on('error', (err) => {
      // rg 不存在时回退
      resolvePromise({ stdout: '', stderr: `ripgrep 不可用: ${err.message}`, exitCode: 127 })
    })
  })
}

async function execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const { callId, projectRoot, maxOutputBytes } = context
  const pattern = params.pattern as string
  const searchPath = (params.path as string) ?? '.'
  const include = params.include as string | undefined
  const contextLines = (params.context_lines as number) ?? 0
  const caseInsensitive = (params.case_insensitive as boolean) ?? false

  try {
    // 安全检查：搜索路径不能越出项目根
    if (!isInsideProject(projectRoot, searchPath)) {
      return {
        callId,
        tool: 'grep',
        result: '',
        error: `路径越界: ${searchPath} 不在项目目录内`,
      }
    }
    const cwd = resolve(projectRoot)

    // 构建 rg 参数
    const args: string[] = [
      '--line-number',    // 显示行号
      '--no-heading',     // 不用文件标题分组
      '--color', 'never', // 不要颜色
      '--max-count', '100', // 限制每个文件最多 100 个匹配
    ]

    if (caseInsensitive) {
      args.push('--ignore-case')
    }

    if (contextLines > 0) {
      args.push(`--context`, String(contextLines))
    }

    if (include) {
      args.push('--glob', include)
    }

    // 搜索模式
    args.push('--', pattern)

    // 搜索路径
    args.push(searchPath)

    const result = await runRipgrep(args, cwd)

    // rg exit code: 0=有匹配, 1=无匹配, 2=错误
    if (result.exitCode === 127) {
      // ripgrep 不可用,回退到简单搜索提示
      return {
        callId,
        tool: 'grep',
        result: '',
        error: 'ripgrep (rg) 未安装。请安装 ripgrep: https://github.com/BurntSushi/ripgrep#installation',
      }
    }

    if (result.exitCode === 1) {
      return {
        callId,
        tool: 'grep',
        result: `未找到匹配: "${pattern}"${include ? ` (在 ${include} 中)` : ''}`,
      }
    }

    if (result.exitCode >= 2) {
      return {
        callId,
        tool: 'grep',
        result: '',
        error: `搜索出错: ${result.stderr}`,
      }
    }

    // 截断过长的结果
    let output = result.stdout
    let truncated = false
    const bytes = Buffer.byteLength(output, 'utf-8')
    if (bytes > maxOutputBytes) {
      output = output.slice(0, maxOutputBytes)
      output += '\n\n... [结果已截断,请缩小搜索范围或使用更精确的模式] ...'
      truncated = true
    }

    // 统计匹配数
    const matchCount = output.split('\n').filter((l) => l.trim()).length

    return {
      callId,
      tool: 'grep',
      result: `找到 ${matchCount} 处匹配:\n${output}`,
      truncated,
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      callId,
      tool: 'grep',
      result: '',
      error: `搜索失败: ${message}`,
    }
  }
}

export const grepTool: ToolHandler = { definition, execute }

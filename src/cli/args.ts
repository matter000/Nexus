/**
 * Nexus CLI 参数解析
 * 支持: nexus [options] [initial_prompt]
 */

import type { PermissionMode } from '../agent/types'

export interface CliArgs {
  /** 初始提示(直接传入任务) */
  prompt?: string
  /** 权限模式 */
  permissionMode: PermissionMode
  /** 指定模型 */
  model?: string
  /** 指定 provider */
  provider?: string
  /** 项目根目录(默认 cwd) */
  cwd: string
  /** 是否显示详细日志 */
  verbose: boolean
  /** 是否跳过 plan 阶段(简单任务) */
  skipPlan: boolean
  /** 最大迭代步数 */
  maxIterations?: number
  /** 显示版本 */
  version: boolean
  /** 显示帮助 */
  help: boolean
  /** 非交互模式(执行完即退出) */
  nonInteractive: boolean
  /** eval 子命令：任务目录路径 */
  evalDir?: string
  /** eval 模式：mock 或 real */
  evalMock: boolean
  /** eval：只运行指定 ID 的任务 */
  evalTask?: string
  /** eval：输出 JSON 报告到文件 */
  evalJson?: string
  /** 恢复上次会话（可指定 sessionId） */
  resume?: string | boolean
}

const HELP_TEXT = `
Nexus - 终端 AI 编程助手

用法:
  nexus [options] [prompt]

选项:
  -m, --model <model>        指定模型 (e.g. claude-sonnet-4-20250514, gpt-4o)
  -p, --provider <provider>  指定 provider (anthropic, openai, deepseek, custom)
  --permission <mode>        权限模式: ask | auto-edit | auto-all | yolo
  --cwd <dir>                项目根目录 (默认: 当前目录)
  --skip-plan                跳过 Plan 阶段,直接执行
  --max-iterations <n>       最大迭代步数 (默认: 50)
  --non-interactive          非交互模式,执行完即退出
  --resume [sessionId]       恢复上次会话（或指定会话 ID）
  -v, --verbose              显示详细日志
  --version                  显示版本号
  -h, --help                 显示帮助

示例:
  nexus                          启动交互式会话
  nexus "重构 utils 模块"         带初始任务启动
  nexus -m gpt-4o "修复 bug"     指定模型
  nexus --permission auto-edit   自动批准编辑操作
`

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    permissionMode: 'ask',
    cwd: process.cwd(),
    verbose: false,
    skipPlan: false,
    version: false,
    help: false,
    nonInteractive: false,
    evalMock: false,
  }

  const positional: string[] = []
  let i = 0

  while (i < argv.length) {
    const arg = argv[i]

    switch (arg) {
      case '-m':
      case '--model':
        args.model = argv[++i]
        break
      case '-p':
      case '--provider':
        args.provider = argv[++i]
        break
      case '--permission': {
        const mode = argv[++i] as string
        const validModes: PermissionMode[] = ['ask', 'auto-edit', 'auto-all', 'yolo']
        if (!validModes.includes(mode as PermissionMode)) {
          console.error(`错误: 无效的权限模式 "${mode}"，可选值: ${validModes.join(', ')}`)
          process.exit(1)
        }
        args.permissionMode = mode as PermissionMode
        break
      }
      case '--cwd':
        args.cwd = argv[++i]
        break
      case '--skip-plan':
        args.skipPlan = true
        break
      case '--max-iterations': {
        const val = parseInt(argv[++i], 10)
        if (isNaN(val) || val < 1) {
          console.error(`错误: --max-iterations 必须是正整数`)
          process.exit(1)
        }
        args.maxIterations = val
        break
      }
      case '--non-interactive':
        args.nonInteractive = true
        break
      case '--resume': {
        // --resume 可带可不带参数：下一个参数如果不以 - 开头则视为 sessionId
        const next = argv[i + 1]
        if (next && !next.startsWith('-')) {
          args.resume = next
          i++
        } else {
          args.resume = true
        }
        break
      }
      case 'eval':
        args.evalDir = argv[++i]
        break
      case '--mock':
        args.evalMock = true
        break
      case '--task':
        args.evalTask = argv[++i]
        break
      case '--json':
        args.evalJson = argv[++i]
        break
      case '-v':
      case '--verbose':
        args.verbose = true
        break
      case '--version':
        args.version = true
        break
      case '-h':
      case '--help':
        args.help = true
        break
      default:
        if (!arg.startsWith('-')) {
          positional.push(arg)
        }
        break
    }
    i++
  }

  if (positional.length > 0) {
    args.prompt = positional.join(' ')
  }

  return args
}

export function getHelpText(): string {
  return HELP_TEXT
}

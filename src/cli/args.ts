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
}

const HELP_TEXT = `
Nexus - 终端 AI 编程助手

用法:
  nexus [options] [prompt]

选项:
  -m, --model <model>        指定模型 (e.g. claude-sonnet-4-20250514, gpt-4o)
  -p, --provider <provider>  指定 provider (anthropic, openai, ollama)
  --permission <mode>        权限模式: ask | auto-edit | auto-all | yolo
  --cwd <dir>                项目根目录 (默认: 当前目录)
  --skip-plan                跳过 Plan 阶段,直接执行
  --max-iterations <n>       最大迭代步数 (默认: 50)
  --non-interactive          非交互模式,执行完即退出
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
      case '--permission':
        args.permissionMode = argv[++i] as PermissionMode
        break
      case '--cwd':
        args.cwd = argv[++i]
        break
      case '--skip-plan':
        args.skipPlan = true
        break
      case '--max-iterations':
        args.maxIterations = parseInt(argv[++i], 10)
        break
      case '--non-interactive':
        args.nonInteractive = true
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

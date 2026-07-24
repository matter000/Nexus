/**
 * 斜杠命令注册与处理
 * /model /cost /clear /undo /history /help
 */

export interface SlashCommand {
  name: string
  aliases: string[]
  description: string
  handler: (args: string, ctx: CommandContext) => Promise<string | void>
}

export interface CommandContext {
  getModel: () => string
  setModel: (model: string) => void
  getCost: () => { total: number; inputTokens: number; outputTokens: number }
  clearContext: () => void
  undo: () => Promise<string>
  getHistory: () => string[]
}

const commands: SlashCommand[] = [
  {
    name: 'model',
    aliases: ['m'],
    description: '查看或切换当前模型',
    handler: async (args, ctx) => {
      if (!args.trim()) {
        return `当前模型: ${ctx.getModel()}`
      }
      ctx.setModel(args.trim())
      return `已切换模型为: ${args.trim()}`
    },
  },
  {
    name: 'cost',
    aliases: ['c'],
    description: '查看本次会话花费',
    handler: async (_args, ctx) => {
      const cost = ctx.getCost()
      return `本次会话: $${cost.total.toFixed(4)} (${cost.inputTokens} input / ${cost.outputTokens} output tokens)`
    },
  },
  {
    name: 'clear',
    aliases: ['cls'],
    description: '清除当前上下文',
    handler: async (_args, ctx) => {
      ctx.clearContext()
      return '上下文已清除'
    },
  },
  {
    name: 'undo',
    aliases: ['u'],
    description: '回滚到上一个检查点',
    handler: async (_args, ctx) => {
      return await ctx.undo()
    },
  },
  {
    name: 'history',
    aliases: ['h'],
    description: '查看会话历史',
    handler: async (_args, ctx) => {
      const history = ctx.getHistory()
      if (history.length === 0) return '暂无历史记录'
      return history.map((h, i) => `${i + 1}. ${h}`).join('\n')
    },
  },
  {
    name: 'help',
    aliases: ['?'],
    description: '显示可用命令',
    handler: async () => {
      return commands
        .map((cmd) => `/${cmd.name} (${cmd.aliases.join(', ')}) - ${cmd.description}`)
        .join('\n')
    },
  },
]

export function isSlashCommand(input: string): boolean {
  return input.startsWith('/')
}

export async function handleSlashCommand(input: string, ctx: CommandContext): Promise<string | null> {
  const trimmed = input.slice(1) // 去掉 /
  const [name, ...rest] = trimmed.split(' ')
  const args = rest.join(' ')

  const cmd = commands.find(
    (c) => c.name === name || c.aliases.includes(name)
  )

  if (!cmd) {
    return `未知命令: /${name}。输入 /help 查看可用命令。`
  }

  const result = await cmd.handler(args, ctx)
  return result ?? null
}

export function getAvailableCommands(): SlashCommand[] {
  return commands
}

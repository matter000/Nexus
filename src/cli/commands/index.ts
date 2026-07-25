/**
 * 斜杠命令注册与处理
 * /model /cost /clear /undo /compact /resume /help
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
  /** 重新初始化 providers 并切换到指定模型（用于添加新模型后的保存与切换） */
  reinitAndSelectModel: (model: string) => Promise<void>
  /** 仅重新初始化 providers（用于删除自定义模型后回退 auto 选择） */
  reinitProviders: () => Promise<void>
  getAvailableModels: () => Array<{ name: string; provider: string; current: boolean }>
  getAllKnownModels: () => Array<{ name: string; provider: string; configured: boolean; current: boolean }>
  isProviderConfigured: (providerName: string) => boolean
  getCost: () => { total: number; inputTokens: number; outputTokens: number; byModel?: Record<string, { cost: number; inputTokens: number; outputTokens: number }> }
  clearContext: () => void
  undo: () => Promise<string>
  compact: () => Promise<{ tokensUsed: number } | string>
  getHistory: () => string[]
  /** 设置是否跳过 Plan 阶段（运行时切换 plan/auto 模式） */
  setSkipPlan: (skip: boolean) => void
  /** 获取当前是否跳过 Plan 阶段 */
  getSkipPlan: () => boolean
  /** 将当前模型持久化到 secrets（下次启动时恢复） */
  saveLastModel: (model: string) => Promise<void>
  /** 恢复指定会话（或最近一次） */
  restoreSession: (sessionId?: string) => Promise<{ restored: boolean; message: string }>
  /** 列出最近会话 */
  listRecentSessions: (limit?: number) => Array<{ id: string; startTime: number; messageCount: number; cost: number }>
  /** 导出当前会话 */
  exportSession: (outputPath?: string) => Promise<string>
  /** 获取系统状态 */
  getStatus: () => { db: boolean; codeGraph: boolean; mcp: boolean; watcher: boolean; model: string; cost: number }
}

const commands: SlashCommand[] = [
  {
    name: 'model',
    aliases: ['m'],
    description: '查看或切换当前模型',
    handler: async (args, ctx) => {
      if (!args.trim()) {
        const current = ctx.getModel()
        // 无参数 /model 由 TUI 层拦截打开交互式选择器；此文本作为非交互兜底提示
        return `当前模型: ${current}\n\n(交互模式下输入 /model 打开选择器；使用 /model <名称> 直接切换，或 /config 打开配置面板)`
      }

      const modelName = args.trim()
      const allModels = ctx.getAllKnownModels()
      const modelInfo = allModels.find((m) => m.name === modelName)

      if (!modelInfo) {
        const known = allModels.map((m) => m.name).join(', ')
        return `未知模型: ${modelName}\n已知模型: ${known}`
      }

      if (!ctx.isProviderConfigured(modelInfo.provider)) {
        const envVar = modelInfo.provider.toUpperCase() + '_API_KEY'
        return `模型 ${modelName} 需要 ${envVar}，请先通过 /config 或环境变量配置`
      }

      ctx.setModel(modelName)
      await ctx.saveLastModel(modelName)
      return `已切换到模型: ${modelName}`
    },
  },
  {
    name: 'config',
    aliases: ['api'],
    description: '打开交互式 API 配置面板（↑↓ 选择 Provider，输入 Key/URL/Model）',
    handler: async () => {
      // 由 TUI 层（App.tsx）拦截并打开配置面板；此 handler 仅作非交互兜底
      return '交互模式下输入 /config 打开配置面板，按 ↑↓ 选择 Provider 并配置 API Key'
    },
  },
  {
    name: 'cost',
    aliases: [],
    description: '查看本次会话花费（含按模型分类明细）',
    handler: async (_args, ctx) => {
      const cost = ctx.getCost()
      const lines: string[] = [
        `本次会话: $${cost.total.toFixed(4)}`,
        `  输入 tokens: ${cost.inputTokens}`,
        `  输出 tokens: ${cost.outputTokens}`,
      ]
      if (cost.byModel && Object.keys(cost.byModel).length > 0) {
        lines.push('\n按模型分类:')
        for (const [model, info] of Object.entries(cost.byModel)) {
          lines.push(`  ${model}: $${info.cost.toFixed(4)} (${info.inputTokens} in / ${info.outputTokens} out)`)
        }
      }
      return lines.join('\n')
    },
  },
  {
    name: 'clear',
    aliases: ['cls'],
    description: '清除当前对话上下文',
    handler: async (_args, ctx) => {
      ctx.clearContext()
      return '对话上下文已清除'
    },
  },
  {
    name: 'compact',
    aliases: [],
    description: '触发上下文压缩，减少 token 使用',
    handler: async (_args, ctx) => {
      const result = await ctx.compact()
      if (typeof result === 'string') {
        return result
      }
      return `上下文已压缩，当前 token 使用: ~${Math.round(result.tokensUsed / 1000)}k`
    },
  },
  {
    name: 'undo',
    aliases: ['u'],
    description: '回滚到上一个 Git 检查点',
    handler: async (_args, ctx) => {
      return await ctx.undo()
    },
  },
  {
    name: 'resume',
    aliases: ['r'],
    description: '恢复历史会话（/resume 恢复最近一次，/resume <id> 恢复指定会话）',
    handler: async (args, ctx) => {
      const sessionId = args.trim() || undefined

      // 无参数时先展示最近会话列表，然后恢复最近一次
      if (!sessionId) {
        const sessions = ctx.listRecentSessions(5)
        if (sessions.length === 0) return '没有可恢复的历史会话'

        const result = await ctx.restoreSession()
        const list = sessions.map((s, i) => {
          const time = new Date(s.startTime).toLocaleString()
          const marker = i === 0 ? ' ← 已恢复' : ''
          return `  ${i + 1}. [${s.id.slice(0, 8)}] ${time} | ${s.messageCount} 条消息 | $${s.cost.toFixed(4)}${marker}`
        }).join('\n')
        return `${result.message}\n\n最近会话:\n${list}\n\n提示: 使用 /resume <id> 恢复其他会话`
      }

      const result = await ctx.restoreSession(sessionId)
      return result.message
    },
  },
  {
    name: 'plan',
    aliases: [],
    description: '切换到 Plan 模式（规划→审批→执行）',
    handler: async (_args, ctx) => {
      ctx.setSkipPlan(false)
      return '已切换到 Plan 模式（规划→审批→执行）'
    },
  },
  {
    name: 'auto',
    aliases: [],
    description: '切换到 Auto 模式（跳过规划，直接执行）',
    handler: async (_args, ctx) => {
      ctx.setSkipPlan(true)
      return '已切换到 Auto 模式（跳过规划，直接执行）'
    },
  },
  {
    name: 'eval',
    aliases: [],
    description: '运行评估任务（nexus eval <dir> 的 TUI 入口）',
    handler: async () => {
      return '请使用 CLI 命令: nexus eval <任务目录> [--mock] [--task <id>] [--json <file>]'
    },
  },
  {
    name: 'status',
    aliases: ['st'],
    description: '显示各子系统健康状态（DB/CodeGraph/MCP/Watcher）',
    handler: async (_args, ctx) => {
      const status = ctx.getStatus()
      const icon = (ok: boolean) => ok ? '✅' : '❌'
      return [
        `系统状态:`,
        `  ${icon(status.db)} 数据库 (NexusDB)`,
        `  ${icon(status.codeGraph)} 代码图谱 (CodeGraph)`,
        `  ${icon(status.mcp)} 外部 MCP Server`,
        `  ${icon(status.watcher)} 文件监听 (FileWatcher)`,
        ``,
        `  模型: ${status.model}`,
        `  花费: $${status.cost.toFixed(4)}`,
      ].join('\n')
    },
  },
  {
    name: 'export',
    aliases: ['e'],
    description: '导出当前会话为 Markdown 文件（/export [路径]）',
    handler: async (args, ctx) => {
      const outputPath = args.trim() || undefined
      try {
        const filePath = await ctx.exportSession(outputPath)
        return `会话已导出到: ${filePath}`
      } catch (err) {
        return `导出失败: ${err instanceof Error ? err.message : String(err)}`
      }
    },
  },
  {
    name: 'help',
    aliases: ['?'],
    description: '显示可用命令及其说明',
    handler: async () => {
      return commands
        .map((cmd) => {
          const aliasStr = cmd.aliases.length > 0 ? ` (别名: ${cmd.aliases.join(', ')})` : ''
          return `/${cmd.name}${aliasStr} — ${cmd.description}`
        })
        .join('\n')
    },
  },
]

export function isSlashCommand(input: string): boolean {
  return input.startsWith('/')
}

/**
 * 根据用户输入的前缀查找匹配的命令
 * 匹配策略（优先级从高到低）：
 *  1. 精确匹配命令名或别名
 *  2. 前缀匹配命令名（不含别名）
 */
function findMatchingCommands(name: string): SlashCommand[] {
  // 精确匹配命令名
  const exactName = commands.find((c) => c.name === name)
  if (exactName) return [exactName]

  // 精确匹配别名
  const exactAlias = commands.find((c) => c.aliases.includes(name))
  if (exactAlias) return [exactAlias]

  // 前缀匹配命令名（不匹配别名，避免 /m 误匹配所有命令）
  return commands.filter((c) => c.name.startsWith(name))
}

export async function handleSlashCommand(input: string, ctx: CommandContext): Promise<string | null> {
  const trimmed = input.slice(1) // 去掉 /
  const [name, ...rest] = trimmed.split(' ')
  const args = rest.join(' ')

  const matches = findMatchingCommands(name)

  if (matches.length === 0) {
    return `未知命令: /${name}。输入 /help 查看可用命令。`
  }

  // 多个匹配时提示用户更精确
  if (matches.length > 1) {
    const suggestions = matches.map((c) => `/${c.name}`).join(', ')
    return `命令模糊，请更精确输入。匹配项: ${suggestions}`
  }

  const result = await matches[0].handler(args, ctx)
  return result ?? null
}

export function getAvailableCommands(): SlashCommand[] {
  return commands
}

/**
 * 获取以指定前缀开头的命令名列表（用于自动补全）
 */
export function getCommandCompletions(prefix: string): string[] {
  const p = prefix.startsWith('/') ? prefix.slice(1) : prefix
  return commands
    .filter((c) => c.name.startsWith(p))
    .map((c) => `/${c.name}`)
}

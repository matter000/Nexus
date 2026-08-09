/**
 * 斜杠命令注册与处理
 * /model /cost /clear /undo /compact /resume /help
 */

export interface SlashCommand {
  name: string
  aliases: string[]
  description: string
  /** 分组（/help 按组展示；缺省归入“系统”） */
  group?: '模型' | '会话' | '循环' | '工具' | '系统'
  handler: (args: string, ctx: CommandContext) => Promise<string | void>
}

export interface CommandContext {
  getModel: () => string
  setModel: (model: string) => void
  /** 中断当前执行（触发 Orchestrator.abort()，中止正在进行的 LLM 调用/工具） */
  interrupt: () => void
  /** 重新初始化 providers 并切换到指定模型（用于添加新模型后的保存与切换） */
  reinitAndSelectModel: (model: string) => Promise<void>
  /** 仅重新初始化 providers（用于删除自定义模型后回退 auto 选择） */
  reinitProviders: () => Promise<void>
  getAvailableModels: () => Array<{ name: string; provider: string; current: boolean }>
  getAllKnownModels: () => Array<{
    name: string
    provider: string
    configured: boolean
    current: boolean
  }>
  isProviderConfigured: (providerName: string) => boolean
  getCost: () => {
    total: number
    inputTokens: number
    outputTokens: number
    byModel?: Record<string, { cost: number; inputTokens: number; outputTokens: number }>
    /** DeepSeek 缓存/推理统计 */
    cacheHitTokens?: number
    cacheMissTokens?: number
    cacheHitRate?: number
    cacheSavedCost?: number
    reasoningTokens?: number
    reasoningPercentage?: number
  }
  clearContext: () => void
  undo: () => Promise<string>
  compact: () => Promise<{ tokensUsed: number } | string>
  getHistory: () => string[]
  /** 设置是否跳过 Plan 阶段（运行时切换 plan/auto 模式） */
  setSkipPlan: (skip: boolean) => void
  /** 获取当前是否跳过 Plan 阶段 */
  getSkipPlan: () => boolean
  /** 运行时切换权限模式（Shift+Tab 轮换 ask → auto-edit → auto-all → yolo） */
  setPermissionMode: (mode: 'ask' | 'auto-edit' | 'auto-all' | 'yolo') => void
  /** 获取当前权限模式 */
  getPermissionMode: () => 'ask' | 'auto-edit' | 'auto-all' | 'yolo'
  /** 将当前模型持久化到 secrets（下次启动时恢复） */
  saveLastModel: (model: string) => Promise<void>
  /** 恢复指定会话（或最近一次） */
  restoreSession: (sessionId?: string) => Promise<{ restored: boolean; message: string }>
  /** 列出最近会话 */
  listRecentSessions: (
    limit?: number,
  ) => Array<{ id: string; startTime: number; messageCount: number; cost: number }>
  /** 导出当前会话 */
  exportSession: (outputPath?: string) => Promise<string>
  /** 获取系统状态 */
  getStatus: () => {
    db: boolean
    codeGraph: boolean
    mcp: boolean
    watcher: boolean
    model: string
    cost: number
  }
  /** 搜索会话消息 */
  searchSessions: (query: string) => string
  /** 设置自动修复模式的重试次数（0=关闭，1-3=开启） */
  setAutoRetries: (retries: number) => void
  /** 获取当前自动修复重试次数 */
  getAutoRetries: () => number
  /** 获取最近的错误报告 */
  getRecentErrors: (limit?: number) => Promise<string>
  /** 查看学习记忆统计与 top 教训 */
  listMemory: () => string
  /** 删除一条教训或技能 */
  deleteMemoryEntry: (kind: 'lesson' | 'skill', id: number | string) => string
  /** 列出技能文件 */
  listSkills: () => string
  /** 列出已安装插件 */
  listPlugins: () => string
  /**
   * L3 事件驱动循环：/goal 目标驱动（跨多次 execute 的验收循环，门禁优先 + verifier 兜底）。
   * 未注入（如测试环境）时为 undefined，命令提示不可用。
   */
  runGoal?: (
    goal: string,
    opts?: { acceptance?: string; maxRounds?: number; maxCost?: number },
  ) => Promise<{
    achieved: boolean
    rounds: number
    roundSummaries: Array<{
      round: number
      evidencePassed: boolean | null
      verifyPass: boolean | null
      cost: number
    }>
  }>
  /** L3 事件驱动循环：/loop 节拍循环（间隔重跑 + loop-state.md 状态文件） */
  runLoop?: (
    prompt: string,
    opts?: { intervalMin?: number; maxRounds?: number; maxCost?: number },
  ) => Promise<string>
  /** 本地 Automations：列出全部 loop 运行时信息（/loops 列表） */
  listLoops?: () => Array<{
    name: string
    scheduleMin: number
    enabled: boolean
    nextRunAt: number | null
    lastRunAt: number | null
    lastResultSummary: string
    running: boolean
    pausedReason: string | null
  }>
  /** 本地 Automations：手动触发指定 loop */
  runLoopNow?: (name: string) => Promise<string | null>
  /** 本地 Automations：启停指定 loop */
  setLoopEnabled?: (name: string, enabled: boolean) => Promise<void>
  /** 本地 Automations：Triage 收件箱（分级发现） */
  getLoopInbox?: (name?: string) => Promise<string>
}

const commands: SlashCommand[] = [
  {
    name: 'model',
    aliases: ['m'],
    description: '查看或切换当前模型',
    group: '模型',
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
    group: '模型',
    handler: async () => {
      // 由 TUI 层（App.tsx）拦截并打开配置面板；此 handler 仅作非交互兜底
      return '交互模式下输入 /config 打开配置面板，按 ↑↓ 选择 Provider 并配置 API Key'
    },
  },
  {
    name: 'cost',
    aliases: [],
    description: '查看本次会话花费（含按模型分类、缓存命中与推理统计）',
    group: '模型',
    handler: async (_args, ctx) => {
      const cost = ctx.getCost()
      const lines: string[] = [
        `本次会话: $${cost.total.toFixed(4)}`,
        `  输入 tokens: ${cost.inputTokens}`,
        `  输出 tokens: ${cost.outputTokens}`,
      ]
      // DeepSeek 缓存/推理统计（有数据才展示）
      const cacheTotal = (cost.cacheHitTokens ?? 0) + (cost.cacheMissTokens ?? 0)
      if (cacheTotal > 0) {
        lines.push(
          `  缓存命中: ${((cost.cacheHitRate ?? 0) * 100).toFixed(1)}% (${cost.cacheHitTokens} hit / ${cost.cacheMissTokens} miss)`,
        )
        if ((cost.cacheSavedCost ?? 0) > 0) {
          lines.push(
            `  缓存节省: $${(cost.cacheSavedCost ?? 0).toFixed(4)}（分级计费已计入总花费）`,
          )
        }
      }
      if ((cost.reasoningTokens ?? 0) > 0) {
        lines.push(
          `  推理 tokens: ${cost.reasoningTokens}（占输出 ${(cost.reasoningPercentage ?? 0).toFixed(1)}%）`,
        )
      }
      if (cost.byModel && Object.keys(cost.byModel).length > 0) {
        lines.push('\n按模型分类:')
        for (const [model, info] of Object.entries(cost.byModel)) {
          lines.push(
            `  ${model}: $${info.cost.toFixed(4)} (${info.inputTokens} in / ${info.outputTokens} out)`,
          )
        }
      }
      return lines.join('\n')
    },
  },
  {
    name: 'clear',
    aliases: ['cls'],
    description: '清除当前对话上下文',
    group: '会话',
    handler: async (_args, ctx) => {
      ctx.clearContext()
      return '对话上下文已清除'
    },
  },
  {
    name: 'compact',
    aliases: [],
    description: '触发上下文压缩，减少 token 使用',
    group: '会话',
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
    group: '会话',
    handler: async (_args, ctx) => {
      return await ctx.undo()
    },
  },
  {
    name: 'resume',
    aliases: ['r'],
    description: '恢复历史会话（/resume 恢复最近一次，/resume <id> 恢复指定会话）',
    group: '会话',
    handler: async (args, ctx) => {
      const sessionId = args.trim() || undefined

      // 无参数时先展示最近会话列表，然后恢复最近一次
      if (!sessionId) {
        const sessions = ctx.listRecentSessions(5)
        if (sessions.length === 0) return '没有可恢复的历史会话'

        const result = await ctx.restoreSession()
        const list = sessions
          .map((s, i) => {
            const time = new Date(s.startTime).toLocaleString()
            const marker = i === 0 ? ' ← 已恢复' : ''
            return `  ${i + 1}. [${s.id.slice(0, 8)}] ${time} | ${s.messageCount} 条消息 | $${s.cost.toFixed(4)}${marker}`
          })
          .join('\n')
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
    group: '会话',
    handler: async (_args, ctx) => {
      ctx.setSkipPlan(false)
      return '已切换到 Plan 模式（规划→审批→执行）'
    },
  },
  {
    name: 'auto',
    aliases: [],
    description: '切换到 Auto 模式（跳过规划，直接执行）',
    group: '会话',
    handler: async (_args, ctx) => {
      ctx.setSkipPlan(true)
      return '已切换到 Auto 模式（跳过规划，直接执行）'
    },
  },
  {
    name: 'eval',
    aliases: [],
    description: '运行评估任务（nexus eval <dir> 的 TUI 入口）',
    group: '工具',
    handler: async () => {
      return '请使用 CLI 命令: nexus eval <任务目录> [--mock] [--task <id>] [--json <file>]'
    },
  },
  {
    name: 'status',
    aliases: ['st'],
    description: '显示各子系统健康状态（DB/CodeGraph/MCP/Watcher）',
    group: '会话',
    handler: async (_args, ctx) => {
      const status = ctx.getStatus()
      const icon = (ok: boolean) => (ok ? '✅' : '❌')
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
    group: '会话',
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
    name: 'search',
    aliases: ['s'],
    description: '搜索历史会话消息（/search <关键词>）',
    group: '会话',
    handler: async (args, ctx) => {
      const query = args.trim()
      if (!query) {
        return '用法: /search <关键词>\n示例: /search 配置文件\n将搜索所有历史会话中的消息内容，返回匹配的会话和消息摘要。'
      }
      return ctx.searchSessions(query)
    },
  },
  {
    name: 'autofix',
    aliases: ['af'],
    description: '查看或设置自动修复模式（/autofix 查看，/autofix <0-3> 设置重试次数）',
    group: '循环',
    handler: async (args, ctx) => {
      const input = args.trim()
      if (!input) {
        const current = ctx.getAutoRetries()
        return current > 0
          ? `自动修复模式: 已开启（重试 ${current} 次）\n使用 /autofix 0 关闭，/autofix <1-3> 设置重试次数`
          : '自动修复模式: 已关闭\n使用 /autofix <1-3> 开启（设置重试次数）'
      }
      const retries = Number.parseInt(input, 10)
      if (Number.isNaN(retries) || retries < 0 || retries > 3) {
        return '无效参数。用法: /autofix <0|1|2|3>\n  0 = 关闭\n  1-3 = 开启并设置重试次数'
      }
      ctx.setAutoRetries(retries)
      return retries > 0
        ? `自动修复模式已开启，错误时将自动重试 ${retries} 次`
        : '自动修复模式已关闭'
    },
  },
  {
    name: 'errors',
    aliases: ['err'],
    description: '查看最近错误报告（/errors [数量]）',
    group: '会话',
    handler: async (args, ctx) => {
      const limit = args.trim() ? Number.parseInt(args.trim(), 10) || 10 : 10
      return ctx.getRecentErrors(limit)
    },
  },
  {
    name: 'plugins',
    aliases: ['plugin'],
    description: '查看已安装插件（.nexus/plugins/）',
    group: '工具',
    handler: async (_args, ctx) => {
      return ctx.listPlugins()
    },
  },
  {
    name: 'memory',
    aliases: ['mem'],
    description: '查看/管理学习记忆（/memory、/memory delete lesson <id>、/memory skills）',
    group: '工具',
    handler: async (args, ctx) => {
      const [sub, kind, idStr] = args.trim().split(/\s+/)
      if (sub === 'delete' && kind && idStr) {
        const id = /^\d+$/.test(idStr) ? Number(idStr) : idStr
        return ctx.deleteMemoryEntry(kind as 'lesson' | 'skill', id)
      }
      if (sub === 'skills') return ctx.listSkills()
      return ctx.listMemory()
    },
  },
  {
    name: 'goal',
    aliases: [],
    description:
      '目标驱动循环：重复执行直到验收条件满足（/goal <目标> [--max-rounds N] [--max-cost $]，如 /goal "让所有测试通过"）',
    group: '循环',
    handler: async (args, ctx) => {
      const { prompt, maxRounds, maxCost } = parseGoalArgs(args)
      if (!prompt) {
        return '用法: /goal <目标> [--max-rounds N] [--max-cost $]\n示例: /goal "让所有测试通过" --max-rounds 3'
      }
      if (!ctx.runGoal) return '目标驱动循环不可用（当前上下文未注入 runGoal）'
      const result = await ctx.runGoal(prompt, { maxRounds, maxCost })
      const totalCost = result.roundSummaries.reduce((sum, r) => sum + r.cost, 0)
      const lines: string[] = [
        result.achieved
          ? `目标已达成（第 ${result.rounds} 轮）`
          : `目标未达成（已尝试 ${result.rounds} 轮）`,
        `  总成本: $${totalCost.toFixed(4)}`,
      ]
      for (const r of result.roundSummaries) {
        lines.push(
          `  第 ${r.round} 轮: 证据 ${r.evidencePassed === null ? '未运行' : r.evidencePassed ? '通过' : '失败'} / 验证 ${r.verifyPass === null ? '未运行' : r.verifyPass ? '通过' : '失败'} / $${r.cost.toFixed(4)}`,
        )
      }
      if (!result.achieved) {
        lines.push(
          '提示: 目标未达成可能因轮次/成本预算不足，可增加 --max-rounds 或 --max-cost 后重试',
        )
      }
      return lines.join('\n')
    },
  },
  {
    name: 'loop',
    aliases: [],
    description:
      '节拍循环：按间隔重复执行任务，状态持久化到 .nexus/loop-state.md（/loop <任务> [--interval 10m] [--max-rounds N] [--max-cost $]）',
    group: '循环',
    handler: async (args, ctx) => {
      const { prompt, intervalMin, maxRounds, maxCost } = parseLoopArgs(args)
      if (!prompt) {
        return '用法: /loop <任务> [--interval 10m] [--max-rounds N] [--max-cost $]\n示例: /loop "检查依赖更新" --interval 10m --max-rounds 3'
      }
      if (!ctx.runLoop) return '节拍循环不可用（当前上下文未注入 runLoop）'
      return await ctx.runLoop(prompt, { intervalMin, maxRounds, maxCost })
    },
  },
  {
    name: 'loops',
    aliases: [],
    description:
      '本地 Automations：查看/管理 loops.toml 定时循环（/loops、/loops run-now <name>、/loops enable|disable <name>、/loops inbox）',
    group: '循环',
    handler: async (args, ctx) => {
      if (!ctx.listLoops) return '本地 Automations 不可用（当前上下文未注入）'
      const [sub, name] = args.trim().split(/\s+/)

      if (sub === 'run-now' && name && ctx.runLoopNow) {
        const result = await ctx.runLoopNow(name)
        return result ?? `未知 loop: ${name}`
      }
      if ((sub === 'enable' || sub === 'disable') && name && ctx.setLoopEnabled) {
        await ctx.setLoopEnabled(name, sub === 'enable')
        return `[loops.${name}] 已${sub === 'enable' ? '启用' : '禁用'}`
      }
      if (sub === 'inbox' && ctx.getLoopInbox) {
        return ctx.getLoopInbox(name)
      }

      // 默认：列表
      const loops = ctx.listLoops()
      if (loops.length === 0) {
        return '未配置本地 Automations（.nexus/loops.toml 为空或不存在）\n\n用法: /loops run-now <name> | enable|disable <name> | inbox'
      }
      const lines = ['本地 Automations:']
      for (const l of loops) {
        const status = l.running
          ? '运行中'
          : l.pausedReason
            ? `暂停（${l.pausedReason}）`
            : l.enabled
              ? '启用'
              : '禁用'
        lines.push(
          `  [loops.${l.name}] ${status} / 间隔 ${l.scheduleMin}m` +
            ` / 下次: ${l.nextRunAt ? new Date(l.nextRunAt).toLocaleTimeString() : '—'}` +
            ` / 上次: ${l.lastRunAt ? new Date(l.lastRunAt).toLocaleString() : '从未'}`,
        )
        if (l.lastResultSummary) {
          const s =
            l.lastResultSummary.length > 80
              ? `${l.lastResultSummary.slice(0, 80)}…`
              : l.lastResultSummary
          lines.push(`    ${s}`)
        }
      }
      lines.push('\n用法: /loops run-now <name> | enable|disable <name> | inbox [name]')
      return lines.join('\n')
    },
  },
  {
    name: 'help',
    aliases: ['?'],
    description: '显示可用命令及其说明',
    group: '系统',
    handler: async () => {
      // 按分组渲染（每类一行，常用命令置顶），提升可发现性
      const order: Array<SlashCommand['group']> = ['模型', '会话', '循环', '工具', '系统']
      const sections: string[] = []
      for (const g of order) {
        const groupCmds = commands.filter((c) => (c.group ?? '系统') === g)
        if (groupCmds.length === 0) continue
        const lines = groupCmds.map((cmd) => {
          const aliasStr = cmd.aliases.length > 0 ? ` (别名: ${cmd.aliases.join(', ')})` : ''
          return `  /${cmd.name}${aliasStr} — ${cmd.description}`
        })
        sections.push(`[${g}]\n${lines.join('\n')}`)
      }
      return sections.join('\n\n')
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

export async function handleSlashCommand(
  input: string,
  ctx: CommandContext,
): Promise<string | null> {
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

/** 解析 /goal 参数：目标文本 + --max-rounds N + --max-cost $（--flag value 形式） */
function parseGoalArgs(args: string): {
  prompt: string
  maxRounds?: number
  maxCost?: number
} {
  const parts = args.trim().split(/\s+/)
  const flags: Record<string, string> = {}
  const words: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (p.startsWith('--')) {
      const value = parts[++i]
      if (value) flags[p.slice(2)] = value
    } else {
      words.push(p)
    }
  }
  const maxRounds = flags['max-rounds'] ? Number.parseInt(flags['max-rounds'], 10) : undefined
  const maxCost = flags['max-cost'] ? Number.parseFloat(flags['max-cost']) : undefined
  return {
    prompt: words.join(' '),
    maxRounds: maxRounds && !Number.isNaN(maxRounds) ? maxRounds : undefined,
    maxCost: maxCost && !Number.isNaN(maxCost) ? maxCost : undefined,
  }
}

/** 解析 /loop 参数：任务文本 + --interval <n>m|h + --max-rounds N + --max-cost $ */
function parseLoopArgs(args: string): {
  prompt: string
  intervalMin?: number
  maxRounds?: number
  maxCost?: number
} {
  const parsed = parseGoalArgs(args)
  const parts = args.trim().split(/\s+/)
  let intervalMin: number | undefined
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '--interval') {
      const v = parts[++i]
      if (v) {
        const m = v.match(/^(\d+)(m|h)$/)
        if (m) {
          intervalMin = Number.parseInt(m[1], 10) * (m[2] === 'h' ? 60 : 1)
        }
      }
    }
  }
  return {
    prompt: parsed.prompt,
    intervalMin,
    maxRounds: parsed.maxRounds,
    maxCost: parsed.maxCost,
  }
}

/**
 * 获取以指定前缀开头的命令名列表（用于自动补全）
 */
export function getCommandCompletions(prefix: string): string[] {
  const p = prefix.startsWith('/') ? prefix.slice(1) : prefix
  return commands.filter((c) => c.name.startsWith(p)).map((c) => `/${c.name}`)
}

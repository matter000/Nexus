/**
 * 子智能体引擎定义与注册表
 *
 * 多引擎协作的基础设施：
 * - 内置默认引擎（explorer/coder/reviewer/researcher），代码内定义
 * - 用户可通过 .nexus/agents.toml 覆盖内置引擎或新增自定义引擎（见 agentsConfig.ts）
 * - 引擎负责：角色提示词（systemPrompt）、工具白名单、默认写权限、迭代上限、可选模型
 *
 * 协作拓扑（由主 Agent 按任务性质动态选择）：
 * - Supervisor: dispatch_agent（单引擎调度）
 * - Fan-out:    dispatch_agents（多引擎并行）
 * - Pipeline:   run_pipeline（引擎链式传递，前序输出作为后序输入）
 */

export interface AgentEngineDef {
  /** 引擎名（如 explorer），供 LLM 路由选择 */
  name: string
  /** 给 LLM 的路由描述（决定何时选择该引擎） */
  description: string
  /** 角色提示词（注入子 Agent 首条消息） */
  systemPrompt: string
  /** 可选：指定模型名，缺省用 executor 模型 */
  model?: string
  /** 工具白名单；缺省按 writable 自动选择 */
  tools?: string[]
  /** 默认写权限 */
  writable?: boolean
  /** 默认迭代上限（缺省用 config.limits.maxIterations） */
  maxIterations?: number
  /** 是否需要审批（预留字段；当前审批由工具级控制：dispatch_agent/run_pipeline 统一要求审批） */
  requiresApproval?: boolean
  /** 自动审查闭环：写任务成功且有变更时自动派 reviewer 审查，高危问题回传修复一轮（coder 默认开启） */
  autoReview?: boolean
}

/** 内置默认引擎（用户可通过 agents.toml 覆盖或扩展） */
export const BUILTIN_ENGINES: AgentEngineDef[] = [
  {
    name: 'explorer',
    description: '只读探索代码库：搜索符号、阅读文件、理解模块结构与依赖关系，回答结构性问题',
    systemPrompt:
      '你是代码探索引擎，只读分析代码库。你的任务：快速定位相关代码、理清模块边界与依赖关系、给出准确结论。不得修改任何文件。输出结构化结论，附关键文件路径与行号。',
    tools: ['read_file', 'grep', 'glob', 'list_directory', 'search_symbol', 'semantic_search'],
    writable: false,
    maxIterations: 8,
  },
  {
    name: 'coder',
    description: '可写编码引擎：实现功能、修复缺陷、批量修改文件，写操作受权限控制',
    systemPrompt:
      '你是编码引擎，负责实现代码变更。遵循项目既有风格与模块边界，变更后说明修改了哪些文件及理由。所有写操作均受权限控制。',
    tools: [
      'read_file',
      'edit_file',
      'create_file',
      'bash',
      'grep',
      'glob',
      'list_directory',
      'search_symbol',
      'git_status',
      'git_commit',
      'git_push',
      'update_todo',
    ],
    writable: true,
    maxIterations: 12,
    requiresApproval: true,
    autoReview: true,
  },
  {
    name: 'reviewer',
    description: '只读审查引擎：检查代码质量、潜在缺陷、边界条件与安全性，输出结构化审查报告',
    systemPrompt:
      '你是代码审查引擎，只读审查代码。检查：逻辑缺陷、边界条件、错误处理、安全隐患、风格一致性。输出按严重程度分级的审查报告（高/中/低），每条附文件路径与行号。',
    tools: ['read_file', 'grep', 'glob', 'list_directory', 'search_symbol', 'semantic_search'],
    writable: false,
    maxIterations: 10,
  },
  {
    name: 'researcher',
    description: '调研引擎：联网搜索资料、抓取网页内容，结合本地代码产出调研结论',
    systemPrompt:
      '你是调研引擎，负责收集与分析信息。可联网搜索与抓取网页，也可阅读本地文件。输出带来源引用的调研结论，区分事实与推断。',
    tools: ['web_search', 'fetch_url', 'read_file', 'grep', 'glob', 'list_directory'],
    writable: false,
    maxIterations: 8,
  },
]

/** 子智能体引擎注册表：内置引擎 + 用户配置合并 */
export class AgentEngineRegistry {
  private engines = new Map<string, AgentEngineDef>()

  constructor() {
    for (const def of BUILTIN_ENGINES) this.register(def)
  }

  /** 注册（或覆盖同名）引擎定义 */
  register(def: AgentEngineDef): void {
    this.engines.set(def.name, def)
  }

  get(name: string): AgentEngineDef | undefined {
    return this.engines.get(name)
  }

  has(name: string): boolean {
    return this.engines.has(name)
  }

  getAll(): AgentEngineDef[] {
    return Array.from(this.engines.values())
  }

  /** 全部引擎名（供 dispatch_agent 路由提示） */
  getNames(): string[] {
    return this.getAll().map((e) => e.name)
  }

  /**
   * 合并用户配置：同名引擎字段级覆盖（缺省字段沿用内置值），新名直接新增。
   * 返回告警列表（配置问题仅告警不阻塞，沿用 config.ts 风格）。
   */
  mergeUserConfig(configs: AgentEngineDef[], knownToolNames?: Set<string>): string[] {
    const warnings: string[] = []
    for (const def of configs) {
      if (knownToolNames && def.tools && def.tools.length > 0) {
        for (const tool of def.tools) {
          if (!knownToolNames.has(tool)) {
            warnings.push(`[Agents] 引擎 "${def.name}" 引用了未知工具 "${tool}"，该工具将不可用`)
          }
        }
      }
      const existing = this.engines.get(def.name)
      this.register(existing ? this.mergeDefs(existing, def) : def)
    }
    return warnings
  }

  /** 字段级合并：override 中非 undefined 字段覆盖 base，其余沿用 base */
  private mergeDefs(base: AgentEngineDef, override: AgentEngineDef): AgentEngineDef {
    const merged = { ...base }
    for (const [key, value] of Object.entries(override)) {
      if (value !== undefined) {
        ;(merged as Record<string, unknown>)[key] = value
      }
    }
    return merged
  }
}

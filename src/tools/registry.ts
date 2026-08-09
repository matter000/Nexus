/**
 * MCP 工具注册中心
 * 管理所有内置工具的注册、查找和调用
 */

import { spawn } from 'child_process'
import { AgentEngineRegistry, BUILTIN_ENGINES } from '../agent/AgentEngine'
import { PipelineRunner } from '../agent/PipelineRunner'
import { dispatchSubagentToolDefinition } from '../agent/SubAgent'
import type {
  SubAgentResult,
  SubAgentTask,
  Todo,
  ToolDefinition,
  ToolHooks,
  ToolResult,
} from '../agent/types'
import { getSemanticSearchEngine, semanticSearchToolDefinition } from '../context/SemanticSearch'
import type { WorktreeManager } from '../sandbox/WorktreeManager'
import { isInsideProject } from '../utils'
import { isPrivateUrl } from '../utils/ssrf'
import { bashTool } from './bash'
import { createFileTool } from './createFile'
import { editFileTool } from './editFile'
import { fetchUrlTool } from './fetchUrl'
import { gitCommitTool, gitPushTool, gitStatusTool } from './git'
import { globTool } from './glob'
import { grepTool } from './grep'
import { listDirectoryTool } from './listDirectory'
import { lspTool } from './lsp'
import { updateNotesTool } from './notes'
import { readFileTool } from './readFile'
import { toolSchemas } from './schemas'
import { searchSymbolTool } from './searchSymbol'
import { submitPlanTool } from './submitPlan'
import { updateTodoTool } from './todo'
import { webSearchTool } from './webSearch'

/** SubAgent 运行器接口(解耦循环依赖) */
export interface SubAgentRunner {
  run(task: SubAgentTask): Promise<SubAgentResult>
  /** 引擎注册表（dispatch_agent/run_pipeline 校验引擎名并构造 PipelineRunner） */
  getEngineRegistry?(): AgentEngineRegistry | undefined
}

/** 技能读取器接口（load_skill 工具用，解耦 tools → agent 依赖） */
export interface SkillReader {
  /** L1：active 技能元数据（系统提示注入用） */
  listActiveSkillMeta(): Array<{ name: string; description: string; hasResources: boolean }>
  /** L2：按需加载技能正文（含资源文件清单） */
  readSkillBody(name: string): string | null
}

/** 并行子任务定义（dispatch_subagents / dispatch_agents 共用） */
interface TaskDef {
  description: string
  writable?: boolean
  tools?: string[]
  engine?: string
  /** worktree 隔离：写任务在独立 git worktree 中执行，可与其他写任务并行 */
  isolation?: 'worktree'
}

/** worktree 隔离写任务的待合并条目 */
interface PendingMerge {
  description: string
  taskId: string
  branch: string
  diffSummary: string
}

/** 信箱消息格式化（与 Mailbox.formatMessages 同构，避免工具层对 agent 层的值依赖） */
function formatMailMessages(messages: Array<{ from: string; content: string }>): string {
  return messages.map((m) => `[来自 ${m.from}] ${m.content}`).join('\n')
}

/** 共享任务板结构化接口（agent 层 TaskBoard 天然满足，避免 tools → agent 层级越界） */
export interface TaskBoardProvider {
  format(): string
  claim(agentId: string, taskId?: string): { id: string; content: string } | null
}

/** 信箱结构化接口（agent 层 Mailbox 天然满足） */
export interface MailboxProvider {
  send(from: string, to: string, content: string): void
  readUnread(agentId: string): Array<{ from: string; content: string }>
}

/**
 * 并行/串行执行多个子任务定义：
 * - 只读任务与 worktree 隔离写任务并行（总并发上限 3，业界首选的并行写方案）
 * - 未隔离的写任务串行（互斥，防同工作区踩脚）
 * - 隔离写任务完成后统一审批合并（人在环中），冲突保留现场待人工处理
 * 用 allSettled 而非 all：单个子任务 throw 时，其他已完成的结果不丢失。
 */
async function runParallelTasks(
  taskDefs: TaskDef[],
  runner: SubAgentRunner,
  toolName: string,
  callId: string,
  registry: ToolRegistry,
): Promise<ToolResult> {
  const worktreeManager = registry.getWorktreeManager()

  // 分离：只读 / worktree 隔离写 / 普通写
  const readTasks = taskDefs.filter((t) => !t.writable)
  const isolatedWriteTasks = taskDefs.filter(
    (t) => t.writable && t.isolation === 'worktree' && worktreeManager !== null,
  )
  // 指定了 isolation 但 worktree 不可用（非 git 仓库）：保守回退串行
  const writeTasks = taskDefs.filter(
    (t) => t.writable && !(t.isolation === 'worktree' && worktreeManager !== null),
  )

  const results: Array<{
    description: string
    success: boolean
    summary: string
    error?: string
  }> = []
  const pendingMerges: PendingMerge[] = []

  const buildTask = (t: TaskDef): SubAgentTask => ({
    id: `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    description: t.description,
    writable: t.writable ?? false,
    tools: t.tools ?? [],
    maxIterations: 10,
    ...(t.engine ? { engine: t.engine } : {}),
    ...(t.isolation && t.writable ? { isolation: t.isolation } : {}),
  })

  // 只读 + 隔离写任务并行（总并发上限 3；隔离写在独立 worktree 中互不干扰）
  const PARALLEL_LIMIT = 3
  const parallelTasks = [...readTasks, ...isolatedWriteTasks]
  for (let i = 0; i < parallelTasks.length; i += PARALLEL_LIMIT) {
    const batch = parallelTasks.slice(i, i + PARALLEL_LIMIT)
    const settled = await Promise.allSettled(batch.map((t) => runner.run(buildTask(t))))
    for (let j = 0; j < settled.length; j++) {
      const s = settled[j]
      if (s.status === 'fulfilled') {
        results.push({
          description: batch[j].description,
          success: s.value.success,
          summary: s.value.summary,
          error: s.value.error,
        })
        // worktree 隔离写成功且有变更：登记待合并分支
        if (s.value.worktreeBranch && s.value.success) {
          pendingMerges.push({
            description: batch[j].description,
            taskId: s.value.id,
            branch: s.value.worktreeBranch,
            diffSummary: s.value.diffSummary ?? '',
          })
        }
      } else {
        // rejected：子任务内部未捕获的 crash，记录为失败而非让整批丢失
        results.push({
          description: batch[j].description,
          success: false,
          summary: '',
          error: s.reason instanceof Error ? s.reason.message : String(s.reason),
        })
      }
    }
  }

  // 未隔离写任务串行执行（互斥）
  for (const t of writeTasks) {
    const result = await runner.run(buildTask(t))
    results.push({
      description: t.description,
      success: result.success,
      summary: result.summary,
      error: result.error,
    })
  }

  // ─── worktree 合并审批（人在环中：合并前必须经用户确认） ───
  if (pendingMerges.length > 0 && worktreeManager) {
    const combinedDiff = pendingMerges
      .map((m) => `### 任务: ${m.description}\n分支: ${m.branch}\n${m.diffSummary}`)
      .join('\n\n')
    const approved = await registry.requestMergeApproval(combinedDiff, pendingMerges.length)
    if (approved) {
      for (const m of pendingMerges) {
        const mergeResult = await worktreeManager.merge(m.taskId)
        if (mergeResult.success) {
          await worktreeManager.remove(m.taskId)
          results.push({
            description: `[合并] ${m.description}`,
            success: true,
            summary: mergeResult.message,
          })
        } else {
          results.push({
            description: `[合并] ${m.description}`,
            success: false,
            summary: '',
            error: mergeResult.message,
          })
        }
      }
    } else {
      // 拒绝合并：保留 worktree 分支，告知 LLM 由用户后续处理
      results.push({
        description: '[合并] 用户拒绝了 worktree 合并',
        success: false,
        summary: '',
        error: `用户拒绝合并 ${pendingMerges.length} 个 worktree 分支（${pendingMerges.map((m) => m.branch).join(', ')}）。变更保留在分支上，不要重试合并，告知用户可自行 git merge`,
      })
    }
  }

  // 汇总结果
  const succeeded = results.filter((r) => r.success)
  const failed = results.filter((r) => !r.success)
  const summaryParts = results.map(
    (r, i) => `${r.success ? '✅' : '❌'} 任务${i + 1} [${r.description}]: ${r.summary || r.error}`,
  )

  return {
    callId,
    tool: toolName,
    result: `并行子任务完成: ${succeeded.length} 成功, ${failed.length} 失败\n${summaryParts.join('\n')}`,
  }
}

export interface ToolHandler {
  definition: ToolDefinition
  execute: (params: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>
}

export interface ToolContext {
  projectRoot: string
  callId: string
  maxReadLines: number
  maxOutputBytes: number
  bashTimeout: number
  /** 当前 TODO 列表引用（工具可直接读写，如 update_todo） */
  todos: Todo[]
}

class ToolRegistry {
  private tools = new Map<string, ToolHandler>()
  private subAgentRunner: SubAgentRunner | null = null
  /** 工具钩子（pre/post），由 Orchestrator 从 config.toml 注入 */
  private hooks: ToolHooks | null = null

  /** 注入 SubAgent 运行器实例(由 Orchestrator 在初始化时调用) */
  setSubAgentRunner(runner: SubAgentRunner): void {
    this.subAgentRunner = runner
  }

  /** 注入工具钩子配置（由 Orchestrator 在初始化时调用） */
  setHooks(hooks: ToolHooks | undefined): void {
    this.hooks = hooks ?? null
  }

  /** 技能读取器（load_skill 工具运行时依赖，由 Orchestrator 注入） */
  private skillReader: SkillReader | null = null

  /** 注入技能读取器（由 Orchestrator 在学习系统初始化后调用） */
  setSkillReader(reader: SkillReader | null): void {
    this.skillReader = reader
  }

  /** 获取技能读取器 */
  getSkillReader(): SkillReader | null {
    return this.skillReader
  }

  /** worktree 管理器（并行写隔离用，由 Orchestrator 注入；缺省不支持隔离） */
  private worktreeManager: WorktreeManager | null = null

  setWorktreeManager(manager: WorktreeManager | null): void {
    this.worktreeManager = manager
  }

  getWorktreeManager(): WorktreeManager | null {
    return this.worktreeManager
  }

  /** worktree 合并审批回调（由 Orchestrator 注入，接入 TUI 审批面板） */
  private mergeApprovalHandler:
    | ((diffSummary: string, branchCount: number) => Promise<boolean>)
    | null = null

  setMergeApprovalHandler(
    handler: (diffSummary: string, branchCount: number) => Promise<boolean>,
  ): void {
    this.mergeApprovalHandler = handler
  }

  /** 请求合并审批；未注入审批器时保守拒绝（人在环中底线） */
  async requestMergeApproval(diffSummary: string, branchCount: number): Promise<boolean> {
    if (!this.mergeApprovalHandler) return false
    return this.mergeApprovalHandler(diffSummary, branchCount)
  }

  /** 共享任务板（team_task_* 工具用，由 Orchestrator 注入） */
  private taskBoard: TaskBoardProvider | null = null

  setTaskBoard(board: TaskBoardProvider | null): void {
    this.taskBoard = board
  }

  getTaskBoard(): TaskBoardProvider | null {
    return this.taskBoard
  }

  /** 引擎间信箱（send_message/read_messages 工具用，由 Orchestrator 注入） */
  private mailbox: MailboxProvider | null = null

  setMailbox(mailbox: MailboxProvider | null): void {
    this.mailbox = mailbox
  }

  getMailbox(): MailboxProvider | null {
    return this.mailbox
  }

  register(handler: ToolHandler): void {
    this.tools.set(handler.definition.name, handler)
  }

  get(name: string): ToolHandler | undefined {
    return this.tools.get(name)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  getAll(): ToolHandler[] {
    return Array.from(this.tools.values())
  }

  /** 获取指定阶段可用的工具 */
  getForPhase(phase: 'plan' | 'execute'): ToolHandler[] {
    return this.getAll().filter(
      (t) => t.definition.phase === phase || t.definition.phase === 'both',
    )
  }

  /** 获取需要审批的工具名列表 */
  getApprovalRequired(): string[] {
    return this.getAll()
      .filter((t) => t.definition.requiresApproval)
      .map((t) => t.definition.name)
  }

  /** 生成 Vercel AI SDK 兼容的工具定义 */
  toAISDKTools(
    phase: 'plan' | 'execute',
  ): Record<string, { description: string; parameters: unknown }> {
    const tools: Record<string, { description: string; parameters: unknown }> = {}
    for (const handler of this.getForPhase(phase)) {
      tools[handler.definition.name] = {
        description: handler.definition.description,
        parameters: handler.definition.inputSchema,
      }
    }
    return tools
  }

  /** 获取 SubAgent 运行器 */
  getSubAgentRunner(): SubAgentRunner | null {
    return this.subAgentRunner
  }

  /** 执行工具调用 */
  async execute(
    name: string,
    params: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const handler = this.get(name)
    if (!handler) {
      return {
        callId: context.callId,
        tool: name,
        result: '',
        error: `未知工具: ${name}`,
      }
    }

    // Zod 运行时参数校验: schema 存在时校验,不存在则跳过
    const schema = toolSchemas[name]
    if (schema) {
      const parseResult = schema.safeParse(params)
      if (!parseResult.success) {
        return {
          callId: context.callId,
          tool: name,
          result: '',
          error: `参数校验失败: ${parseResult.error.message}`,
        }
      }
      params = parseResult.data as Record<string, unknown>
    }

    // ─── 自动安全检查：路径 / URL / 命令 ──────────────────────────────
    // 所有工具无需各自实现，由注册中心统一检查

    // 路径遍历检查
    if (typeof params.path === 'string') {
      if (!isInsideProject(context.projectRoot, params.path)) {
        return {
          callId: context.callId,
          tool: name,
          result: '',
          error: `路径越界: ${params.path} 不在项目目录内`,
        }
      }
    }

    // SSRF 防护（URL 参数检查）：复用公共 isPrivateUrl，与 fetch_url 工具防护范围一致
    if (typeof params.url === 'string' && isPrivateUrl(params.url)) {
      return {
        callId: context.callId,
        tool: name,
        result: '',
        error: `出于安全原因，不允许访问内网或私有地址: ${params.url}`,
      }
    }

    // ─── pre_tool 钩子：退出码非 0 拦截工具（CI/自动化自定义护栏） ──────
    if (this.hooks?.preTool) {
      const hookResult = await runHookCommand(this.hooks.preTool, {
        NEXUS_TOOL_NAME: name,
        NEXUS_TOOL_ARGS: safeJsonStringify(params),
        NEXUS_PROJECT_ROOT: context.projectRoot,
      })
      if (hookResult.exitCode !== 0) {
        return {
          callId: context.callId,
          tool: name,
          result: '',
          error: `被 pre_tool 钩子拦截: ${hookResult.stderr || `exit ${hookResult.exitCode}`}`,
        }
      }
    }

    const result = await handler.execute(params, context)

    // ─── post_tool 钩子：仅通知，失败无副作用 ───────────────────────
    if (this.hooks?.postTool) {
      await runHookCommand(this.hooks.postTool, {
        NEXUS_TOOL_NAME: name,
        NEXUS_TOOL_ARGS: safeJsonStringify(params),
        NEXUS_PROJECT_ROOT: context.projectRoot,
        NEXUS_TOOL_OK: String(!result.error),
        NEXUS_TOOL_RESULT: (result.error ?? result.result ?? '').slice(0, 2000),
      }).catch(() => {})
    }

    return result
  }
}

/** JSON 序列化容错（参数含循环引用时退化为空对象） */
function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return '{}'
  }
}

/** 执行钩子命令（bash -c + 环境变量传参，10s 超时强杀） */
function runHookCommand(
  command: string,
  env: Record<string, string>,
): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
      ...(process.platform === 'win32' ? { windowsHide: true } : {}),
    })
    let stderr = ''
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    child.on('close', (code) =>
      resolve({ exitCode: code ?? 1, stderr: stderr.trim().slice(0, 500) }),
    )
    child.on('error', (err) => resolve({ exitCode: 1, stderr: err.message }))
  })
}

/** 创建并初始化默认工具注册表 */
export function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(readFileTool)
  registry.register(editFileTool)
  registry.register(bashTool)
  registry.register(grepTool)
  registry.register(globTool)
  registry.register(updateTodoTool)
  registry.register(updateNotesTool)
  registry.register(submitPlanTool)
  registry.register(listDirectoryTool)
  registry.register(searchSymbolTool)
  registry.register(lspTool)
  registry.register(fetchUrlTool)
  registry.register(createFileTool)
  registry.register(gitStatusTool)
  registry.register(gitCommitTool)
  registry.register(gitPushTool)
  registry.register(webSearchTool)
  // 注册语义搜索工具 (异步加载模型,首次 search 时建立索引)
  registry.register({
    definition: {
      name: semanticSearchToolDefinition.name,
      description: semanticSearchToolDefinition.description,
      inputSchema: semanticSearchToolDefinition.inputSchema,
      requiresApproval: semanticSearchToolDefinition.requiresApproval,
      phase: semanticSearchToolDefinition.phase,
    },
    execute: async (params, context) => {
      const engine = getSemanticSearchEngine(context.projectRoot)
      const query = params.query as string
      const topK = (params.top_k as number) ?? 5
      try {
        const results = await engine.search(query, topK)
        if (results.length === 0) {
          return {
            callId: context.callId,
            tool: 'semantic_search',
            result: `未找到与 "${query}" 相关的代码块`,
          }
        }
        const formatted = results
          .map(
            (r, i) =>
              `### [${i + 1}] ${r.filePath}:${r.startLine}-${r.endLine} (score: ${r.score.toFixed(3)})\n\`\`\`\n${r.content.slice(0, 500)}\n\`\`\``,
          )
          .join('\n\n')
        return {
          callId: context.callId,
          tool: 'semantic_search',
          result: `找到 ${results.length} 个相关代码块:\n\n${formatted}`,
        }
      } catch (err) {
        return {
          callId: context.callId,
          tool: 'semantic_search',
          result: '',
          error: `语义搜索失败: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
    },
  })

  // 注册 load_skill 工具（Agent Skills 渐进式披露 L2：元数据在系统提示，正文按需加载）
  registry.register({
    definition: {
      name: 'load_skill',
      description:
        '加载指定技能的完整指令（渐进式披露）。系统提示的“可用技能”一节列出了技能名与适用场景；当当前任务与某技能匹配时，调用本工具获取完整步骤。技能目录式资源文件可按其清单用 read_file 进一步读取。',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '技能名（系统提示“可用技能”中列出的 name）',
          },
        },
        required: ['name'],
      },
      requiresApproval: false,
      phase: 'both',
    },
    execute: async (params: Record<string, unknown>, context: ToolContext) => {
      const reader = registry.getSkillReader()
      if (!reader) {
        return {
          callId: context.callId,
          tool: 'load_skill',
          result: '',
          error: '技能库未初始化',
        }
      }
      const name = params.name as string
      const body = reader.readSkillBody(name)
      if (body === null) {
        const available = reader
          .listActiveSkillMeta()
          .map((s) => s.name)
          .join(', ')
        return {
          callId: context.callId,
          tool: 'load_skill',
          result: '',
          error: `技能 "${name}" 不存在或未激活。可用技能: ${available || '(无)'}`,
        }
      }
      return { callId: context.callId, tool: 'load_skill', result: body }
    },
  })

  // ─── 多智能体协作工具（共享任务板 + Mailbox，Agent Teams 风格） ───
  registry.register({
    definition: {
      name: 'team_task_list',
      description:
        '查看共享任务板的全部任务及状态（待认领/已认领/已完成）。多智能体协作时用于了解全局分工，避免重复认领。',
      inputSchema: { type: 'object', properties: {}, required: [] },
      requiresApproval: false,
      phase: 'both',
    },
    execute: async (_params: Record<string, unknown>, context: ToolContext) => {
      const board = registry.getTaskBoard()
      if (!board) {
        return {
          callId: context.callId,
          tool: 'team_task_list',
          result: '',
          error: '任务板未初始化',
        }
      }
      return { callId: context.callId, tool: 'team_task_list', result: board.format() }
    },
  })

  registry.register({
    definition: {
      name: 'team_task_claim',
      description:
        '从共享任务板认领一条待认领任务（先到先得，不会双重认领）。缺省 task_id 时认领第一条待认领任务。认领后应完成任务并通过 update_todo 同步状态。',
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: {
            type: 'string',
            description: '认领者 ID（主 Agent 用 lead；子 Agent 用任务提示中告知的自身 ID）',
          },
          task_id: {
            type: 'string',
            description: '指定认领的任务 ID（可选，缺省认领第一条待认领任务）',
          },
        },
        required: ['agent_id'],
      },
      requiresApproval: false,
      phase: 'both',
    },
    execute: async (params: Record<string, unknown>, context: ToolContext) => {
      const board = registry.getTaskBoard()
      if (!board) {
        return {
          callId: context.callId,
          tool: 'team_task_claim',
          result: '',
          error: '任务板未初始化',
        }
      }
      const agentId = params.agent_id as string
      const taskId = params.task_id as string | undefined
      const claimed = board.claim(agentId, taskId)
      if (!claimed) {
        return {
          callId: context.callId,
          tool: 'team_task_claim',
          result: '',
          error: taskId
            ? `任务 #${taskId} 不存在或已被认领。用 team_task_list 查看当前状态`
            : '没有待认领的任务',
        }
      }
      return {
        callId: context.callId,
        tool: 'team_task_claim',
        result: `已认领任务 #${claimed.id}: ${claimed.content}`,
      }
    },
  })

  registry.register({
    definition: {
      name: 'send_message',
      description:
        '向其他 agent 的信箱发送消息（多智能体协作）。用于告知任务依赖、请求协助或同步发现。主 Agent ID 为 lead；子 Agent ID 见其任务提示。',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: '发送者 ID（主 Agent 用 lead）' },
          to: { type: 'string', description: '接收者 agent ID' },
          content: { type: 'string', description: '消息内容（简洁说明意图与必要上下文）' },
        },
        required: ['from', 'to', 'content'],
      },
      requiresApproval: false,
      phase: 'both',
    },
    execute: async (params: Record<string, unknown>, context: ToolContext) => {
      const mailbox = registry.getMailbox()
      if (!mailbox) {
        return { callId: context.callId, tool: 'send_message', result: '', error: '信箱未初始化' }
      }
      mailbox.send(params.from as string, params.to as string, params.content as string)
      return {
        callId: context.callId,
        tool: 'send_message',
        result: `消息已投递给 ${params.to}`,
      }
    },
  })

  registry.register({
    definition: {
      name: 'read_messages',
      description:
        '读取指定 agent 信箱的未读消息（子 Agent 每轮会自动轮询，本工具主要供主 Agent 查看子 Agent 的来信）。',
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: '要读取信箱的 agent ID（主 Agent 用 lead）' },
        },
        required: ['agent_id'],
      },
      requiresApproval: false,
      phase: 'both',
    },
    execute: async (params: Record<string, unknown>, context: ToolContext) => {
      const mailbox = registry.getMailbox()
      if (!mailbox) {
        return { callId: context.callId, tool: 'read_messages', result: '', error: '信箱未初始化' }
      }
      const unread = mailbox.readUnread(params.agent_id as string)
      if (unread.length === 0) {
        return { callId: context.callId, tool: 'read_messages', result: '(无未读消息)' }
      }
      return {
        callId: context.callId,
        tool: 'read_messages',
        result: formatMailMessages(unread),
      }
    },
  })

  // 注册 dispatch_subagent 工具(运行时通过 setSubAgentRunner 注入实际执行器)
  registry.register({
    definition: dispatchSubagentToolDefinition,
    execute: async (params, context) => {
      const runner = registry.getSubAgentRunner()
      if (!runner) {
        return {
          callId: context.callId,
          tool: 'dispatch_subagent',
          result: '',
          error: 'SubAgent 未初始化,无法分派子任务',
        }
      }

      const task: SubAgentTask = {
        id: `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        description: params.description as string,
        writable: (params.writable as boolean) ?? false,
        tools: (params.tools as string[]) ?? [],
        maxIterations: 10,
        ...(params.isolation === 'worktree' ? { isolation: 'worktree' as const } : {}),
      }

      const result = await runner.run(task)

      if (!result.success) {
        return {
          callId: context.callId,
          tool: 'dispatch_subagent',
          result: '',
          error: result.error ?? '子 Agent 执行失败',
        }
      }

      const filesNote =
        result.filesChanged.length > 0 ? `\n\n修改的文件: ${result.filesChanged.join(', ')}` : ''

      return {
        callId: context.callId,
        tool: 'dispatch_subagent',
        result: `子任务完成: ${result.summary}${filesNote}`,
      }
    },
  })

  // 注册 dispatch_agent 工具（Supervisor 单引擎调度，按引擎名路由）
  registry.register({
    definition: {
      name: 'dispatch_agent',
      description: `分派一个专用子智能体引擎执行独立子任务。引擎有独立角色提示词、工具集与上下文窗口。可选引擎: ${BUILTIN_ENGINES.map((e) => e.name).join(', ')}（可通过 .nexus/agents.toml 自定义扩展）。适用于需要专业角色处理的任务（探索/编码/审查/调研等）。`,
      inputSchema: {
        type: 'object',
        properties: {
          engine: {
            type: 'string',
            description: '子智能体引擎名',
          },
          description: {
            type: 'string',
            description: '子任务的详细描述',
          },
          writable: {
            type: 'boolean',
            description: '是否允许修改文件（覆盖引擎默认值）',
          },
          tools: {
            type: 'array',
            description: '允许使用的工具列表（覆盖引擎默认值）',
            items: { type: 'string' },
          },
          input: {
            type: 'string',
            description: '可选的上游输入/上下文',
          },
        },
        required: ['engine', 'description'],
      },
      requiresApproval: true,
      phase: 'execute',
    },
    execute: async (params, context) => {
      const runner = registry.getSubAgentRunner()
      if (!runner) {
        return {
          callId: context.callId,
          tool: 'dispatch_agent',
          result: '',
          error: 'SubAgent 未初始化,无法分派子任务',
        }
      }

      const engine = params.engine as string
      const engineRegistry = runner.getEngineRegistry?.()
      if (engineRegistry && !engineRegistry.has(engine)) {
        return {
          callId: context.callId,
          tool: 'dispatch_agent',
          result: '',
          error: `未知引擎: ${engine}，可用引擎: ${engineRegistry.getNames().join(', ')}`,
        }
      }

      const task: SubAgentTask = {
        id: `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        description: params.description as string,
        tools: (params.tools as string[]) ?? [],
        maxIterations: 10,
        engine,
        ...(typeof params.writable === 'boolean' ? { writable: params.writable } : {}),
        ...(typeof params.input === 'string' ? { input: params.input } : {}),
      }

      const result = await runner.run(task)

      if (!result.success) {
        return {
          callId: context.callId,
          tool: 'dispatch_agent',
          result: '',
          error: result.error ?? '子 Agent 执行失败',
        }
      }

      const filesNote =
        result.filesChanged.length > 0 ? `\n\n修改的文件: ${result.filesChanged.join(', ')}` : ''

      return {
        callId: context.callId,
        tool: 'dispatch_agent',
        result: `子任务完成: ${result.summary}${filesNote}`,
      }
    },
  })

  // 注册 dispatch_subagents 并行子任务工具（最多 3 个并行）
  registry.register({
    definition: {
      name: 'dispatch_subagents',
      description:
        '并行分派多个独立子任务给子 Agent（最多 3 个并行）。仅适用于高价值、高度可并行的任务（如同时分析多个独立模块）；强依赖、需共享上下文的任务请用单循环。写任务默认串行；给写任务加 isolation:"worktree" 可在独立 git worktree 中并行执行（完成后需用户审批合并）。',
      inputSchema: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            description:
              '子任务数组。每个元素是 {description: string, writable?: boolean, tools?: string[], isolation?: "worktree"} 格式的对象',
            items: {
              type: 'object',
              description: '单个子任务: {description, writable?, tools?, isolation?}',
            },
          },
        },
        required: ['tasks'],
      },
      requiresApproval: false,
      phase: 'execute',
    },
    execute: async (params, context) => {
      const runner = registry.getSubAgentRunner()
      if (!runner) {
        return {
          callId: context.callId,
          tool: 'dispatch_subagents',
          result: '',
          error: 'SubAgent 未初始化，无法分派子任务',
        }
      }

      const taskDefs = params.tasks as TaskDef[]
      if (!Array.isArray(taskDefs) || taskDefs.length === 0) {
        return {
          callId: context.callId,
          tool: 'dispatch_subagents',
          result: '',
          error: '任务列表为空',
        }
      }

      return runParallelTasks(taskDefs, runner, 'dispatch_subagents', context.callId, registry)
    },
  })

  // 注册 dispatch_agents 工具（Fan-out 多引擎并行，最多 3 个并行）
  registry.register({
    definition: {
      name: 'dispatch_agents',
      description: `并行分派多个专用子智能体引擎执行独立子任务（最多 3 个并行）。仅适用于高价值、高度可并行的任务；强依赖任务请用 run_pipeline 或单循环。每个任务可指定不同引擎（如 ${BUILTIN_ENGINES.map((e) => e.name).join('/')}）。写任务默认串行；加 isolation:"worktree" 可在独立 git worktree 中并行写（完成后需用户审批合并）。`,
      inputSchema: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            description:
              '引擎任务数组。每个元素是 {engine: string, description: string, writable?: boolean, tools?: string[], isolation?: "worktree"} 格式的对象',
            items: {
              type: 'object',
              description: '单个引擎任务: {engine, description, writable?, tools?, isolation?}',
            },
          },
        },
        required: ['tasks'],
      },
      requiresApproval: false,
      phase: 'execute',
    },
    execute: async (params, context) => {
      const runner = registry.getSubAgentRunner()
      if (!runner) {
        return {
          callId: context.callId,
          tool: 'dispatch_agents',
          result: '',
          error: 'SubAgent 未初始化，无法分派子任务',
        }
      }

      const taskDefs = params.tasks as TaskDef[]
      if (!Array.isArray(taskDefs) || taskDefs.length === 0) {
        return {
          callId: context.callId,
          tool: 'dispatch_agents',
          result: '',
          error: '任务列表为空',
        }
      }

      // 引擎存在性由 SubAgent.run 校验兜底（未知引擎返回失败而非整批丢失）
      return runParallelTasks(taskDefs, runner, 'dispatch_agents', context.callId, registry)
    },
  })

  // 注册 run_pipeline 工具（Pipeline 链式协作：前序引擎输出作为后序引擎输入）
  registry.register({
    definition: {
      name: 'run_pipeline',
      description: `按流水线顺序执行多个子智能体引擎，前序引擎的输出作为后序引擎的输入。适用于有依赖关系的多阶段任务（如 探索→编码→审查）。某步失败即中断并返回已完成的步骤。可选引擎: ${BUILTIN_ENGINES.map((e) => e.name).join(', ')}。`,
      inputSchema: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            description:
              '流水线步骤数组。每个元素是 {engine: string, description: string, writable?: boolean, tools?: string[]} 格式的对象，按顺序执行',
            items: {
              type: 'object',
              description: '单步: {engine, description, writable?, tools?}',
            },
          },
          input: {
            type: 'string',
            description: '初始输入（可选，注入第一步）',
          },
        },
        required: ['steps'],
      },
      requiresApproval: true,
      phase: 'execute',
    },
    execute: async (params, context) => {
      const runner = registry.getSubAgentRunner()
      if (!runner) {
        return {
          callId: context.callId,
          tool: 'run_pipeline',
          result: '',
          error: 'SubAgent 未初始化，无法运行流水线',
        }
      }

      const steps = params.steps as Array<{
        engine: string
        description: string
        writable?: boolean
        tools?: string[]
      }>
      if (!Array.isArray(steps) || steps.length === 0) {
        return {
          callId: context.callId,
          tool: 'run_pipeline',
          result: '',
          error: '步骤列表为空',
        }
      }

      const engineRegistry = runner.getEngineRegistry?.() ?? new AgentEngineRegistry()
      const pipeline = new PipelineRunner(engineRegistry, runner)
      const result = await pipeline.run(steps, params.input as string | undefined)

      if (!result.success) {
        const failedStep = result.steps.find((s) => !s.success)
        return {
          callId: context.callId,
          tool: 'run_pipeline',
          result: '',
          error: `流水线在第 ${result.steps.findIndex((s) => !s.success) + 1} 步中断: ${failedStep?.error ?? '未知错误'}`,
        }
      }

      const stepsSummary = result.steps
        .map((s, i) => `${i + 1}. [${s.engine}] ${s.summary}`)
        .join('\n')
      return {
        callId: context.callId,
        tool: 'run_pipeline',
        result: `流水线完成（${result.steps.length} 步）:\n${stepsSummary}`,
      }
    },
  })

  return registry
}

export { ToolRegistry }

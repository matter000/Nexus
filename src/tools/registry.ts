/**
 * MCP 工具注册中心
 * 管理所有内置工具的注册、查找和调用
 */

import { AgentEngineRegistry, BUILTIN_ENGINES } from '../agent/AgentEngine'
import { PipelineRunner } from '../agent/PipelineRunner'
import { dispatchSubagentToolDefinition } from '../agent/SubAgent'
import type { SubAgentResult, SubAgentTask, Todo, ToolDefinition, ToolResult } from '../agent/types'
import { getSemanticSearchEngine, semanticSearchToolDefinition } from '../context/SemanticSearch'
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

/** 并行子任务定义（dispatch_subagents / dispatch_agents 共用） */
interface TaskDef {
  description: string
  writable?: boolean
  tools?: string[]
  engine?: string
}

/**
 * 并行/串行执行多个子任务定义：只读任务并行（上限 3），写任务串行（互斥）。
 * 用 allSettled 而非 all：单个子任务 throw 时，其他已完成的结果不丢失。
 */
async function runParallelTasks(
  taskDefs: TaskDef[],
  runner: SubAgentRunner,
  toolName: string,
  callId: string,
): Promise<ToolResult> {
  // 分离只读任务和写任务
  const readTasks = taskDefs.filter((t) => !t.writable)
  const writeTasks = taskDefs.filter((t) => t.writable)

  const results: Array<{
    description: string
    success: boolean
    summary: string
    error?: string
  }> = []

  // 只读任务并行执行（上限 3）
  const PARALLEL_LIMIT = 3
  for (let i = 0; i < readTasks.length; i += PARALLEL_LIMIT) {
    const batch = readTasks.slice(i, i + PARALLEL_LIMIT)
    const settled = await Promise.allSettled(
      batch.map((t) => {
        const task: SubAgentTask = {
          id: `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          description: t.description,
          writable: false,
          tools: t.tools ?? [],
          maxIterations: 10,
          ...(t.engine ? { engine: t.engine } : {}),
        }
        return runner.run(task)
      }),
    )
    for (let j = 0; j < settled.length; j++) {
      const s = settled[j]
      if (s.status === 'fulfilled') {
        results.push({
          description: batch[j].description,
          success: s.value.success,
          summary: s.value.summary,
          error: s.value.error,
        })
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

  // 写任务串行执行（互斥）
  for (const t of writeTasks) {
    const task: SubAgentTask = {
      id: `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      description: t.description,
      writable: true,
      tools: t.tools ?? [],
      maxIterations: 10,
      ...(t.engine ? { engine: t.engine } : {}),
    }
    const result = await runner.run(task)
    results.push({
      description: t.description,
      success: result.success,
      summary: result.summary,
      error: result.error,
    })
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

  /** 注入 SubAgent 运行器实例(由 Orchestrator 在初始化时调用) */
  setSubAgentRunner(runner: SubAgentRunner): void {
    this.subAgentRunner = runner
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

    return handler.execute(params, context)
  }
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
  registry.register(submitPlanTool)
  registry.register(listDirectoryTool)
  registry.register(searchSymbolTool)
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
        '并行分派多个独立子任务给子 Agent。每个任务独立执行，最多 3 个并行。适用于多个互不依赖的任务（如同时搜索多个文件、同时分析多个模块）。写权限任务会自动串行执行。',
      inputSchema: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            description:
              '子任务数组。每个元素是 {description: string, writable?: boolean, tools?: string[]} 格式的对象',
            items: {
              type: 'object',
              description: '单个子任务: {description, writable?, tools?}',
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

      return runParallelTasks(taskDefs, runner, 'dispatch_subagents', context.callId)
    },
  })

  // 注册 dispatch_agents 工具（Fan-out 多引擎并行，最多 3 个并行）
  registry.register({
    definition: {
      name: 'dispatch_agents',
      description: `并行分派多个专用子智能体引擎执行独立子任务（最多 3 个并行）。每个任务可指定不同引擎（如 ${BUILTIN_ENGINES.map((e) => e.name).join('/')}）。写权限任务会自动串行执行。`,
      inputSchema: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            description:
              '引擎任务数组。每个元素是 {engine: string, description: string, writable?: boolean, tools?: string[]} 格式的对象',
            items: {
              type: 'object',
              description: '单个引擎任务: {engine, description, writable?, tools?}',
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
      return runParallelTasks(taskDefs, runner, 'dispatch_agents', context.callId)
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

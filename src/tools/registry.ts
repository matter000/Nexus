/**
 * MCP 工具注册中心
 * 管理所有内置工具的注册、查找和调用
 */

import type { ToolDefinition, ToolResult, SubAgentTask, SubAgentResult } from '../agent/types'
import { readFileTool } from './readFile'
import { editFileTool } from './editFile'
import { bashTool } from './bash'
import { grepTool } from './grep'
import { globTool } from './glob'
import { updateTodoTool } from './todo'
import { submitPlanTool } from './submitPlan'
import { listDirectoryTool } from './listDirectory'
import { searchSymbolTool } from './searchSymbol'
import { fetchUrlTool } from './fetchUrl'
import { dispatchSubagentToolDefinition } from '../agent/SubAgent'
import { toolSchemas } from './schemas'
import { semanticSearchToolDefinition, getSemanticSearchEngine } from '../context/SemanticSearch'

/** SubAgent 运行器接口(解耦循环依赖) */
export interface SubAgentRunner {
  run(task: SubAgentTask): Promise<SubAgentResult>
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
      (t) => t.definition.phase === phase || t.definition.phase === 'both'
    )
  }

  /** 获取需要审批的工具名列表 */
  getApprovalRequired(): string[] {
    return this.getAll()
      .filter((t) => t.definition.requiresApproval)
      .map((t) => t.definition.name)
  }

  /** 生成 Vercel AI SDK 兼容的工具定义 */
  toAISDKTools(phase: 'plan' | 'execute'): Record<string, { description: string; parameters: unknown }> {
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
  async execute(name: string, params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
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
          return { callId: context.callId, tool: 'semantic_search', result: `未找到与 "${query}" 相关的代码块` }
        }
        const formatted = results.map((r, i) =>
          `### [${i + 1}] ${r.filePath}:${r.startLine}-${r.endLine} (score: ${r.score.toFixed(3)})\n\`\`\`\n${r.content.slice(0, 500)}\n\`\`\``
        ).join('\n\n')
        return { callId: context.callId, tool: 'semantic_search', result: `找到 ${results.length} 个相关代码块:\n\n${formatted}` }
      } catch (err) {
        return { callId: context.callId, tool: 'semantic_search', result: '', error: `语义搜索失败: ${err instanceof Error ? err.message : String(err)}` }
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

      const filesNote = result.filesChanged.length > 0
        ? `\n\n修改的文件: ${result.filesChanged.join(', ')}`
        : ''

      return {
        callId: context.callId,
        tool: 'dispatch_subagent',
        result: `子任务完成: ${result.summary}${filesNote}`,
      }
    },
  })

  return registry
}

export { ToolRegistry }

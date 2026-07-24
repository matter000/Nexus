/**
 * MCP 工具注册中心
 * 管理所有内置工具的注册、查找和调用
 */

import type { ToolDefinition, ToolResult } from '../agent/types'
import { readFileTool } from './readFile'
import { editFileTool } from './editFile'
import { bashTool } from './bash'
import { grepTool } from './grep'

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
  return registry
}

export { ToolRegistry }

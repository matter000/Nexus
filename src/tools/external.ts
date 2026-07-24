/**
 * 外部 MCP Server 接入
 * 通过 stdio transport 连接外部 MCP Server
 */

import type { ToolDefinition, ToolResult } from '../agent/types'
import type { ToolHandler, ToolContext } from './registry'

export interface ExternalServerConfig {
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
}

/**
 * 外部 MCP Server 管理器
 * v1 简化实现:预留接口,Phase 2+ 完整实现 stdio JSON-RPC
 */
export class ExternalMCPManager {
  private servers = new Map<string, ExternalServerConfig>()
  private connected = new Set<string>()

  /** 注册外部 MCP Server */
  register(config: ExternalServerConfig): void {
    this.servers.set(config.name, config)
  }

  /** 连接到外部 Server (未来通过 stdio JSON-RPC) */
  async connect(name: string): Promise<boolean> {
    const config = this.servers.get(name)
    if (!config) return false

    // TODO: Phase 2 实现真正的 stdio transport
    // 使用 @modelcontextprotocol/sdk 的 Client + StdioClientTransport
    this.connected.add(name)
    return true
  }

  /** 断开连接 */
  async disconnect(name: string): Promise<void> {
    this.connected.delete(name)
  }

  /** 获取已连接 server 的工具列表 */
  async listTools(name: string): Promise<ToolDefinition[]> {
    // TODO: 通过 MCP tools/list 获取
    return []
  }

  /** 调用外部工具 */
  async callTool(name: string, toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    // TODO: 通过 MCP tools/call 调用
    return {
      callId: `ext-${name}-${toolName}`,
      tool: toolName,
      result: '',
      error: `外部 MCP Server "${name}" 尚未连接 (Phase 2 实现)`,
    }
  }

  /** 获取所有已注册的 server */
  getServers(): ExternalServerConfig[] {
    return Array.from(this.servers.values())
  }

  isConnected(name: string): boolean {
    return this.connected.has(name)
  }
}

/** 创建外部 MCP 管理器实例 */
export function createExternalMCPManager(): ExternalMCPManager {
  return new ExternalMCPManager()
}

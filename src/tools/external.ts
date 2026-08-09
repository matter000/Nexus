/**
 * 外部 MCP Server 接入
 * 支持两种 transport（截至 2026-08 MCP 生态现状）：
 * - stdio：本地子进程（command + args），经典方式
 * - Streamable HTTP：远程服务（url），2025 年后 MCP 远程接入的主流传输
 * 使用 @modelcontextprotocol/sdk 的 Client + 对应 transport
 */

import { Client } from '@modelcontextprotocol/sdk/client'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { ToolDefinition, ToolResult } from '../agent/types'
import type { ToolContext, ToolHandler } from './registry'

export interface ExternalServerConfig {
  name: string
  /** stdio 模式：启动命令（与 url 二选一） */
  command?: string
  /** stdio 模式：命令参数 */
  args?: string[]
  env?: Record<string, string>
  /** HTTP 模式：远程 MCP 服务地址（与 command 二选一） */
  url?: string
  /** 是否启用（默认 true；false 时注册但跳过连接） */
  enabled?: boolean
}

/** Server 状态信息 */
export interface ServerStatus {
  name: string
  /** 连接方式描述（stdio 命令或 HTTP URL） */
  transport: string
  connected: boolean
  toolCount: number
  enabled: boolean
}

/** 连接超时时间 (30 秒) */
const CONNECT_TIMEOUT_MS = 30_000

/** MCP Client 实例及其关联 transport（stdio 与 HTTP 两种） */
interface ManagedConnection {
  client: Client
  transport: StdioClientTransport | StreamableHTTPClientTransport
  config: ExternalServerConfig
}

/**
 * 外部 MCP Server 管理器
 * 通过 stdio JSON-RPC 与外部 MCP Server 通信
 */
export class ExternalMCPManager {
  private servers = new Map<string, ExternalServerConfig>()
  private connections = new Map<string, ManagedConnection>()

  /** 注册外部 MCP Server */
  register(config: ExternalServerConfig): void {
    this.servers.set(config.name, config)
  }

  /** 连接到外部 Server (stdio 或 Streamable HTTP) */
  async connect(name: string): Promise<boolean> {
    const config = this.servers.get(name)
    if (!config) return false
    if (config.enabled === false) return false

    // 已连接则直接返回
    if (this.connections.has(name)) return true

    try {
      const transport = this.createTransport(config)
      if (!transport) {
        console.error(`[MCP] "${name}" 配置无效：需 command(stdio) 或 url(HTTP) 之一`)
        return false
      }

      const client = new Client({ name: 'nexus', version: '1.0.0' }, { capabilities: {} })

      // 带超时的连接
      const connectPromise = client.connect(transport)
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error(`连接超时 (${CONNECT_TIMEOUT_MS}ms)`)),
          CONNECT_TIMEOUT_MS,
        )
      })

      await Promise.race([connectPromise, timeoutPromise])

      // 存储连接实例
      this.connections.set(name, { client, transport, config })
      return true
    } catch (error) {
      // 清理失败连接
      this.connections.delete(name)
      const msg = error instanceof Error ? error.message : String(error)
      const hint = this.getConnectionHint(name, msg)
      console.error(`[MCP] 连接 "${name}" 失败: ${msg}\n${hint}`)
      return false
    }
  }

  /** 断开连接 */
  async disconnect(name: string): Promise<void> {
    const conn = this.connections.get(name)
    if (!conn) return

    try {
      await conn.client.close()
    } catch {
      // 关闭时忽略错误
    }
    this.connections.delete(name)
  }

  /** 断开所有连接 */
  async disconnectAll(): Promise<void> {
    const names = Array.from(this.connections.keys())
    await Promise.all(names.map((name) => this.disconnect(name)))
  }

  /** 获取已连接 server 的工具列表 */
  async listTools(name: string): Promise<ToolDefinition[]> {
    const conn = this.connections.get(name)
    if (!conn) return []

    try {
      const result = await conn.client.listTools()
      return result.tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: {
          type: 'object' as const,
          properties: this.convertProperties(tool.inputSchema.properties),
          required: tool.inputSchema.required ?? [],
        },
        requiresApproval: true, // 外部工具默认需要审批
        phase: 'both' as const,
      }))
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.error(`[MCP] 获取 "${name}" 工具列表失败: ${msg}`)
      return []
    }
  }

  /** 调用外部工具 */
  async callTool(
    name: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const conn = this.connections.get(name)
    if (!conn) {
      return {
        callId: `ext-${name}-${toolName}`,
        tool: toolName,
        result: '',
        error: `外部 MCP Server "${name}" 未连接`,
      }
    }

    try {
      const result = await conn.client.callTool({
        name: toolName,
        arguments: args,
      })

      // 提取文本结果
      const textParts: string[] = []
      if ('content' in result) {
        const content = result.content as Array<{ type: string; text?: string }>
        for (const item of content) {
          if (item.type === 'text' && item.text) {
            textParts.push(item.text)
          }
        }
      }

      const resultText = textParts.join('\n') || JSON.stringify(result)
      const isError = 'isError' in result ? (result as { isError?: boolean }).isError : false

      return {
        callId: `ext-${name}-${toolName}`,
        tool: toolName,
        result: resultText,
        error: isError ? resultText : undefined,
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return {
        callId: `ext-${name}-${toolName}`,
        tool: toolName,
        result: '',
        error: `调用外部工具 "${toolName}" 失败: ${msg}`,
      }
    }
  }

  /** 获取所有已连接 server 的全部工具(名称带 server 前缀) */
  async listAllTools(): Promise<ToolHandler[]> {
    const handlers: ToolHandler[] = []
    for (const serverName of this.connections.keys()) {
      const tools = await this.listTools(serverName)
      for (const tool of tools) {
        handlers.push(mcpToolToHandler(tool, this, serverName))
      }
    }
    return handlers
  }

  /** 获取所有已注册 Server 的状态 */
  async getStatus(): Promise<ServerStatus[]> {
    const statuses: ServerStatus[] = []
    for (const [name, config] of this.servers) {
      const connected = this.connections.has(name)
      let toolCount = 0
      if (connected) {
        try {
          const tools = await this.listTools(name)
          toolCount = tools.length
        } catch {
          // 获取工具列表失败时保持 0
        }
      }
      statuses.push({
        name,
        transport: config.url ?? `${config.command ?? ''} ${(config.args ?? []).join(' ')}`.trim(),
        connected,
        toolCount,
        enabled: config.enabled !== false,
      })
    }
    return statuses
  }

  /** 重新连接指定 Server */
  async reconnect(name: string): Promise<boolean> {
    await this.disconnect(name)
    return this.connect(name)
  }

  /** 获取所有已注册的 server */
  getServers(): ExternalServerConfig[] {
    return Array.from(this.servers.values())
  }

  /** 根据配置创建对应 transport：url → Streamable HTTP，command → stdio */
  private createTransport(
    config: ExternalServerConfig,
  ): StdioClientTransport | StreamableHTTPClientTransport | null {
    if (config.url) {
      return new StreamableHTTPClientTransport(new URL(config.url))
    }
    if (config.command) {
      return new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        env: config.env ? ({ ...process.env, ...config.env } as Record<string, string>) : undefined,
        stderr: 'pipe',
      })
    }
    return null
  }

  isConnected(name: string): boolean {
    return this.connections.has(name)
  }

  /** 根据错误信息给出排查建议 */
  private getConnectionHint(name: string, errorMsg: string): string {
    const hints: string[] = []
    const config = this.servers.get(name)
    const target = config?.url ?? config?.command ?? ''
    if (errorMsg.includes('ENOENT') || errorMsg.includes('not found')) {
      hints.push(`排查: 命令 "${target}" 可能未安装或不在 PATH 中`)
      hints.push('排查: 尝试在终端手动运行该命令确认可用性')
    } else if (errorMsg.includes('Invalid URL') || errorMsg.includes('fetch failed')) {
      hints.push(`排查: 远程 MCP 服务 "${target}" 不可达，检查 URL 与网络`)
    } else if (errorMsg.includes('timeout') || errorMsg.includes('超时')) {
      hints.push('排查: Server 启动过慢,可尝试增大 CONNECT_TIMEOUT_MS')
      hints.push('排查: 检查网络连接(npx 需要下载包时可能较慢)')
    } else if (errorMsg.includes('EACCES') || errorMsg.includes('permission')) {
      hints.push('排查: 权限不足,检查命令执行权限')
    } else {
      hints.push('排查: 在终端手动运行命令确认是否正常')
      hints.push('排查: 检查 args/url 参数是否正确')
    }
    return hints.join('\n')
  }

  /** 将 MCP Tool inputSchema properties 转换为 Nexus ToolProperty 格式 */
  private convertProperties(
    properties?: Record<string, object>,
  ): Record<
    string,
    { type: 'string' | 'number' | 'boolean' | 'array' | 'object'; description?: string }
  > {
    if (!properties) return {}
    const result: Record<
      string,
      { type: 'string' | 'number' | 'boolean' | 'array' | 'object'; description?: string }
    > = {}
    for (const [key, value] of Object.entries(properties)) {
      const prop = value as Record<string, unknown>
      result[key] = {
        type: (prop.type as 'string' | 'number' | 'boolean' | 'array' | 'object') ?? 'string',
        description: prop.description as string | undefined,
      }
    }
    return result
  }
}

/** 将 MCP ToolDefinition 包装为 ToolHandler */
function mcpToolToHandler(
  mcpTool: ToolDefinition,
  manager: ExternalMCPManager,
  serverName: string,
): ToolHandler {
  return {
    definition: {
      ...mcpTool,
      name: `mcp_${serverName}_${mcpTool.name}`,
    },
    execute: async (params: Record<string, unknown>, _context: ToolContext) => {
      return manager.callTool(serverName, mcpTool.name, params)
    },
  }
}

/** 创建外部 MCP 管理器实例 */
export function createExternalMCPManager(): ExternalMCPManager {
  return new ExternalMCPManager()
}

/**
 * Nexus 核心类型定义
 * 定义事件流、工具、Agent 状态等所有共享类型
 */

// ─── 事件流类型 ───────────────────────────────────────────────────────────────

export type NexusEvent =
  | { type: 'user_input'; text: string }
  | { type: 'llm_start'; phase: 'plan' | 'execute' }
  | { type: 'llm_chunk'; text: string }
  | { type: 'llm_done'; text: string }
  | { type: 'tool_call'; tool: string; params: Record<string, unknown>; callId: string }
  | { type: 'tool_approval_request'; callId: string; tool: string; params: Record<string, unknown>; diff?: string }
  | { type: 'tool_result'; callId: string; tool: string; result: string; error?: string }
  | { type: 'todo_update'; todos: Todo[] }
  | { type: 'checkpoint'; step: number; message: string }
  | { type: 'cost_update'; inputTokens: number; outputTokens: number; cost: number }
  | { type: 'phase_change'; phase: AgentPhase }
  | { type: 'done'; summary: string }
  | { type: 'error'; message: string; recoverable: boolean }

// ─── Agent 状态 ───────────────────────────────────────────────────────────────

export type AgentPhase = 'idle' | 'planning' | 'awaiting_approval' | 'executing' | 'verifying' | 'done' | 'error'

export type PermissionMode = 'ask' | 'auto-edit' | 'auto-all' | 'yolo'

export interface Todo {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'complete' | 'cancelled'
}

export interface Plan {
  summary: string
  todos: Todo[]
  filesToModify: string[]
  estimatedSteps: number
}

// ─── 工具类型 ─────────────────────────────────────────────────────────────────

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: ToolInputSchema
  requiresApproval: boolean
  phase: 'plan' | 'execute' | 'both'
}

export interface ToolInputSchema {
  type: 'object'
  properties: Record<string, ToolProperty>
  required: string[]
}

export interface ToolProperty {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object'
  description?: string
  enum?: string[]
  default?: unknown
  items?: ToolProperty
}

export interface ToolCall {
  callId: string
  tool: string
  params: Record<string, unknown>
}

export interface ToolResult {
  callId: string
  tool: string
  result: string
  error?: string
  truncated?: boolean
}

export type ToolPermission = 'auto' | 'approval' | 'denied'

// ─── 模型路由类型 ─────────────────────────────────────────────────────────────

export type ProviderName = 'anthropic' | 'openai' | 'google' | 'ollama' | 'openrouter' | 'deepseek' | 'custom'

export type ModelRole = 'planner' | 'executor' | 'summarizer' | 'verifier'

export interface ModelRoute {
  provider: ProviderName
  model: string
  role: ModelRole
  costPer1kInput: number
  costPer1kOutput: number
  contextWindow: number
  supportsTools: boolean
  supportsStreaming: boolean
}

export interface CostRecord {
  timestamp: number
  role: ModelRole
  provider: ProviderName
  model: string
  inputTokens: number
  outputTokens: number
  cost: number
}

// ─── 上下文类型 ───────────────────────────────────────────────────────────────

export interface ContextLayer {
  level: 'L1' | 'L2' | 'L3'
  content: string
  tokens: number
  priority: number // 越高越重要,压缩时最后丢弃
}

export interface AssembledContext {
  systemPrompt: string
  messages: ChatMessage[]
  totalTokens: number
  budgetExceeded: boolean
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCallId?: string
  name?: string
}

// ─── 配置类型 ─────────────────────────────────────────────────────────────────

export interface NexusConfig {
  models: {
    planner: string
    executor: string
    summarizer: string
    verifier: string
    providers: Record<string, ProviderConfig>
  }
  permissions: {
    mode: PermissionMode
  }
  limits: {
    maxSessionCost: number
    bashTimeout: number
    maxReadLines: number
    maxIterations: number
    maxOutputBytes: number
  }
  context: {
    budgetRatio: number
    recentTurnsKeep: number
  }
  checkpoint: {
    autoCheckpoint: boolean
    branch: string
  }
}

export interface ProviderConfig {
  apiKeyEnv?: string
  baseUrl?: string
  defaultModel: string
}

export interface ProjectRules {
  project: {
    name: string
    language: string
    testCommand: string
    buildCommand: string
  }
  style: {
    indent: number
    quote: 'single' | 'double'
    semicolons: boolean
  }
  constraints: Record<string, boolean>
  context: {
    alwaysInclude: string[]
  }
}

// ─── 检查点类型 ───────────────────────────────────────────────────────────────

export interface Checkpoint {
  step: number
  commitHash: string
  message: string
  todoId?: string
  timestamp: number
  filesChanged: string[]
}

// ─── 子 Agent 类型 ────────────────────────────────────────────────────────────

export interface SubAgentTask {
  id: string
  description: string
  writable: boolean
  tools: string[]
  maxIterations: number
}

export interface SubAgentResult {
  id: string
  success: boolean
  summary: string
  filesChanged: string[]
  error?: string
}

// ─── 会话类型 ─────────────────────────────────────────────────────────────────

export interface Session {
  id: string
  projectRoot: string
  startTime: number
  messages: ChatMessage[]
  todos: Todo[]
  checkpoints: Checkpoint[]
  totalCost: number
  totalInputTokens: number
  totalOutputTokens: number
}

// ─── 可插拔引擎接口 (零改动迁移保证) ───────────────────────────────────────

/**
 * 沙箱提供者接口
 * Agent 编排层通过此接口执行命令,不直接依赖具体实现
 *
 * 当前: TypeScriptSandbox (spawn + CommandGuard)
 * v2: GoSandbox (pty + cgroup + syscall 过滤)
 * 替换时只需更换注入的实现,Agent loop 零改动
 */
export interface SandboxProvider {
  execute(command: string, options: {
    cwd: string
    timeoutMs: number
    maxOutputBytes: number
  }): Promise<{
    stdout: string
    stderr: string
    exitCode: number
    timedOut: boolean
  }>
  isAvailable(): boolean
  readonly name: string
}

/**
 * 图谱提供者接口
 * Agent 编排层通过此接口访问代码图谱,不直接依赖具体实现
 *
 * 当前: TypeScriptGraphEngine (空图谱 fallback)
 * v2: GoGraphEngine (tree-sitter 后台索引服务)
 * 替换时只需更换注入的实现,Agent loop 零改动
 */
export interface GraphProvider {
  buildGraph(projectRoot: string): Promise<unknown>
  querySymbol(name: string): Promise<unknown[]>
  getDependencies(filePath: string): Promise<string[]>
  isAvailable(): boolean
  readonly name: string
}

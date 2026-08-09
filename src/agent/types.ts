/**
 * Nexus 核心类型定义
 * 定义事件流、工具、Agent 状态等所有共享类型
 */

import type { EvidenceConfig, EvidenceResult } from './EvidenceGate'

// ─── 事件流类型 ───────────────────────────────────────────────────────────────

export type NexusEvent =
  | { type: 'user_input'; text: string }
  | { type: 'llm_start'; phase: 'plan' | 'execute' }
  | { type: 'llm_chunk'; text: string }
  | { type: 'llm_reasoning'; text: string }
  | { type: 'llm_done'; text: string }
  | {
      type: 'tool_call'
      tool: string
      params: Record<string, unknown>
      callId: string
      todoId?: string
    }
  | {
      type: 'tool_approval_request'
      callId: string
      tool: string
      params: Record<string, unknown>
      diff?: string
    }
  | { type: 'plan_approval_request'; callId: string; plan: Plan }
  | {
      type: 'tool_result'
      callId: string
      tool: string
      result: string
      error?: string
      /** 发起该调用的任务归属（TUI 按任务分组展示） */
      todoId?: string
    }
  | { type: 'todo_update'; todos: Todo[] }
  | { type: 'checkpoint'; step: number; message: string }
  | {
      type: 'cost_update'
      inputTokens: number
      outputTokens: number
      cost: number
      /** 本次调用的 prompt token 数（上下文利用率观测） */
      promptTokens?: number
      /** 当前模型的上下文窗口大小（token） */
      windowTokens?: number
    }
  | { type: 'phase_change'; phase: AgentPhase }
  | { type: 'done'; summary: string }
  | { type: 'error'; message: string; recoverable: boolean }
  | { type: 'config_updated' }
  | { type: 'system_info'; message: string }
  | { type: 'agent_start'; engine: string; taskId: string }
  | { type: 'agent_done'; engine: string; taskId: string; success: boolean; summary: string }
  /** 文件产物：写文件工具成功时发出，TUI 按 todoId 归属展示在对应任务下方 */
  | { type: 'file_artifact'; path: string; tool: string; todoId?: string }

// ─── Agent 状态 ───────────────────────────────────────────────────────────────

export type AgentPhase =
  | 'idle'
  | 'planning'
  | 'awaiting_approval'
  | 'executing'
  | 'verifying'
  | 'done'
  | 'error'

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

// ─── 模型路由类型 ─────────────────────────────────────────────────────────────

export type ProviderName = 'anthropic' | 'openai' | 'google' | 'openrouter' | 'deepseek' | 'custom'

export type ModelRole = 'planner' | 'executor' | 'summarizer' | 'verifier'

export interface ModelRoute {
  /** provider 名称（内置为 ProviderName，自定义条目为任意键名） */
  provider: string
  model: string
  role: ModelRole
  costPer1kInput: number
  costPer1kOutput: number
  /** 缓存命中输入单价（每 1k）。DeepSeek 缓存命中价远低于未命中价，缺省时按 costPer1kInput 计费 */
  costPer1kInputCached?: number
  contextWindow: number
  supportsTools: boolean
  supportsStreaming: boolean
}

export interface CostRecord {
  timestamp: number
  role: ModelRole
  /** provider 名称（内置为 ProviderName，自定义条目为任意键名） */
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  cost: number
  /** 缓存命中的 prompt token 数（DeepSeek API 返回） */
  cacheHitTokens?: number
  /** 缓存未命中的 prompt token 数（DeepSeek API 返回） */
  cacheMissTokens?: number
  /** 推理 token 数（DeepSeek 思考模式下产生） */
  reasoningTokens?: number
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

/** Executor ReAct 循环内部使用的消息类型（含工具调用与工具结果）
 *
 * DeepSeek 思考模式适配:
 * - 当模型在思考模式下进行了工具调用，`reasoning_content` 必须在后续所有请求中回传
 * - 若无工具调用，`reasoning_content` 可省略（API 会忽略）
 * - 详见: https://api-docs.deepseek.com/zh-cn/guides/thinking_mode#%E5%B7%A5%E5%85%B7%E8%B0%83%E7%94%A8
 */
export type ExecMessage =
  | { role: 'user' | 'assistant'; content: string; reasoning?: string }
  | {
      role: 'assistant'
      content: string
      reasoning?: string
      toolCalls: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>
    }
  | {
      role: 'tool'
      content: Array<{
        type: 'tool-result'
        toolCallId: string
        toolName: string
        result: string
      }>
    }

// ─── 配置类型 ─────────────────────────────────────────────────────────────────

export interface NexusConfig {
  models: {
    planner: string
    executor: string
    summarizer: string
    verifier: string
    providers: Record<string, ProviderConfig>
    /** 模型成本覆盖：模型名 → 每千 token 成本。用于新增/自定义模型，优先于内置成本表 */
    costOverrides?: Record<
      string,
      { costPer1kInput: number; costPer1kOutput: number; costPer1kInputCached?: number }
    >
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
    /** 自动修复模式：错误时自动重试次数（0 表示关闭） */
    maxAutoRetries: number
  }
  context: {
    budgetRatio: number
    recentTurnsKeep: number
    /** 执行循环内开始微压实（压缩旧工具结果）的水位，占上下文窗口比例 */
    compactionThreshold: number
    /** 触发紧急 LLM 压实的水位，占上下文窗口比例 */
    emergencyThreshold: number
    /** 压实时保持完整不压缩的最近工具结果条数 */
    keepRecentResultsFull: number
  }
  checkpoint: {
    autoCheckpoint: boolean
    branch: string
  }
  /**
   * Loop Engineering 证据门禁配置（.nexus/config.toml 的 [evidence] 段）。
   * 任务完成时运行确定性检查（lint/typecheck/test），结果作为验证与修复循环的证据
   * （手册铁律：不基于置信度循环，基于证据循环）。未配置时探测项目 package.json scripts。
   */
  evidence?: EvidenceConfig
  /** 工具钩子（可选）：为 CI/外部循环编排提供拦截与通知入口 */
  hooks?: ToolHooks
}

/** 单轮执行（首次或修复轮次）的循环 trace（Loop Engineering 观测，供 L4 复用） */
export interface LoopTraceRound {
  /** 0 = 首次执行，1.. = 修复轮次 */
  round: number
  /** 本轮 ReAct 迭代数 */
  iterations: number
  /** 证据门禁是否通过（全部 skipped 视为通过） */
  evidencePassed: boolean
  evidence: EvidenceResult[]
  /** 验证结论；未运行验证（纯查询）时为 null */
  verifyPass: boolean | null
  verifyFailures: number
}

/**
 * 工具钩子配置（.nexus/config.toml 的 [hooks] 段）。
 * 命令经 bash -c 执行，通过环境变量传递上下文：
 * NEXUS_TOOL_NAME / NEXUS_TOOL_ARGS（JSON）/ NEXUS_PROJECT_ROOT；
 * post_tool 额外携带 NEXUS_TOOL_OK / NEXUS_TOOL_RESULT（截断）。
 */
export interface ToolHooks {
  /** 工具执行前钩子：退出码非 0 拦截该工具（stderr 作为拦截原因返回给 LLM） */
  preTool?: string
  /** 工具执行后钩子：仅通知，失败不影响工具结果 */
  postTool?: string
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
  /** 项目根 AGENTS.md 原文（截断后），作为结构化 rules.toml 的补充说明注入上下文 */
  agentsMd?: string
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
  /** 是否允许修改文件；缺省由引擎定义决定（无引擎时默认 false） */
  writable?: boolean
  tools: string[]
  maxIterations: number
  /** 引擎名；缺省时为通用行为（向后兼容） */
  engine?: string
  /** 引擎角色提示词（由 EngineRegistry 解析后注入） */
  systemPrompt?: string
  /** 流水线前序输出（注入上下文，Pipeline 模式用） */
  input?: string
  /** 隔离模式：worktree = 在独立 git worktree 中执行（并行写防踩脚，业界首选方案） */
  isolation?: 'worktree'
  /** 内部字段：在既有目录执行（审查/修复子任务指向同一 worktree 用） */
  runInDir?: string
  /** 内部字段：跳过自动审查闭环（审查/修复任务自身不再触发，防递归成本失控） */
  noReview?: boolean
}

export interface SubAgentResult {
  id: string
  success: boolean
  summary: string
  filesChanged: string[]
  error?: string
  /** worktree 隔离任务：待合并的分支名（无变更时已自动清理，为 undefined） */
  worktreeBranch?: string
  /** worktree 工作目录 */
  worktreePath?: string
  /** worktree 变更摘要（审批合并与审查用） */
  diffSummary?: string
  /** 自动审查闭环的审查报告（触发过时附带） */
  reviewReport?: string
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
  execute(
    command: string,
    options: {
      cwd: string
      timeoutMs: number
      maxOutputBytes: number
    },
  ): Promise<{
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

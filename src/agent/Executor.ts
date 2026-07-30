/**
 * Execute 阶段
 * ReAct Loop 核心:逐步执行计划,每步可回滚
 */

import type { LanguageModel } from 'ai'
import { generateText } from 'ai'
import { readFile } from 'fs/promises'
import { resolve } from 'path'
import type { CostTracker } from '../router/CostTracker'
import type { CheckpointManager } from '../sandbox/Checkpoint'
import { requiresForcedApproval } from '../sandbox/CommandGuard'
import { generateDiff } from '../tools/editFile'
import type { ToolContext, ToolRegistry } from '../tools/registry'
import { toolSchemas } from '../tools/schemas'
import { callWithRetry } from '../utils'
import { callLLMWithRetry } from './ReActLoop'
import type { ChatMessage, ModelRole, NexusEvent, PermissionMode, Plan, Todo } from './types'

const EXECUTE_SYSTEM_SUFFIX = `
## 当前阶段: Execute (执行)

你正在执行阶段。按照批准的计划逐步执行:
1. 每次只做一个步骤
2. 使用 edit_file 精准修改(确保 old_string 唯一匹配)
3. 修改后用 bash 运行测试验证
4. 完成所有步骤后输出总结

## 重要规则
- edit_file 的 old_string 必须包含足够上下文确保唯一匹配
- 如果 edit 失败(未找到/不唯一),先 read_file 获取最新内容再重试
- 每完成一个步骤,必须调用 update_todo(action="complete", id="...") 标记该步骤完成
- 遇到无法解决的问题,诚实说明而不是强行修改
- bash 命令的运行目录是项目根目录，不要 cd 到别处，直接用 python3 文件名 即可运行

## Auto 模式（无预设 todo 时）
- 如无预设 todo,请先用 update_todo(action="add", content="...") 拆解任务为 2-5 个步骤,再逐步执行
- 每完成一个步骤后调用 update_todo(action="complete") 标记完成`

export interface ExecutorConfig {
  model: LanguageModel
  toolRegistry: ToolRegistry
  toolContext: ToolContext
  checkpoint: CheckpointManager
  maxIterations: number
  permissionMode: PermissionMode
  onEvent: (event: NexusEvent) => void
  /** 审批回调:返回 true=批准, false=拒绝 */
  requestApproval: (
    tool: string,
    params: Record<string, unknown>,
    diff?: string,
  ) => Promise<boolean>
  /** 成本追踪器 */
  costTracker: CostTracker
  /** 当前模型角色（用于成本记录） */
  modelRole: ModelRole
  /** 当前 provider 名称（用于成本记录，内置为 ProviderName，自定义为任意键名） */
  providerName: string
  /** 当前模型名称（用于成本记录） */
  modelName: string
  /** 输入 token 单价（每 1k） */
  costPer1kInput: number
  /** 输出 token 单价（每 1k） */
  costPer1kOutput: number
  /** 会话成本上限 */
  maxSessionCost: number
  /** 获取降级模型（主模型全部重试失败后使用） */
  getFallbackModel?: () => LanguageModel | null
  /** 降级模型名称（用于事件通知） */
  fallbackModelName?: string
  /** 中断信号（Orchestrator.abort() 时触发） */
  abortSignal?: AbortSignal
}

/**
 * 简单的 Promise 信号量，限制并发数
 */
class Semaphore {
  private queue: Array<() => void> = []
  private active = 0
  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++
      return
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active++
        resolve()
      })
    })
  }

  release(): void {
    this.active--
    const next = this.queue.shift()
    if (next) next()
  }
}

export class Executor {
  private config: ExecutorConfig
  private todos: Todo[] = []
  private iterations = 0
  /** bash 并发信号量，上限 3 */
  private bashSemaphore = new Semaphore(3)
  /** 必须串行执行的工具 */
  private static readonly SERIAL_TOOLS = new Set(['edit_file', 'update_tool'])
  /** 同一文件的 edit_file 连续失败计数（key: 文件路径, value: 连续失败次数） */
  private consecutiveEditFailures = new Map<string, number>()
  /** 自上次 todo 状态变更以来的工具调用数（检测 agent 是否陷入循环） */
  private stepsSinceProgress = 0
  /** 已发出的 stuck 警告次数（最多 2 次，避免刷屏） */
  private stuckWarnings = 0
  /** 是否执行过 edit_file（仅在有代码变更时运行验证） */
  private hasCodeChanges = false

  constructor(config: ExecutorConfig) {
    this.config = config
  }

  /** 执行计划 */
  async execute(plan: Plan, contextMessages: ChatMessage[]): Promise<string> {
    const { model, toolRegistry, toolContext, maxIterations, onEvent } = this.config

    this.todos = [...plan.todos]
    this.iterations = 0
    this.hasCodeChanges = false
    this.consecutiveEditFailures.clear()
    this.stuckWarnings = 0
    this.stepsSinceProgress = 0

    onEvent({ type: 'llm_start', phase: 'execute' })
    onEvent({ type: 'todo_update', todos: this.todos })

    // Execute 阶段用全部工具
    const execTools = toolRegistry.getForPhase('execute')
    const toolsForAI: Record<string, { description: string; parameters: unknown }> = {}
    for (const tool of execTools) {
      toolsForAI[tool.definition.name] = {
        description: tool.definition.description,
        parameters: toolSchemas[tool.definition.name] ?? tool.definition.inputSchema,
      }
    }

    // 构建初始消息
    const planSummary = `## 已批准的计划\n${plan.summary}\n\n步骤:\n${plan.todos.map((t, i) => `${i + 1}. ${t.content}`).join('\n')}`

    type ExecMessage =
      | { role: 'user' | 'assistant'; content: string }
      | {
          role: 'assistant'
          content: string
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

    const messages: ExecMessage[] = [
      ...contextMessages.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      { role: 'user', content: planSummary },
    ]

    let finalText = ''
    let executionError = false

    // ReAct Loop
    while (this.iterations < maxIterations) {
      // 检查中断信号
      if (this.config.abortSignal?.aborted) {
        finalText = '执行已被中断。'
        executionError = true
        break
      }
      this.iterations++

      // 使用共享的 LLM 调用工具（统一 streamText + 重试 + 成本记录），支持降级模型
      let callResult: {
        streamedText: string
        toolCalls: Array<{ toolName: string; args: Record<string, unknown> }>
      }
      try {
        callResult = await callLLMWithRetry(
          {
            model,
            system: EXECUTE_SYSTEM_SUFFIX,
            messages,
            tools: toolsForAI,
            maxSteps: 1,
            abortSignal: this.config.abortSignal,
          },
          {
            onEvent,
            costConfig: {
              costTracker: this.config.costTracker,
              modelRole: this.config.modelRole,
              providerName: this.config.providerName,
              modelName: this.config.modelName,
              costPer1kInput: this.config.costPer1kInput,
              costPer1kOutput: this.config.costPer1kOutput,
            },
          },
          this.config.getFallbackModel?.() ?? undefined,
        )
      } catch (err) {
        const msg = (err as Error).message
        // 主模型 + 备用模型均不可用
        if (msg.includes('主模型和备用模型均不可用')) {
          finalText = `LLM 调用失败：${msg}`
          onEvent({ type: 'error', message: '所有模型均不可用', recoverable: false })
          break
        }
        finalText = `LLM 调用失败且无可用降级模型: ${msg}`
        onEvent({ type: 'error', message: 'LLM 调用失败', recoverable: false })
        executionError = true
        break
      }

      const { streamedText, toolCalls } = callResult

      // 检查成本上限
      if (this.config.costTracker.isOverBudget(this.config.maxSessionCost)) {
        finalText = `会话成本已超过上限 ($${this.config.maxSessionCost})。当前花费: ${this.config.costTracker.getSummary()}`
        onEvent({ type: 'error', message: '成本超限', recoverable: false })
        executionError = true
        break
      }

      // 无工具调用 → 执行完成
      if (!toolCalls || toolCalls.length === 0) {
        finalText = streamedText
        break
      }

      // 有工具调用（文本已在流式过程中通过 llm_chunk 发送）
      // 保存 LLM 的叙述文本，防止达到迭代上限时 finalText 为空
      finalText = streamedText || finalText

      // 构建 assistant 消息（包含工具调用信息，让 LLM 知道“我调用了哪些工具”）
      const assistantMsg: ExecMessage = {
        role: 'assistant',
        content: streamedText || '',
        toolCalls: toolCalls.map((tc, idx) => ({
          toolCallId: `exec-${this.iterations}-${tc.toolName}-${idx}`,
          toolName: tc.toolName,
          args: tc.args,
        })),
      }
      messages.push(assistantMsg)

      // 分离串行和并行工具调用
      const serialCalls = toolCalls.filter((tc) => Executor.SERIAL_TOOLS.has(tc.toolName))
      const parallelCalls = toolCalls.filter((tc) => !Executor.SERIAL_TOOLS.has(tc.toolName))

      // 收集所有工具结果，最后统一推入 tool 消息
      const toolResults: Array<{ toolCallId: string; toolName: string; result: string }> = []

      // 并行执行只读/非串行工具
      if (parallelCalls.length > 0) {
        const parallelSettled = await Promise.allSettled(
          parallelCalls.map((tc, idx) =>
            this.executeSingleToolCall(tc, messages, toolResults, idx),
          ),
        )
        for (let i = 0; i < parallelSettled.length; i++) {
          const r = parallelSettled[i]
          if (r.status === 'rejected') {
            onEvent({
              type: 'error',
              message: `并行工具 ${parallelCalls[i].toolName} 执行异常: ${r.reason}`,
              recoverable: true,
            })
          }
        }
      }

      // 串行执行写工具（edit_file / update_todo）
      for (let idx = 0; idx < serialCalls.length; idx++) {
        await this.executeSingleToolCall(
          serialCalls[idx],
          messages,
          toolResults,
          parallelCalls.length + idx,
        )
      }

      // 将所有工具结果作为一条 tool 消息推入（AI SDK 原生格式）
      if (toolResults.length > 0) {
        messages.push({
          role: 'tool',
          content: toolResults.map((tr) => ({
            type: 'tool-result' as const,
            toolCallId: tr.toolCallId,
            toolName: tr.toolName,
            result: tr.result,
          })),
        })
      }

      // 检测 agent 是否陷入循环：连续 8 步无 progress 时提示（最多 2 次）
      if (this.stepsSinceProgress >= 8 && this.stuckWarnings < 2) {
        this.stuckWarnings++
        onEvent({
          type: 'system_info',
          message: `已执行 ${this.stepsSinceProgress} 步但无 todo 进展，agent 可能在循环中。如果看起来卡住了，可以按 Ctrl+C 中断。`,
        })
        this.stepsSinceProgress = 0
      }
    }

    // 达到迭代上限
    if (this.iterations >= maxIterations) {
      finalText = `已达到最大迭代次数 (${maxIterations})。当前进度:\n${this.formatTodos()}`
      onEvent({ type: 'error', message: '达到迭代上限', recoverable: true })
      executionError = true
    }

    // 正常完成时，自动将未完成的 todo 标记为 complete
    // （LLM 可能忘记调 update_todo，如纯查询任务）
    if (!executionError) {
      for (const t of this.todos) {
        if (t.status === 'pending' || t.status === 'in_progress') {
          t.status = 'complete'
        }
      }
    }

    onEvent({ type: 'todo_update', todos: this.todos })

    // ─── 验证阶段 ───
    // 仅在正常完成且有代码修改时运行验证（纯查询/对话跳过）
    if (!executionError && this.hasCodeChanges) {
      onEvent({ type: 'phase_change', phase: 'verifying' })
      const verifyResult = await this.runVerification(plan, finalText, messages, toolsForAI)
      if (verifyResult) {
        finalText = finalText
          ? `${finalText}\n\n## 验证\n${verifyResult}`
          : `## 验证\n${verifyResult}`
      }
    }

    return finalText
  }

  /**
   * 执行后验证：mini ReAct loop，每步可执行工具（read_file/grep/bash）
   * 最多 5 步，每步的工具调用对用户可见
   */
  private async runVerification(
    plan: Plan,
    executionResult: string,
    messages: Array<
      | { role: 'user' | 'assistant'; content: string }
      | {
          role: 'assistant'
          content: string
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
    >,
    _toolsForAI: Record<string, { description: string; parameters: unknown }>,
  ): Promise<string> {
    const { model, toolRegistry, toolContext, onEvent } = this.config
    const MAX_VERIFY_STEPS = 5

    // 验证阶段允许只读工具 + bash（跑测试），不允许 edit_file
    const verifyTools = toolRegistry.getForPhase('plan')
    const bashHandler = toolRegistry.get('bash')
    if (bashHandler) verifyTools.push(bashHandler)
    const verifyToolsForAI: Record<string, { description: string; parameters: unknown }> = {}
    for (const tool of verifyTools) {
      verifyToolsForAI[tool.definition.name] = {
        description: tool.definition.description,
        parameters: toolSchemas[tool.definition.name] ?? tool.definition.inputSchema,
      }
    }

    const todoStatus = this.formatTodos()
    const verifyPrompt = `## 验证任务

执行已完成。请逐项检查每个 todo 是否真正完成：

计划: ${plan.summary}

当前 todo 状态:
${todoStatus}

执行结果:
${executionResult || '(无文本输出)'}

## 验证步骤
1. 对每个状态为 "complete" 的 todo，用 read_file 验证目标文件是否包含预期修改
2. 对每个状态为 "pending" 或 "in_progress" 的 todo，说明缺失了什么
3. 如果有测试，用 bash 运行测试验证
4. 输出格式：先列出结论（✅/❌ 各多少项），再对每个失败项给出具体修复建议

注意：验证阶段不允许修改文件（无 edit_file 工具）。`

    // 构建验证专用的消息列表（不污染主 messages）
    type VerifyMsg =
      | { role: 'user' | 'assistant'; content: string }
      | {
          role: 'assistant'
          content: string
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

    const verifyMessages: VerifyMsg[] = [
      ...messages.map((m) => ({ ...m })),
      { role: 'user', content: verifyPrompt },
    ]

    let finalVerifyText = ''

    try {
      for (let step = 0; step < MAX_VERIFY_STEPS; step++) {
        // 检查中断
        if (this.config.abortSignal?.aborted) break

        const genResult = await callWithRetry(
          async () => {
            return await generateText({
              model,
              system:
                '你是验证助手。只读检查执行结果（可用 read_file + grep + bash），不修改文件。每步先说明你要检查什么，然后调用工具。',
              messages: verifyMessages as never,
              tools: verifyToolsForAI,
              maxSteps: 1,
              abortSignal: this.config.abortSignal,
            })
          },
          {
            maxRetries: 1,
            onRetry: ({ attempt, delay, error }) => {
              onEvent({
                type: 'error',
                message: `验证请求重试 #${attempt}（${delay}ms 后）: ${error.message}`,
                recoverable: true,
              })
            },
          },
        )

        const text = genResult.text ?? ''
        const toolCalls = genResult.toolCalls ?? []

        // 无工具调用 → 验证完成，输出结论
        if (toolCalls.length === 0) {
          finalVerifyText = text
          break
        }

        // 有工具调用：推入 assistant 消息 + 执行工具 + 推入 tool 结果
        finalVerifyText = text || finalVerifyText
        verifyMessages.push({
          role: 'assistant',
          content: text,
          toolCalls: toolCalls.map((tc, idx) => ({
            toolCallId: `verify-${step}-${tc.toolName}-${idx}`,
            toolName: tc.toolName,
            args: tc.args as Record<string, unknown>,
          })),
        })

        // 执行工具并收集结果
        const toolResults: Array<{
          type: 'tool-result'
          toolCallId: string
          toolName: string
          result: string
        }> = []
        for (let idx = 0; idx < toolCalls.length; idx++) {
          const tc = toolCalls[idx]
          const callId = `verify-${step}-${tc.toolName}-${idx}`
          const args = tc.args as Record<string, unknown>

          onEvent({ type: 'tool_call', tool: tc.toolName, params: args, callId })

          const result = await toolRegistry.execute(tc.toolName, args, { ...toolContext, callId })
          const resultText = result.error ? `[错误] ${result.error}` : result.result

          onEvent({
            type: 'tool_result',
            callId,
            tool: tc.toolName,
            result: result.result,
            error: result.error,
          })
          toolResults.push({
            type: 'tool-result',
            toolCallId: callId,
            toolName: tc.toolName,
            result: resultText,
          })
        }

        verifyMessages.push({ role: 'tool', content: toolResults })
      }

      onEvent({ type: 'system_info', message: '验证完成' })
      return finalVerifyText || '验证完成（无输出）'
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      onEvent({ type: 'error', message: `验证阶段失败: ${msg}`, recoverable: true })
      return `验证失败: ${msg}`
    }
  }

  /**
   * 执行单个工具调用（权限检查 → 执行 → checkpoint → 结果收集）
   * 结果推入 toolResults 数组，由调用方统一组装为 tool 消息
   */
  private async executeSingleToolCall(
    toolCall: { toolName: string; args: Record<string, unknown> },
    messages: Array<
      | { role: 'user' | 'assistant'; content: string }
      | {
          role: 'assistant'
          content: string
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
    >,
    toolResults: Array<{ toolCallId: string; toolName: string; result: string }>,
    callIndex: number,
  ): Promise<void> {
    const { toolRegistry, toolContext, onEvent } = this.config
    const callId = `exec-${this.iterations}-${toolCall.toolName}-${callIndex}`
    const args = toolCall.args as Record<string, unknown>

    onEvent({ type: 'tool_call', tool: toolCall.toolName, params: args, callId })

    // 权限检查
    const approved = await this.checkPermission(toolCall.toolName, args)
    if (!approved) {
      const rejectMsg = '用户拒绝了此操作。请换一种方式完成任务,或解释为什么需要这个操作。'
      // 审批拒绝用 user role（表达“用户不允许”的语义）
      messages.push({ role: 'user', content: `[工具被拒绝 ${toolCall.toolName}]: ${rejectMsg}` })
      toolResults.push({
        toolCallId: callId,
        toolName: toolCall.toolName,
        result: `[拒绝] ${rejectMsg}`,
      })
      onEvent({
        type: 'tool_result',
        callId,
        tool: toolCall.toolName,
        result: '',
        error: rejectMsg,
      })
      return
    }

    // bash 工具受信号量并发限制
    let toolResult: { result: string; error?: string }
    if (toolCall.toolName === 'bash') {
      await this.bashSemaphore.acquire()
      try {
        toolResult = await toolRegistry.execute(toolCall.toolName, args, { ...toolContext, callId })
      } finally {
        this.bashSemaphore.release()
      }
    } else {
      toolResult = await toolRegistry.execute(toolCall.toolName, args, { ...toolContext, callId })
    }

    onEvent({
      type: 'tool_result',
      callId,
      tool: toolCall.toolName,
      result: toolResult.result,
      error: toolResult.error,
    })

    // edit_file 成功后创建 checkpoint
    if (toolCall.toolName === 'edit_file' && !toolResult.error) {
      const checkpoint = await this.config.checkpoint.create(
        `edit: ${args.path}`,
        this.getCurrentTodoId(),
      )
      if (checkpoint) {
        onEvent({ type: 'checkpoint', step: checkpoint.step, message: checkpoint.message })
      }
    }

    // 构建结果文本（包含错误提示）
    let resultText: string
    if (toolResult.error && toolCall.toolName === 'edit_file') {
      const path = (args.path as string) || '(未知文件)'
      const count = (this.consecutiveEditFailures.get(path) || 0) + 1
      this.consecutiveEditFailures.set(path, count)

      let hint = ''
      if (count >= 3) {
        // 连续 3 次失败：自动回滚文件到上一个良好状态
        const rollbackResult = await this.config.checkpoint.rollbackFile(path)
        this.consecutiveEditFailures.set(path, 0)
        if (rollbackResult.success) {
          hint = `\n\n⚠️ 连续 ${count} 次编辑失败，${rollbackResult.message}。\n请重新 read_file 查看文件当前内容，然后制定新的编辑策略。`
          onEvent({ type: 'system_info', message: `自动回滚: ${rollbackResult.message}` })
        } else {
          hint = `\n\n⚠️ 连续 ${count} 次编辑失败。${rollbackResult.message}\n请停下来重新思考策略：\n1. 先用 read_file 查看文件当前内容\n2. 确保 old_string 精准匹配`
        }
      } else if (toolResult.error.includes('未找到匹配') || toolResult.error.includes('不唯一')) {
        hint = `\n💡 提示: 用 read_file 查看 ${path} 当前内容，确保 old_string 唯一且精准匹配（包括空格和缩进）`
      }
      resultText = `[错误] ${toolResult.error}${hint}`
    } else if (toolResult.error) {
      resultText = `[错误] ${toolResult.error}`
    } else {
      resultText = toolResult.result
    }

    // 推入结果收集数组
    toolResults.push({ toolCallId: callId, toolName: toolCall.toolName, result: resultText })

    // edit_file 成功时重置该文件的失败计数
    if (toolCall.toolName === 'edit_file' && !toolResult.error) {
      const path = (args.path as string) || ''
      this.consecutiveEditFailures.set(path, 0)
      this.hasCodeChanges = true
    }

    // 更新 todo 状态
    this.updateTodoProgress(toolCall.toolName, args)
  }

  /** 权限检查（edit_file 审批前生成 diff 预览） */
  private async checkPermission(toolName: string, args: Record<string, unknown>): Promise<boolean> {
    const { permissionMode, requestApproval } = this.config
    const handler = this.config.toolRegistry.get(toolName)

    // 不需要审批的工具直接通过
    if (!handler?.definition.requiresApproval) return true

    // 危险命令无论什么模式都强制审批
    if (toolName === 'bash') {
      const command = args.command as string
      if (requiresForcedApproval(command)) {
        return requestApproval(toolName, args)
      }
    }

    // 按权限模式判断
    let needsApproval = false
    switch (permissionMode) {
      case 'yolo':
        return true
      case 'auto-all':
        return true
      case 'auto-edit':
        if (toolName === 'edit_file') return true
        needsApproval = true
        break
      case 'ask':
      default:
        needsApproval = true
        break
    }

    if (!needsApproval) return true

    // edit_file 审批前生成 diff 预览
    if (toolName === 'edit_file') {
      const diff = await this.previewEditDiff(args)
      return requestApproval(toolName, args, diff ?? undefined)
    }

    return requestApproval(toolName, args)
  }

  /** 为 edit_file 生成审批用的 diff 预览 */
  private async previewEditDiff(args: Record<string, unknown>): Promise<string | null> {
    try {
      const filePath = args.path as string
      const oldString = args.old_string as string
      const newString = args.new_string as string
      if (!filePath || oldString === undefined || newString === undefined) return null

      const fullPath = resolve(this.config.toolContext.projectRoot, filePath)
      const content = await readFile(fullPath, 'utf-8')

      // 检查是否能匹配
      if (oldString !== '' && !content.includes(oldString)) return null

      const newContent = oldString === '' ? newString : content.replace(oldString, newString)
      return generateDiff(filePath, content, newContent)
    } catch {
      return null
    }
  }

  /** 更新 todo 进度（仅自动标记 in_progress；完成由 LLM 通过 update_todo 工具控制） */
  private updateTodoProgress(toolName: string, _args: Record<string, unknown>): void {
    // edit_file 时自动将第一个 pending todo 标记为 in_progress
    const pending = this.todos.find((t) => t.status === 'pending')
    if (pending && toolName === 'edit_file') {
      pending.status = 'in_progress'
      this.stepsSinceProgress = 0
      this.config.onEvent({ type: 'todo_update', todos: this.todos })
      return
    }
    this.stepsSinceProgress++
  }

  private getCurrentTodoId(): string | undefined {
    return this.todos.find((t) => t.status === 'in_progress')?.id
  }

  private formatTodos(): string {
    return this.todos
      .map((t) => {
        const icon = t.status === 'complete' ? '✓' : t.status === 'in_progress' ? '▶' : '○'
        return `${icon} ${t.content}`
      })
      .join('\n')
  }

  getTodos(): Todo[] {
    return this.todos
  }
}

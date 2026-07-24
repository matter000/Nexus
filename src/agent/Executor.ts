/**
 * Execute 阶段
 * ReAct Loop 核心:逐步执行计划,每步可回滚
 */

import { generateText } from 'ai'
import type { LanguageModel } from 'ai'
import type { ChatMessage, NexusEvent, PermissionMode, Plan, Todo } from './types'
import type { ToolRegistry, ToolContext } from '../tools/registry'
import { requiresForcedApproval } from '../sandbox/CommandGuard'
import type { CheckpointManager } from '../sandbox/Checkpoint'

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
- 每完成一个 todo 项,说明完成情况
- 遇到无法解决的问题,诚实说明而不是强行修改`

export interface ExecutorConfig {
  model: LanguageModel
  toolRegistry: ToolRegistry
  toolContext: ToolContext
  checkpoint: CheckpointManager
  maxIterations: number
  permissionMode: PermissionMode
  onEvent: (event: NexusEvent) => void
  /** 审批回调:返回 true=批准, false=拒绝 */
  requestApproval: (tool: string, params: Record<string, unknown>, diff?: string) => Promise<boolean>
}

export class Executor {
  private config: ExecutorConfig
  private todos: Todo[] = []
  private iterations = 0

  constructor(config: ExecutorConfig) {
    this.config = config
  }

  /** 执行计划 */
  async execute(plan: Plan, contextMessages: ChatMessage[]): Promise<string> {
    const { model, toolRegistry, toolContext, maxIterations, onEvent } = this.config

    this.todos = [...plan.todos]
    this.iterations = 0

    onEvent({ type: 'llm_start', phase: 'execute' })
    onEvent({ type: 'todo_update', todos: this.todos })

    // Execute 阶段用全部工具
    const execTools = toolRegistry.getForPhase('execute')
    const toolsForAI: Record<string, { description: string; parameters: unknown }> = {}
    for (const tool of execTools) {
      toolsForAI[tool.definition.name] = {
        description: tool.definition.description,
        parameters: tool.definition.inputSchema as unknown,
      }
    }

    // 构建初始消息
    const planSummary = `## 已批准的计划\n${plan.summary}\n\n步骤:\n${plan.todos.map((t, i) => `${i + 1}. ${t.content}`).join('\n')}`

    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
      ...contextMessages.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      { role: 'user', content: planSummary },
    ]

    let finalText = ''

    // ReAct Loop
    while (this.iterations < maxIterations) {
      this.iterations++

      const result = await generateText({
        model,
        system: EXECUTE_SYSTEM_SUFFIX,
        messages,
        tools: toolsForAI,
        maxSteps: 1,
      })

      // 无工具调用 → 执行完成
      if (!result.toolCalls || result.toolCalls.length === 0) {
        finalText = result.text
        onEvent({ type: 'llm_chunk', text: finalText })
        break
      }

      // 有工具调用
      if (result.text) {
        onEvent({ type: 'llm_chunk', text: result.text })
      }
      messages.push({ role: 'assistant', content: result.text || '' } as never)

      for (const toolCall of result.toolCalls) {
        const callId = `exec-${this.iterations}-${toolCall.toolName}`
        const args = toolCall.args as Record<string, unknown>

        onEvent({ type: 'tool_call', tool: toolCall.toolName, params: args, callId })

        // 权限检查
        const approved = await this.checkPermission(toolCall.toolName, args)
        if (!approved) {
          // 拒绝也是观察:喂回 LLM 让它改道
          const rejectMsg = '用户拒绝了此操作。请换一种方式完成任务,或解释为什么需要这个操作。'
          messages.push({ role: 'user', content: `[工具被拒绝 ${toolCall.toolName}]: ${rejectMsg}` } as never)
          onEvent({ type: 'tool_result', callId, tool: toolCall.toolName, result: '', error: rejectMsg })
          continue
        }

        // 执行工具
        const toolResult = await toolRegistry.execute(toolCall.toolName, args, {
          ...toolContext,
          callId,
        })

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
            this.getCurrentTodoId()
          )
          if (checkpoint) {
            onEvent({ type: 'checkpoint', step: checkpoint.step, message: checkpoint.message })
          }
        }

        // 将结果喂回
        const resultContent = toolResult.error
          ? `[工具错误 ${toolCall.toolName}]: ${toolResult.error}`
          : `[工具结果 ${toolCall.toolName}]: ${toolResult.result}`
        messages.push({ role: 'user', content: resultContent } as never)

        // 更新 todo 状态
        this.updateTodoProgress(toolCall.toolName, args)
      }
    }

    // 达到迭代上限
    if (this.iterations >= maxIterations) {
      finalText = `已达到最大迭代次数 (${maxIterations})。当前进度:\n${this.formatTodos()}`
      onEvent({ type: 'error', message: '达到迭代上限', recoverable: true })
    }

    onEvent({ type: 'todo_update', todos: this.todos })
    return finalText
  }

  /** 权限检查 */
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
    switch (permissionMode) {
      case 'yolo':
        return true
      case 'auto-all':
        return true
      case 'auto-edit':
        if (toolName === 'edit_file') return true
        return requestApproval(toolName, args)
      case 'ask':
      default:
        return requestApproval(toolName, args)
    }
  }

  /** 更新 todo 进度 */
  private updateTodoProgress(toolName: string, args: Record<string, unknown>): void {
    // 找到第一个 pending 的 todo 并标记为 in_progress
    const pending = this.todos.find((t) => t.status === 'pending')
    if (pending && toolName === 'edit_file') {
      pending.status = 'in_progress'
      this.config.onEvent({ type: 'todo_update', todos: this.todos })
    }

    // bash 运行测试成功 → 标记当前 in_progress 为 complete
    if (toolName === 'bash' && !args.command?.toString().includes('test')) {
      const inProgress = this.todos.find((t) => t.status === 'in_progress')
      if (inProgress) {
        inProgress.status = 'complete'
        this.config.onEvent({ type: 'todo_update', todos: this.todos })
      }
    }
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

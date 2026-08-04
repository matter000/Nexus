/**
 * update_todo 工具
 * 允许 LLM 主动更新 TodoList 状态
 * 通过模块级 TodoStore 共享状态，通过 eventBus 通知 UI
 */

import type { Todo, ToolDefinition, ToolResult } from '../agent/types'
import type { ToolContext, ToolHandler } from './registry'

const definition: ToolDefinition = {
  name: 'update_todo',
  description:
    '更新任务进度列表。可以标记任务完成、添加新任务或更新已有任务内容。在完成任务后应主动调用此工具更新状态。',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: '操作类型',
        enum: ['complete', 'add', 'update', 'in_progress', 'cancelled'],
      },
      id: {
        type: 'string',
        description: 'todo 项 ID（complete/update 时必需）',
      },
      content: {
        type: 'string',
        description: '新 todo 内容（add/update 时）',
      },
    },
    required: ['action'],
  },
  requiresApproval: false,
  phase: 'execute',
}

// ─── 工具执行逻辑 ─────────────────────────────────────────────────────────

async function execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const { callId, todos: currentTodos } = context
  const action = params.action as string
  const id = params.id as string | undefined
  const content = params.content as string | undefined

  try {
    switch (action) {
      case 'complete': {
        if (!id) {
          return { callId, tool: 'update_todo', result: '', error: 'complete 操作需要提供 id' }
        }
        const todo = currentTodos.find((t) => t.id === id)
        if (!todo) {
          return { callId, tool: 'update_todo', result: '', error: `未找到 id 为 "${id}" 的 todo` }
        }
        todo.status = 'complete'
        break
      }

      case 'in_progress': {
        if (!id) {
          return { callId, tool: 'update_todo', result: '', error: 'in_progress 操作需要提供 id' }
        }
        const todo = currentTodos.find((t) => t.id === id)
        if (!todo) {
          return { callId, tool: 'update_todo', result: '', error: `未找到 id 为 "${id}" 的 todo` }
        }
        todo.status = 'in_progress'
        break
      }

      case 'cancelled': {
        if (!id) {
          return { callId, tool: 'update_todo', result: '', error: 'cancelled 操作需要提供 id' }
        }
        const todo = currentTodos.find((t) => t.id === id)
        if (!todo) {
          return { callId, tool: 'update_todo', result: '', error: `未找到 id 为 "${id}" 的 todo` }
        }
        todo.status = 'cancelled'
        break
      }

      case 'add': {
        if (!content) {
          return { callId, tool: 'update_todo', result: '', error: 'add 操作需要提供 content' }
        }
        const newId = `todo-${Date.now()}`
        currentTodos.push({ id: newId, content, status: 'pending' })
        break
      }

      case 'update': {
        if (!id) {
          return { callId, tool: 'update_todo', result: '', error: 'update 操作需要提供 id' }
        }
        const todo = currentTodos.find((t) => t.id === id)
        if (!todo) {
          return { callId, tool: 'update_todo', result: '', error: `未找到 id 为 "${id}" 的 todo` }
        }
        if (content) todo.content = content
        break
      }

      default:
        return { callId, tool: 'update_todo', result: '', error: `未知操作: ${action}` }
    }

    // 格式化当前状态返回
    const summary = currentTodos
      .map((t) => {
        const icon =
          t.status === 'complete'
            ? '✓'
            : t.status === 'in_progress'
              ? '▶'
              : t.status === 'cancelled'
                ? '✗'
                : '○'
        return `${icon} [${t.id}] ${t.content}`
      })
      .join('\n')

    return {
      callId,
      tool: 'update_todo',
      result: `Todo 列表已更新:\n${summary}`,
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      callId,
      tool: 'update_todo',
      result: '',
      error: `更新 todo 失败: ${message}`,
    }
  }
}

export const updateTodoTool: ToolHandler = { definition, execute }

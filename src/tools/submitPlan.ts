/**
 * submit_plan 工具
 * 允许 LLM 在 Plan 阶段提交结构化计划
 * 通过模块级 pendingPlan 共享状态，由 Planner 读取
 * 替代旧的 JSON 代码块 regex 解析方式
 */

import type { Plan, Todo } from '../agent/types'
import type { ToolDefinition, ToolResult } from '../agent/types'
import type { ToolHandler, ToolContext } from './registry'

const definition: ToolDefinition = {
  name: 'submit_plan',
  description:
    '提交结构化执行计划。在探索完代码后调用此工具提交计划摘要、步骤列表和待修改文件。调用后规划阶段结束。',
  inputSchema: {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description: '计划摘要（一句话描述整体目标）',
      },
      todos: {
        type: 'array',
        description: '执行步骤列表',
        items: {
          type: 'object',
          description: '步骤对象，包含 id 和 content',
        },
      },
      filesToModify: {
        type: 'array',
        description: '预计需要修改的文件路径列表',
        items: { type: 'string' },
      },
      estimatedSteps: {
        type: 'number',
        description: '预估总步数',
      },
    },
    required: ['summary', 'todos'],
  },
  requiresApproval: false,
  phase: 'plan',
}

// ─── 模块级共享状态 ─────────────────────────────────────────────────────────

let pendingPlan: Plan | null = null

/** 设置待处理的计划（由 submit_plan 工具调用） */
export function setPendingPlan(plan: Plan | null): void {
  pendingPlan = plan
}

/** 获取并清除待处理的计划（由 Planner 调用） */
export function consumePendingPlan(): Plan | null {
  const plan = pendingPlan
  pendingPlan = null
  return plan
}

// ─── 工具执行逻辑 ─────────────────────────────────────────────────────────

async function execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const { callId } = context
  const summary = params.summary as string
  const todosRaw = params.todos as Array<{ id?: string; content?: string }> | undefined
  const filesToModify = (params.filesToModify as string[]) ?? []
  const estimatedSteps = (params.estimatedSteps as number) ?? (todosRaw?.length ?? 0)

  if (!summary || !summary.trim()) {
    return { callId, tool: 'submit_plan', result: '', error: 'summary 不能为空' }
  }
  if (!todosRaw || !Array.isArray(todosRaw) || todosRaw.length === 0) {
    return { callId, tool: 'submit_plan', result: '', error: 'todos 不能为空，至少需要一个执行步骤' }
  }

  const todos: Todo[] = todosRaw.map((t, i) => ({
    id: t.id ?? String(i + 1),
    content: t.content ?? `步骤 ${i + 1}`,
    status: 'pending' as const,
  }))

  const plan: Plan = {
    summary: summary.trim(),
    todos,
    filesToModify,
    estimatedSteps,
  }

  pendingPlan = plan

  const todoSummary = todos.map((t, i) => `${i + 1}. ${t.content}`).join('\n')
  return {
    callId,
    tool: 'submit_plan',
    result: `计划已提交:\n摘要: ${plan.summary}\n步骤:\n${todoSummary}\n文件: ${filesToModify.length > 0 ? filesToModify.join(', ') : '(无)'}`,
  }
}

export const submitPlanTool: ToolHandler = { definition, execute }

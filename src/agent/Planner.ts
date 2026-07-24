/**
 * Plan 阶段
 * 探索代码库 + 生成结构化计划,只用只读工具(read/grep)
 */

import { streamText, generateText } from 'ai'
import type { LanguageModel } from 'ai'
import type { ChatMessage, Plan, Todo, NexusEvent } from './types'
import type { ToolRegistry, ToolContext } from '../tools/registry'

const PLAN_SYSTEM_SUFFIX = `
## 当前阶段: Plan (规划)

你正在规划阶段。你的任务是:
1. 使用 read_file 和 grep 工具探索代码库,理解现有实现
2. 分析用户的需求,确定需要修改哪些文件
3. 生成一个结构化的执行计划

## 输出格式

在探索完成后,输出一个 JSON 格式的计划:

\`\`\`json
{
  "summary": "计划摘要",
  "todos": [
    { "id": "1", "content": "步骤描述", "status": "pending" }
  ],
  "filesToModify": ["path/to/file1.ts", "path/to/file2.ts"],
  "estimatedSteps": 5
}
\`\`\`

注意:
- 计划要具体可执行,每步对应一个明确的文件操作
- 步骤数量合理(通常 3-10 步)
- 先理解再规划,不要凭空猜测文件内容`

export interface PlannerConfig {
  model: LanguageModel
  toolRegistry: ToolRegistry
  toolContext: ToolContext
  maxIterations: number
  onEvent: (event: NexusEvent) => void
}

export class Planner {
  private config: PlannerConfig

  constructor(config: PlannerConfig) {
    this.config = config
  }

  /** 执行 Plan 阶段,返回结构化计划 */
  async plan(userRequest: string, contextMessages: ChatMessage[]): Promise<Plan> {
    const { model, toolRegistry, toolContext, maxIterations, onEvent } = this.config

    onEvent({ type: 'llm_start', phase: 'plan' })

    // Plan 阶段只用只读工具
    const planTools = toolRegistry.getForPhase('plan')
    const toolsForAI: Record<string, { description: string; parameters: unknown }> = {}
    for (const tool of planTools) {
      toolsForAI[tool.definition.name] = {
        description: tool.definition.description,
        parameters: tool.definition.inputSchema as unknown,
      }
    }

    const messages = [
      ...contextMessages.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      { role: 'user' as const, content: userRequest },
    ]

    let iterations = 0
    let lastText = ''

    // ReAct loop for planning (只读探索)
    while (iterations < maxIterations) {
      iterations++

      const result = await generateText({
        model,
        system: PLAN_SYSTEM_SUFFIX,
        messages: messages as Array<{ role: 'user' | 'assistant'; content: string }>,
        tools: toolsForAI,
        maxSteps: 1,
      })

      // 处理工具调用
      if (result.toolCalls && result.toolCalls.length > 0) {
        // 将 assistant 消息加入历史
        messages.push({ role: 'assistant', content: result.text || '' } as never)

        for (const toolCall of result.toolCalls) {
          const callId = `plan-${iterations}-${toolCall.toolName}`
          onEvent({
            type: 'tool_call',
            tool: toolCall.toolName,
            params: toolCall.args as Record<string, unknown>,
            callId,
          })

          const toolResult = await toolRegistry.execute(
            toolCall.toolName,
            toolCall.args as Record<string, unknown>,
            { ...toolContext, callId }
          )

          onEvent({
            type: 'tool_result',
            callId,
            tool: toolCall.toolName,
            result: toolResult.result,
            error: toolResult.error,
          })

          // 将工具结果加入消息
          messages.push({
            role: 'user',
            content: `[工具结果 ${toolCall.toolName}]: ${toolResult.error ?? toolResult.result}`,
          } as never)
        }
        continue
      }

      // 无工具调用,说明规划完成
      lastText = result.text
      break
    }

    onEvent({ type: 'llm_done', text: lastText })

    // 解析计划
    return this.parsePlan(lastText, userRequest)
  }

  /** 从 LLM 输出中解析结构化计划 */
  private parsePlan(text: string, userRequest: string): Plan {
    // 尝试从 JSON 代码块中提取
    const jsonMatch = text.match(/```json\s*\n([\s\S]*?)\n```/)
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]) as Plan
        if (parsed.todos && Array.isArray(parsed.todos)) {
          return {
            summary: parsed.summary ?? userRequest,
            todos: parsed.todos.map((t, i) => ({
              id: t.id ?? String(i + 1),
              content: t.content ?? `步骤 ${i + 1}`,
              status: 'pending' as const,
            })),
            filesToModify: parsed.filesToModify ?? [],
            estimatedSteps: parsed.todos.length,
          }
        }
      } catch {
        // JSON 解析失败,回退到简单计划
      }
    }

    // 回退:生成简单计划
    return {
      summary: userRequest,
      todos: [
        { id: '1', content: '分析需求并探索相关代码', status: 'pending' },
        { id: '2', content: '实施修改', status: 'pending' },
        { id: '3', content: '验证修改正确性', status: 'pending' },
      ],
      filesToModify: [],
      estimatedSteps: 3,
    }
  }
}

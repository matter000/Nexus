/**
 * 工具的 Zod Schema 定义
 * Vercel AI SDK 的 generateText 要求 parameters 为 Zod schema
 */

import { jsonSchema } from 'ai'
import { z } from 'zod'

export const readFileSchema = z.object({
  path: z.string().describe('要读取的文件路径(相对于项目根目录)'),
  start_line: z.number().optional().describe('起始行号(可选,从 1 开始)'),
  end_line: z.number().optional().describe('结束行号(可选)'),
})

export const editFileSchema = z.object({
  path: z.string().describe('要编辑的文件路径(相对于项目根目录)'),
  old_string: z
    .string()
    .describe('要替换的原文,必须在文件中唯一匹配。包含足够上下文以确保唯一性。'),
  new_string: z.string().describe('替换后的新内容'),
})

export const bashSchema = z.object({
  command: z.string().describe('要执行的 shell 命令'),
  timeout: z.number().optional().describe('超时时间(秒),默认 30'),
})

export const grepSchema = z.object({
  pattern: z.string().describe('搜索模式(支持正则表达式)'),
  path: z.string().optional().describe('搜索路径(相对于项目根目录,默认为整个项目)'),
  include: z.string().optional().describe('文件名 glob 过滤(如 "*.ts", "*.{js,jsx}")'),
  context_lines: z.number().optional().describe('显示匹配行前后的上下文行数(默认 0)'),
  case_insensitive: z.boolean().optional().describe('是否忽略大小写(默认 false)'),
})

export const globSchema = z.object({
  pattern: z.string().describe('glob 模式(如 **/*.ts、src/**/*.test.ts)'),
  path: z.string().optional().describe('搜索根目录(相对于项目根目录,默认为项目根目录)'),
})

export const updateTodoSchema = z.object({
  action: z.enum(['complete', 'add', 'update', 'in_progress', 'cancelled']).describe('操作类型'),
  id: z.string().optional().describe('todo 项 ID(complete/update/in_progress/cancelled 时必需)'),
  content: z.string().optional().describe('新 todo 内容(add/update 时)'),
})

export const updateNotesSchema = z.object({
  action: z
    .enum(['read', 'append', 'replace'])
    .describe('read=读取全部笔记; append=追加内容; replace=整体替换为精炼版'),
  content: z.string().optional().describe('append/replace 时写入的内容'),
})

export const semanticSearchSchema = z.object({
  query: z.string().describe('搜索查询(自然语言或代码片段)'),
  top_k: z.number().optional().describe('返回结果数量(默认 5)'),
})

export const listDirectorySchema = z.object({
  path: z.string().optional().describe('目标目录路径(相对于项目根目录,默认为项目根目录)'),
  recursive: z.boolean().optional().describe('是否递归列出子目录(默认 false)'),
  pattern: z.string().optional().describe('文件名过滤模式(简单的子串匹配)'),
})

export const searchSymbolSchema = z.object({
  symbol: z.string().describe('要搜索的符号名称(如 "ToolHandler", "createToolRegistry")'),
  type: z
    .enum(['definition', 'reference', 'all'])
    .optional()
    .describe('搜索类型: definition(定义), reference(引用), all(全部,默认)'),
})

export const lspSchema = z.object({
  action: z
    .enum(['definition', 'references', 'diagnostics'])
    .describe('definition=定义跳转; references=引用查找; diagnostics=语义诊断'),
  path: z.string().describe('目标文件路径（相对于项目根目录）'),
  symbol: z.string().optional().describe('符号名（definition/references 用）'),
  line: z.number().optional().describe('行号（1 起，可选替代 symbol）'),
})

export const fetchUrlSchema = z.object({
  url: z.string().describe('目标 URL(必须是 http 或 https 协议)'),
  max_length: z.number().optional().describe('最大返回字符数(默认 10000)'),
})

export const submitPlanSchema = z.object({
  summary: z.string().describe('计划摘要（一句话描述整体目标）'),
  todos: z
    .array(
      z.object({
        id: z.string().optional().describe('步骤 ID（如 "1", "2"）'),
        content: z.string().describe('步骤描述'),
      }),
    )
    .describe('执行步骤列表'),
  filesToModify: z.array(z.string()).optional().describe('预计需要修改的文件路径列表'),
  estimatedSteps: z.number().optional().describe('预估总步数'),
})

export const gitStatusSchema = z.object({})

export const gitCommitSchema = z.object({
  message: z.string().describe('提交信息'),
  files: z.string().optional().describe('要暂存的文件路径（可选，多个文件用空格分隔）'),
})

export const gitPushSchema = z.object({
  remote: z.string().optional().describe('远程仓库名（默认 origin）'),
  branch: z.string().optional().describe('要推送的分支名'),
  force: z.boolean().optional().describe('是否强制推送（默认 false）'),
})

export const webSearchSchema = z.object({
  query: z.string().describe('搜索关键词'),
  count: z.number().optional().describe('返回结果数量（默认 5，最大 10）'),
})

export const dispatchSubagentSchema = z.object({
  description: z.string().describe('子任务的详细描述'),
  writable: z.boolean().optional().describe('是否允许子 Agent 修改文件(默认 false)'),
  tools: z.array(z.string()).optional().describe('允许使用的工具列表(默认根据 writable 自动选择)'),
  isolation: z
    .enum(['worktree'])
    .optional()
    .describe(
      '隔离模式：worktree = 在独立 git worktree 中执行（写任务并行防踩脚，完成后需审批合并）',
    ),
})

export const createFileSchema = z.object({
  path: z.string().describe('要创建的文件路径（相对于项目根目录）'),
  content: z.string().describe('文件内容'),
})

export const dispatchSubagentsSchema = z.object({
  tasks: z
    .array(
      z.object({
        description: z.string().describe('子任务的详细描述'),
        writable: z.boolean().optional().describe('是否允许子 Agent 修改文件(默认 false)'),
        tools: z.array(z.string()).optional().describe('允许使用的工具列表'),
        isolation: z.enum(['worktree']).optional().describe('worktree 隔离（写任务并行防踩脚）'),
      }),
    )
    .describe('子任务数组，最多 3 个并行'),
})

export const dispatchAgentSchema = z.object({
  engine: z.string().describe('子智能体引擎名（如 explorer/coder/reviewer/researcher）'),
  description: z.string().describe('子任务的详细描述'),
  writable: z.boolean().optional().describe('是否允许修改文件(覆盖引擎默认值)'),
  tools: z.array(z.string()).optional().describe('允许使用的工具列表(覆盖引擎默认值)'),
  input: z.string().optional().describe('可选的上游输入/上下文'),
})

export const dispatchAgentsSchema = z.object({
  tasks: z
    .array(
      z.object({
        engine: z.string().describe('子智能体引擎名'),
        description: z.string().describe('子任务的详细描述'),
        writable: z.boolean().optional().describe('是否允许修改文件(覆盖引擎默认值)'),
        tools: z.array(z.string()).optional().describe('允许使用的工具列表(覆盖引擎默认值)'),
        isolation: z.enum(['worktree']).optional().describe('worktree 隔离（写任务并行防踩脚）'),
      }),
    )
    .describe('引擎任务数组，最多 3 个并行'),
})

export const teamTaskListSchema = z.object({})

export const teamTaskClaimSchema = z.object({
  agent_id: z.string().describe('认领者 ID（主 Agent 用 lead）'),
  task_id: z.string().optional().describe('指定认领的任务 ID（缺省认领第一条待认领任务）'),
})

export const sendMessageSchema = z.object({
  from: z.string().describe('发送者 ID'),
  to: z.string().describe('接收者 agent ID'),
  content: z.string().describe('消息内容'),
})

export const readMessagesSchema = z.object({
  agent_id: z.string().describe('要读取信箱的 agent ID'),
})

export const runPipelineSchema = z.object({
  steps: z
    .array(
      z.object({
        engine: z.string().describe('子智能体引擎名'),
        description: z.string().describe('本步骤的任务描述'),
        writable: z.boolean().optional().describe('是否允许修改文件(覆盖引擎默认值)'),
        tools: z.array(z.string()).optional().describe('允许使用的工具列表(覆盖引擎默认值)'),
      }),
    )
    .describe('流水线步骤数组，按顺序执行'),
  input: z.string().optional().describe('初始输入（可选）'),
})

/** 工具名 → Zod Schema 映射 */
export const toolSchemas: Record<string, z.ZodType> = {
  read_file: readFileSchema,
  edit_file: editFileSchema,
  bash: bashSchema,
  grep: grepSchema,
  glob: globSchema,
  update_todo: updateTodoSchema,
  update_notes: updateNotesSchema,
  semantic_search: semanticSearchSchema,
  list_directory: listDirectorySchema,
  search_symbol: searchSymbolSchema,
  lsp: lspSchema,
  fetch_url: fetchUrlSchema,
  submit_plan: submitPlanSchema,
  dispatch_subagent: dispatchSubagentSchema,
  git_status: gitStatusSchema,
  git_commit: gitCommitSchema,
  git_push: gitPushSchema,
  web_search: webSearchSchema,
  create_file: createFileSchema,
  dispatch_subagents: dispatchSubagentsSchema,
  dispatch_agent: dispatchAgentSchema,
  dispatch_agents: dispatchAgentsSchema,
  run_pipeline: runPipelineSchema,
  team_task_list: teamTaskListSchema,
  team_task_claim: teamTaskClaimSchema,
  send_message: sendMessageSchema,
  read_messages: readMessagesSchema,
}

/**
 * 生成 AI SDK 接受的 tool parameters。
 * 优先使用 zod schema；仅有裸 JSON Schema 的工具必须经 jsonSchema() 包装——
 * 裸 JSON Schema 对象直接作为 parameters 传入时，AI SDK 会静默放弃整个请求
 * （不发网络请求、不抛错、流空结束），表现为 Agent 永久“空响应”。
 */
export function resolveToolParameters(name: string, rawInputSchema: unknown): unknown {
  return toolSchemas[name] ?? jsonSchema(rawInputSchema as Parameters<typeof jsonSchema>[0])
}

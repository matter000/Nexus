/**
 * 工具的 Zod Schema 定义
 * Vercel AI SDK 的 generateText 要求 parameters 为 Zod schema
 */

import { z } from 'zod'

export const readFileSchema = z.object({
  path: z.string().describe('要读取的文件路径(相对于项目根目录)'),
  start_line: z.number().optional().describe('起始行号(可选,从 1 开始)'),
  end_line: z.number().optional().describe('结束行号(可选)'),
})

export const editFileSchema = z.object({
  path: z.string().describe('要编辑的文件路径(相对于项目根目录)'),
  old_string: z.string().describe('要替换的原文,必须在文件中唯一匹配。包含足够上下文以确保唯一性。'),
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
  type: z.enum(['definition', 'reference', 'all']).optional().describe('搜索类型: definition(定义), reference(引用), all(全部,默认)'),
})

export const fetchUrlSchema = z.object({
  url: z.string().describe('目标 URL(必须是 http 或 https 协议)'),
  max_length: z.number().optional().describe('最大返回字符数(默认 10000)'),
})

export const submitPlanSchema = z.object({
  summary: z.string().describe('计划摘要（一句话描述整体目标）'),
  todos: z.array(z.object({
    id: z.string().optional().describe('步骤 ID（如 "1", "2"）'),
    content: z.string().describe('步骤描述'),
  })).describe('执行步骤列表'),
  filesToModify: z.array(z.string()).optional().describe('预计需要修改的文件路径列表'),
  estimatedSteps: z.number().optional().describe('预估总步数'),
})

export const dispatchSubagentSchema = z.object({
  description: z.string().describe('子任务的详细描述'),
  writable: z.boolean().optional().describe('是否允许子 Agent 修改文件(默认 false)'),
  tools: z.array(z.string()).optional().describe('允许使用的工具列表(默认根据 writable 自动选择)'),
})

/** 工具名 → Zod Schema 映射 */
export const toolSchemas: Record<string, z.ZodType> = {
  read_file: readFileSchema,
  edit_file: editFileSchema,
  bash: bashSchema,
  grep: grepSchema,
  glob: globSchema,
  update_todo: updateTodoSchema,
  semantic_search: semanticSearchSchema,
  list_directory: listDirectorySchema,
  search_symbol: searchSymbolSchema,
  fetch_url: fetchUrlSchema,
  submit_plan: submitPlanSchema,
  dispatch_subagent: dispatchSubagentSchema,
}

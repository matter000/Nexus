/**
 * 任务加载器 — 从 .toml 文件或目录加载 EvalTask[]
 */

import { readdir, readFile, stat } from 'fs/promises'
import { extname, join } from 'path'
import { parse } from 'smol-toml'
import type { EvalTask, InitialFile, ValidateRule } from './types'

/**
 * 从目录或单个文件加载任务
 * @param tasksDir 任务目录路径或单个 .toml 文件路径
 */
export async function loadTasks(tasksDir: string): Promise<EvalTask[]> {
  const tasks: EvalTask[] = []

  const s = await stat(tasksDir)
  if (s.isDirectory()) {
    const entries = await readdir(tasksDir)
    for (const entry of entries.sort()) {
      if (!entry.endsWith('.toml')) continue
      const task = await loadTaskFile(join(tasksDir, entry))
      if (task) tasks.push(task)
    }
  } else if (tasksDir.endsWith('.toml')) {
    const task = await loadTaskFile(tasksDir)
    if (task) tasks.push(task)
  }

  return tasks
}

/** 加载单个 .toml 任务文件 */
async function loadTaskFile(filePath: string): Promise<EvalTask | null> {
  try {
    const content = await readFile(filePath, 'utf-8')
    const raw = parse(content) as Record<string, unknown>
    return parseRawTask(raw, filePath)
  } catch (err) {
    console.error(`[TaskLoader] 解析 ${filePath} 失败: ${err instanceof Error ? err.message : err}`)
    return null
  }
}

/** 将 TOML 原始数据转换为 EvalTask */
function parseRawTask(raw: Record<string, unknown>, filePath: string): EvalTask | null {
  const id = raw.id as Record<string, string> | undefined
  const request = raw.request as Record<string, string> | undefined
  const initialFiles = raw.initial_files as Array<Record<string, string>> | undefined
  const validate = raw.validate as Array<Record<string, string>> | undefined

  if (!id?.name) {
    console.error(`[TaskLoader] ${filePath}: 缺少 id.name`)
    return null
  }
  if (!request?.user_prompt) {
    console.error(`[TaskLoader] ${filePath}: 缺少 request.user_prompt`)
    return null
  }
  if (!initialFiles || !Array.isArray(initialFiles) || initialFiles.length === 0) {
    console.error(`[TaskLoader] ${filePath}: 缺少 initial_files`)
    return null
  }
  if (!validate || !Array.isArray(validate) || validate.length === 0) {
    console.error(`[TaskLoader] ${filePath}: 缺少 validate`)
    return null
  }

  const taskId = id.id ?? id.name.toLowerCase().replace(/\s+/g, '-')

  const files: InitialFile[] = initialFiles.map((f) => ({
    path: f.path,
    content: f.content ?? '',
  }))

  const rules: ValidateRule[] = validate
    .map((r): ValidateRule | null => {
      const type = r.type
      switch (type) {
        case 'file_exists':
          return { type: 'file_exists', path: r.path }
        case 'file_not_exists':
          return { type: 'file_not_exists', path: r.path }
        case 'file_contains':
          if (!r.pattern) return null
          return { type: 'file_contains', path: r.path, pattern: r.pattern }
        case 'file_not_contains':
          if (!r.pattern) return null
          return { type: 'file_not_contains', path: r.path, pattern: r.pattern }
        case 'bash_pass':
          if (!r.command) return null
          return { type: 'bash_pass', command: r.command }
        case 'bash_output_contains':
          if (!r.command || !r.pattern) return null
          return { type: 'bash_output_contains', command: r.command, pattern: r.pattern }
        default:
          console.error(`[TaskLoader] ${filePath}: 未知验证类型 "${type}"`)
          return null
      }
    })
    .filter((r): r is ValidateRule => r !== null)

  if (rules.length === 0) {
    console.error(`[TaskLoader] ${filePath}: 没有有效的验证规则`)
    return null
  }

  return {
    id: taskId,
    name: id.name,
    category: (id.category as EvalTask['category']) ?? 'single-file',
    difficulty: (id.difficulty as EvalTask['difficulty']) ?? 'easy',
    description: id.description ?? id.name,
    initialFiles: files,
    userRequest: request.user_prompt,
    validate: rules,
  }
}

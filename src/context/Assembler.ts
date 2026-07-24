/**
 * 上下文组装器
 * 三层上下文组装: L1(静态) + L2(任务) + L3(检索)
 * 组装前进行 token 预算检查,超预算按优先级裁剪
 */

import { readFile } from 'fs/promises'
import { spawn } from 'child_process'
import { join } from 'path'
import type { ChatMessage, ProjectRules, Todo } from '../agent/types'
import type { ToolHandler } from '../tools/registry'
import { estimateTokens, TokenBudget } from './TokenBudget'
import { compressHistory } from './Compressor'
import { formatRulesForPrompt } from './RulesLoader'

const SYSTEM_PROMPT_BASE = `你是 Nexus,一个运行在终端的 AI 编程助手。

## 核心原则
- 上下文为王:先充分理解代码再动手
- 工具为先:用工具验证,不靠猜测
- 人在环中:关键操作请求审批
- 可验证:改完要跑测试确认

## 工作方式
1. Plan 阶段:只用 read_file 和 grep 探索代码,生成结构化计划
2. Execute 阶段:按计划逐步执行,每步用 edit_file 精准修改
3. 验证:修改后运行测试确认正确性

## 工具使用规范
- edit_file: old_string 必须唯一匹配,包含足够上下文行
- bash: 用于运行测试、安装依赖等,不用于文件操作
- grep: 用于搜索代码,找到相关文件
- read_file: 用于读取文件内容,了解现有实现

## 输出规范
- 简洁专业,关键决策才解释
- 修改代码时说明改了什么、为什么
- 遇到问题主动说明,不隐瞒`

export interface AssemblerConfig {
  projectRoot: string
  rules: ProjectRules
  tools: ToolHandler[]
  budget: TokenBudget
  recentTurnsKeep: number
}

export class ContextAssembler {
  private config: AssemblerConfig

  constructor(config: AssemblerConfig) {
    this.config = config
  }

  /** 构建 system prompt (L1 静态上下文) */
  async buildSystemPrompt(todos?: Todo[]): Promise<string> {
    const parts: string[] = [SYSTEM_PROMPT_BASE]

    // 项目规则
    parts.push(formatRulesForPrompt(this.config.rules))

    // 工具说明
    parts.push('\n## 可用工具')
    for (const tool of this.config.tools) {
      parts.push(`- ${tool.definition.name}: ${tool.definition.description}`)
    }

    // Git 状态
    const gitStatus = await this.getGitStatus()
    if (gitStatus) {
      parts.push(`\n## 当前 Git 状态\n${gitStatus}`)
    }

    // 项目骨架树
    const tree = await this.getProjectTree()
    if (tree) {
      parts.push(`\n## 项目结构\n\`\`\`\n${tree}\n\`\`\``)
    }

    // Todos
    if (todos && todos.length > 0) {
      parts.push('\n## 当前任务进度')
      for (const todo of todos) {
        const icon = todo.status === 'complete' ? '✓' : todo.status === 'in_progress' ? '▶' : '○'
        parts.push(`${icon} ${todo.content}`)
      }
    }

    return parts.join('\n')
  }

  /** 组装完整消息列表(带压缩) */
  assembleMessages(
    systemPrompt: string,
    history: ChatMessage[],
    userInput: string
  ): ChatMessage[] {
    const budget = this.config.budget
    const allocation = budget.allocate()

    // 检查 system prompt 是否超预算
    const systemTokens = estimateTokens(systemPrompt)

    // 压缩历史
    const historyBudget = allocation.history
    const compressed = compressHistory(history, this.config.recentTurnsKeep, historyBudget)

    // 组装最终消息
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...compressed.messages,
      { role: 'user', content: userInput },
    ]

    return messages
  }

  /** 获取 git 状态 */
  private async getGitStatus(): Promise<string | null> {
    try {
      const result = await this.exec('git', ['status', '--short', '--branch'])
      if (result.exitCode !== 0) return null
      const lines = result.stdout.split('\n').filter(Boolean)
      if (lines.length === 0) return '工作区干净'
      // 最多显示 20 行
      const display = lines.slice(0, 20)
      if (lines.length > 20) display.push(`... 还有 ${lines.length - 20} 个变更`)
      return display.join('\n')
    } catch {
      return null
    }
  }

  /** 获取项目目录树(排除 node_modules 等) */
  private async getProjectTree(): Promise<string | null> {
    try {
      // 尝试使用 tree 命令,不可用时用 git ls-files
      const result = await this.exec('git', ['ls-files'])
      if (result.exitCode !== 0) return null

      const files = result.stdout.split('\n').filter(Boolean)
      if (files.length === 0) return null

      // 构建树结构(最多显示 50 个文件)
      const display = files.slice(0, 50)
      if (files.length > 50) {
        display.push(`... 还有 ${files.length - 50} 个文件`)
      }
      return display.join('\n')
    } catch {
      return null
    }
  }

  /** 读取常驻上下文文件 */
  async loadAlwaysIncludeFiles(paths: string[]): Promise<string> {
    const parts: string[] = []
    for (const filePath of paths) {
      try {
        const content = await readFile(filePath, 'utf-8')
        const truncated = content.length > 3000 ? content.slice(0, 3000) + '\n...(已截断)' : content
        parts.push(`### ${filePath}\n\`\`\`\n${truncated}\n\`\`\``)
      } catch {
        // 文件不存在则跳过
      }
    }
    return parts.join('\n\n')
  }

  private exec(cmd: string, args: string[]): Promise<{ stdout: string; exitCode: number }> {
    return new Promise((resolve) => {
      const child = spawn(cmd, args, {
        cwd: this.config.projectRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(process.platform === 'win32' ? { windowsHide: true } : {}),
      })
      let stdout = ''
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
      child.on('close', (code) => resolve({ stdout: stdout.trim(), exitCode: code ?? 1 }))
      child.on('error', () => resolve({ stdout: '', exitCode: 1 }))
    })
  }
}

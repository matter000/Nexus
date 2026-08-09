/**
 * 上下文组装器
 * 三层上下文组装: L1(静态) + L2(任务) + L3(检索)
 * 组装前进行 token 预算检查,超预算按优先级裁剪
 */

import { spawn } from 'child_process'
import { readFile } from 'fs/promises'
import type { ChatMessage, ProjectRules, Todo } from '../agent/types'
import type { RetrievedLesson } from '../memory/LessonRetriever'
import type { SkillReader, ToolHandler } from '../tools/registry'
import { type CodeGraph, formatGraphForContext } from './CodeGraph'
import { compressHistory } from './Compressor'
import { formatRulesForPrompt, getAlwaysIncludePaths } from './RulesLoader'
import { estimateTokens, type TokenBudget } from './TokenBudget'

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

/** 教训检索接口（由 Orchestrator 注入 LessonRetriever 实现） */
export interface LessonProvider {
  retrieve(query: string, topK?: number): Promise<RetrievedLesson[]>
}

/** 注入系统提示的教训条数上限与总 token 硬上限（防记忆库膨胀稀释上下文） */
const LESSONS_TOP_K = 3
const LESSONS_MAX_TOKENS = 300

/** 注入系统提示的技能元数据上限（Agent Skills 渐进式披露 L1：只放索引不放正文） */
const SKILLS_TOP_K = 8
const SKILLS_MAX_TOKENS = 250

/** 项目树节点（内存目录树） */
interface TreeNode {
  dirs: Map<string, TreeNode>
  fileCount: number
}

/** 递归统计子树内文件总数 */
function countTreeFiles(node: TreeNode): number {
  let n = node.fileCount
  for (const child of node.dirs.values()) n += countTreeFiles(child)
  return n
}

/**
 * 把文件路径列表渲染为目录树：深度 2 以内完整展开，
 * 更深层或叶子目录折叠为文件计数；限制总行数防大仓库撞爆 L1 上下文。
 */
export function formatFileTree(files: string[], maxLines = 80): string {
  const root: TreeNode = { dirs: new Map(), fileCount: 0 }
  for (const file of files) {
    const parts = file.split('/')
    let node = root
    for (let i = 0; i < parts.length - 1; i++) {
      let child = node.dirs.get(parts[i])
      if (!child) {
        child = { dirs: new Map(), fileCount: 0 }
        node.dirs.set(parts[i], child)
      }
      node = child
    }
    node.fileCount++
  }

  const lines: string[] = []
  const walk = (node: TreeNode, indent: string, depth: number): boolean => {
    const names = [...node.dirs.keys()].sort()
    for (const name of names) {
      if (lines.length >= maxLines) return false
      const child = node.dirs.get(name) as TreeNode
      const total = countTreeFiles(child)
      // 叶子目录或深度超限：折叠为文件计数，避免深层嵌套树爆炸
      if (child.dirs.size === 0 || depth >= 2) {
        lines.push(`${indent}${name}/ (${total} 文件)`)
      } else {
        lines.push(`${indent}${name}/`)
        if (!walk(child, `${indent}  `, depth + 1)) return false
      }
    }
    if (node.fileCount > 0 && lines.length < maxLines) {
      lines.push(`${indent}(${node.fileCount} 个根级文件)`)
    }
    return true
  }

  const complete = walk(root, '', 0)
  if (!complete) lines.push(`... 已截断（共 ${files.length} 个文件）`)
  return lines.join('\n')
}

export class ContextAssembler {
  private config: AssemblerConfig
  private codeGraph: CodeGraph | null = null
  private lessonProvider: LessonProvider | null = null

  constructor(config: AssemblerConfig) {
    this.config = config
  }

  /** 设置代码图谱实例（由 Orchestrator 在图谱构建完成后调用） */
  setCodeGraph(graph: CodeGraph | null): void {
    this.codeGraph = graph
  }

  /** 设置教训检索器（由 Orchestrator 在学习系统初始化后调用） */
  setLessonRetriever(provider: LessonProvider | null): void {
    this.lessonProvider = provider
  }

  /** 技能读取器（注入 active 技能元数据用，由 Orchestrator 注入） */
  private skillProvider: SkillReader | null = null

  /** 设置技能读取器 */
  setSkillProvider(provider: SkillReader | null): void {
    this.skillProvider = provider
  }

  /**
   * 构建 system prompt (L1 静态上下文)，stable/dynamic 拼接后的完整字符串。
   * 兼容旧调用方；新调用方应优先用 buildSystemPromptParts（前缀缓存友好）。
   */
  async buildSystemPrompt(
    todos?: Todo[],
    currentQuery?: string,
    historyTokensEstimate = 0,
  ): Promise<string> {
    const { stable, dynamic } = await this.buildSystemPromptParts(
      todos,
      currentQuery,
      historyTokensEstimate,
    )
    return dynamic ? `${stable}\n${dynamic}` : stable
  }

  /**
   * 构建 system prompt 的稳定/动态两段（Anthropic 前缀缓存友好）：
   * - stable：逐轮不变（基础指令 + 项目规则 + 工具说明 + 技能索引），
   *   作为 Anthropic cacheControl 断点前的可缓存前缀，不得含时间戳/会话变量
   * - dynamic：每轮变化（常驻文件/项目树/代码地图/todos/教训/git 状态），置于断点之后
   * @param historyTokensEstimate 当前历史占用 token 估算（代码地图动态扩容用）
   */
  async buildSystemPromptParts(
    todos?: Todo[],
    currentQuery?: string,
    historyTokensEstimate = 0,
  ): Promise<{ stable: string; dynamic: string }> {
    // ─── stable 段 ───
    const stableParts: string[] = [SYSTEM_PROMPT_BASE]

    // 项目规则
    stableParts.push(formatRulesForPrompt(this.config.rules))

    // 工具说明
    stableParts.push('\n## 可用工具')
    for (const tool of this.config.tools) {
      stableParts.push(`- ${tool.definition.name}: ${tool.definition.description}`)
    }

    // 可用技能元数据（Agent Skills L1 发现层：name+description 常驻，正文由 load_skill 按需加载）
    const skillsSection = this.buildSkillsSection()
    if (skillsSection) {
      stableParts.push(skillsSection)
    }

    // ─── dynamic 段 ───
    const dynamicParts: string[] = []

    // 常驻上下文文件（文件内容可能随编辑变化，归入 dynamic 保护缓存前缀）
    const alwaysIncludePaths = getAlwaysIncludePaths(this.config.rules, this.config.projectRoot)
    if (alwaysIncludePaths.length > 0) {
      const alwaysIncludeContent = await this.loadAlwaysIncludeFiles(alwaysIncludePaths)
      if (alwaysIncludeContent) {
        dynamicParts.push('\n## 常驻参考文件')
        dynamicParts.push(alwaysIncludeContent)
      }
    }

    // 项目骨架树
    const tree = await this.getProjectTree()
    if (tree) {
      dynamicParts.push(`\n## 项目结构\n\`\`\`\n${tree}\n\`\`\``)
    }

    // 代码地图（来自 CodeGraph，注入 L1 上下文）
    if (this.codeGraph) {
      const graphText = formatGraphForContext(this.codeGraph)
      if (graphText) {
        const maxGraphTokens = this.computeGraphBudget(historyTokensEstimate)
        const graphTokens = estimateTokens(graphText)
        if (graphTokens > maxGraphTokens) {
          // 截断到预算范围内
          const charsPerToken = 4
          const maxChars = maxGraphTokens * charsPerToken
          dynamicParts.push(
            `\n${graphText.slice(0, maxChars)}\n...（代码图谱过大，已截断：${graphTokens} tokens → ${maxGraphTokens} tokens）`,
          )
        } else {
          dynamicParts.push(`\n${graphText}`)
        }
      }
    }

    // Todos
    if (todos && todos.length > 0) {
      dynamicParts.push('\n## 当前任务进度')
      for (const todo of todos) {
        const icon = todo.status === 'complete' ? '✓' : todo.status === 'in_progress' ? '▶' : '○'
        dynamicParts.push(`${icon} ${todo.content}`)
      }
    }

    // 历史经验教训（学习系统注入，按当前任务语义检索 top-K）
    if (currentQuery && this.lessonProvider) {
      const lessonsSection = await this.buildLessonsSection(currentQuery)
      if (lessonsSection) {
        dynamicParts.push(lessonsSection)
      }
    }

    // Git 状态（变化最频繁，放最末尾）
    const gitStatus = await this.getGitStatus()
    if (gitStatus) {
      dynamicParts.push(`\n## 当前 Git 状态\n${gitStatus}`)
    }

    return { stable: stableParts.join('\n'), dynamic: dynamicParts.join('\n') }
  }

  /**
   * 检索历史经验教训并注入 system prompt（top-K + 300 tokens 硬上限）。
   * 失败时返回空字符串，保持旁路不阻塞主流程。
   */
  private async buildLessonsSection(query: string): Promise<string> {
    try {
      const lessons = await this.lessonProvider?.retrieve(query, LESSONS_TOP_K)
      if (!lessons || lessons.length === 0) return ''
      const lines = lessons.map((r) => {
        const kindTag = r.lesson.kind === 'failure_pattern' ? '失败模式' : '成功策略'
        return `- [${kindTag}] ${r.lesson.triggerDesc} → ${r.lesson.advice}`
      })
      let section = `\n## 历史经验教训\n${lines.join('\n')}`
      if (estimateTokens(section) > LESSONS_MAX_TOKENS) {
        const maxChars = LESSONS_MAX_TOKENS * 4
        section = section.slice(0, maxChars) + '\n...（经验教训已截断）'
      }
      return section
    } catch {
      return ''
    }
  }

  /**
   * 构建可用技能索引区块（仅 active 技能的 name+description，token 硬上限）。
   * 渐进式披露：模型按描述判断任务是否匹配，匹配时调 load_skill 取完整指令。
   */
  private buildSkillsSection(): string {
    try {
      const skills = this.skillProvider?.listActiveSkillMeta() ?? []
      if (skills.length === 0) return ''
      const lines = skills
        .slice(0, SKILLS_TOP_K)
        .map((s) => `- ${s.name}: ${s.description || '(无描述)'}`)
      let section = `\n## 可用技能\n任务与某技能匹配时，先调用 load_skill 工具加载完整指令再行动（不要凭空猜测流程）:\n${lines.join('\n')}`
      if (skills.length > SKILLS_TOP_K) {
        section += `\n...（共 ${skills.length} 个技能，仅显示前 ${SKILLS_TOP_K} 个）`
      }
      if (estimateTokens(section) > SKILLS_MAX_TOKENS) {
        section = `${section.slice(0, SKILLS_MAX_TOKENS * 4)}\n...(技能列表已截断)`
      }
      return section
    } catch {
      return ''
    }
  }

  /**
   * 代码地图注入预算（需求驱动）：
   * 基础 = system 预算的 20%；当历史占用低于其预算 50% 时，
   * 额外补贴 history 闲置部分的 30%（新会话窗口不闲置，模型一次看到更全的代码骨架）。
   */
  private computeGraphBudget(historyTokensEstimate: number): number {
    const allocation = this.config.budget.allocate()
    const base = Math.floor(allocation.systemPrompt * 0.2)
    if (historyTokensEstimate < allocation.history * 0.5) {
      return base + Math.floor(Math.max(0, allocation.history - historyTokensEstimate) * 0.3)
    }
    return base
  }

  /** 组装完整消息列表(带压缩) */
  assembleMessages(systemPrompt: string, history: ChatMessage[], userInput: string): ChatMessage[] {
    const budget = this.config.budget
    const allocation = budget.allocate()

    // 1. 检查 system prompt 是否超预算，超预算则裁剪
    const trimmedSystemPrompt = this.trimSystemPrompt(systemPrompt, allocation.systemPrompt)

    // 2. 预算动态回流：system 实际用不满的部分并入 history 预算
    //    （静态 25/75 分配在新会话会大量闲置窗口，需求驱动分配提高利用率）
    const systemTokensUsed = estimateTokens(trimmedSystemPrompt)
    const historyBudget =
      allocation.history + Math.max(0, allocation.systemPrompt - systemTokensUsed)

    // 3. 压缩历史（使用动态 history 预算）
    // 注：history 中不再存在原始 tool 消息（工具轨迹由 Orchestrator 压缩为摘要后注入），
    // 因此无需逐条压缩工具结果
    const compressed = compressHistory(history, this.config.recentTurnsKeep, historyBudget)

    // 组装最终消息
    const messages: ChatMessage[] = [
      { role: 'system', content: trimmedSystemPrompt },
      ...compressed.messages,
      { role: 'user', content: userInput },
    ]

    return messages
  }

  /**
   * 组装消息列表（stable/dynamic 双 system 消息版，前缀缓存友好）：
   * stable 在前（Anthropic 缓存断点附在其上），dynamic 在后。
   * 预算裁剪策略：先裁 dynamic（每轮重建，丢失可恢复），仍超额再裁 stable。
   */
  assembleMessagesSplit(
    stableSystem: string,
    dynamicSystem: string,
    history: ChatMessage[],
    userInput: string,
  ): ChatMessage[] {
    const allocation = this.config.budget.allocate()
    const maxTokens = allocation.systemPrompt

    let stable = stableSystem
    let dynamic = dynamicSystem
    const stableTokens = estimateTokens(stable)
    if (stableTokens + estimateTokens(dynamic) > maxTokens) {
      // 先裁 dynamic 到剩余预算
      dynamic = this.trimSystemPrompt(dynamic, Math.max(0, maxTokens - stableTokens))
      // 仍超额（stable 自身超预算）：再裁 stable，dynamic 丢弃
      if (estimateTokens(stable) > maxTokens) {
        stable = this.trimSystemPrompt(stable, maxTokens)
        dynamic = ''
      }
    }

    // 预算动态回流：未用完的 system 预算并入 history
    const systemTokensUsed = estimateTokens(stable) + estimateTokens(dynamic)
    const historyBudget =
      allocation.history + Math.max(0, allocation.systemPrompt - systemTokensUsed)
    const compressed = compressHistory(history, this.config.recentTurnsKeep, historyBudget)

    const messages: ChatMessage[] = [{ role: 'system', content: stable }]
    if (dynamic) {
      messages.push({ role: 'system', content: dynamic })
    }
    messages.push(...compressed.messages, { role: 'user', content: userInput })
    return messages
  }

  /** 裁剪 system prompt 到预算范围内 */
  private trimSystemPrompt(systemPrompt: string, maxTokens: number): string {
    const currentTokens = estimateTokens(systemPrompt)
    if (currentTokens <= maxTokens) return systemPrompt

    // 简化为字符截断（接受 ~4 chars/token 的估算偏差），避免 section 边界损坏
    const charsPerToken = 4
    const maxChars = maxTokens * charsPerToken
    // 尝试在最近的行边界截断
    const sliced = systemPrompt.slice(0, maxChars)
    const lastNewline = sliced.lastIndexOf('\n')
    const cutPoint = lastNewline > maxChars * 0.8 ? lastNewline : maxChars
    return systemPrompt.slice(0, cutPoint) + '\n...(system prompt 已裁剪)'
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

  /** 获取项目目录树（git ls-files 构建内存目录树，两级展开 + 深层折叠） */
  private async getProjectTree(): Promise<string | null> {
    try {
      const result = await this.exec('git', ['ls-files'])
      if (result.exitCode !== 0) return null

      const files = result.stdout.split('\n').filter(Boolean)
      if (files.length === 0) return null

      return formatFileTree(files)
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
      child.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString()
      })
      child.on('close', (code) => resolve({ stdout: stdout.trim(), exitCode: code ?? 1 }))
      child.on('error', () => resolve({ stdout: '', exitCode: 1 }))
    })
  }
}

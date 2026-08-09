/**
 * LoopState —— L3 事件驱动循环状态文件（.nexus/loop-state-<name>.md）
 *
 * 社区 STATE.md 共识：人类可读 Markdown + 机器可读 meta（HTML 注释 JSON）。
 * 循环跨轮次/跨会话持久化"做到哪了、什么成了、什么挂了"；
 * 外部（人或脚本）修改 meta 中 stop_requested 可请求停止循环。
 * 损坏/缺失时重置（不阻塞循环，告警提示）。
 * name="main" 时文件为 loop-state.md（兼容既有 /loop 默认路径），
 * 其他名称按 loop-state-<name>.md 分文件（本地 Automations 多 loop 并存）。
 */

import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'

/** Triage 结果分级（轻量收件箱：每轮从结果摘要宽松解析 [紧急]/[本周]/[观察] 标记行） */
export interface LoopFindings {
  urgent: string[]
  thisWeek: string[]
  watch: string[]
}

export interface LoopStateFile {
  loopName: string
  round: number
  lastRunAt: number | null
  lastResultSummary: string
  todos: string[]
  stopRequested: boolean
  /** Triage 分级结果（无发现时为空对象） */
  findings?: LoopFindings
}

const INITIAL_STATE: LoopStateFile = {
  loopName: 'main',
  round: 0,
  lastRunAt: null,
  lastResultSummary: '',
  todos: [],
  stopRequested: false,
  findings: { urgent: [], thisWeek: [], watch: [] },
}

export class LoopState {
  private readonly filePath: string
  private readonly name: string

  constructor(projectRoot: string, name = 'main') {
    const fileName = name === 'main' ? 'loop-state.md' : `loop-state-${name}.md`
    this.filePath = join(projectRoot, '.nexus', fileName)
    this.name = name
  }

  /** 获取状态文件路径（观测/调试用） */
  getFilePath(): string {
    return this.filePath
  }

  /** 读取状态；文件不存在返回初始状态，损坏时重置并告警 */
  async read(): Promise<LoopStateFile> {
    try {
      const content = await readFile(this.filePath, 'utf-8')
      const parsed = this.parse(content)
      if (parsed) return parsed
      // 损坏：重置（不抛错，循环仍可运行）
      console.warn(`[LoopState] ${this.filePath} 格式损坏，已重置`)
      const reset = { ...INITIAL_STATE, loopName: this.name }
      await this.write(reset)
      return reset
    } catch {
      // 文件不存在（ENOENT）或不可读：返回初始状态
      return { ...INITIAL_STATE, loopName: this.name }
    }
  }

  /** 读-改-写合并更新并落盘 */
  async update(patch: Partial<LoopStateFile>): Promise<LoopStateFile> {
    const current = await this.read()
    const next: LoopStateFile = { ...current, ...patch, loopName: this.name }
    await this.write(next)
    return next
  }

  private async write(state: LoopStateFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, LoopState.format(state), 'utf-8')
  }

  /** Markdown 渲染：人类可读章节 + HTML 注释 JSON meta（机器可读） */
  static format(state: LoopStateFile): string {
    const meta = {
      loopName: state.loopName,
      round: state.round,
      lastRunAt: state.lastRunAt,
      lastResultSummary: state.lastResultSummary,
      todos: state.todos,
      stopRequested: state.stopRequested,
      findings: state.findings ?? { urgent: [], thisWeek: [], watch: [] },
    }
    return [
      `# Loop State: ${state.loopName}`,
      '',
      '## 状态',
      `- 轮次: ${state.round}`,
      `- 上次运行: ${state.lastRunAt ? new Date(state.lastRunAt).toLocaleString() : '从未'}`,
      `- 停止请求: ${state.stopRequested ? '是（修改为 false 可恢复运行）' : '否'}`,
      '',
      '## 上次结果',
      state.lastResultSummary || '（无）',
      '',
      '## 待办',
      ...(state.todos.length > 0 ? state.todos.map((t) => `- ${t}`) : ['（无）']),
      '',
      '## 发现分级（Triage）',
      ...(state.findings &&
      (state.findings.urgent.length > 0 ||
        state.findings.thisWeek.length > 0 ||
        state.findings.watch.length > 0)
        ? [
            `- [紧急] ${state.findings.urgent.join('；') || '（无）'}`,
            `- [本周] ${state.findings.thisWeek.join('；') || '（无）'}`,
            `- [观察] ${state.findings.watch.join('；') || '（无）'}`,
          ]
        : ['（无待处理事项）']),
      '',
      `<!-- loop-state-meta: ${JSON.stringify(meta)} -->`,
      '',
    ].join('\n')
  }

  /** 解析：优先 meta JSON（机器可读）；缺失时返回 null（触发重置） */
  private parse(content: string): LoopStateFile | null {
    const metaMatch = content.match(/<!--\s*loop-state-meta:\s*(\{[\s\S]*?\})\s*-->/)
    if (!metaMatch) return null
    try {
      const raw = JSON.parse(metaMatch[1]) as Partial<LoopStateFile>
      const rawFindings = raw.findings as Partial<LoopFindings> | undefined
      return {
        loopName: typeof raw.loopName === 'string' ? raw.loopName : this.name,
        round: typeof raw.round === 'number' ? raw.round : 0,
        lastRunAt: typeof raw.lastRunAt === 'number' ? raw.lastRunAt : null,
        lastResultSummary: typeof raw.lastResultSummary === 'string' ? raw.lastResultSummary : '',
        todos: Array.isArray(raw.todos)
          ? raw.todos.filter((t): t is string => typeof t === 'string')
          : [],
        stopRequested: typeof raw.stopRequested === 'boolean' ? raw.stopRequested : false,
        findings: {
          urgent: Array.isArray(rawFindings?.urgent)
            ? rawFindings.urgent.filter((t): t is string => typeof t === 'string')
            : [],
          thisWeek: Array.isArray(rawFindings?.thisWeek)
            ? rawFindings.thisWeek.filter((t): t is string => typeof t === 'string')
            : [],
          watch: Array.isArray(rawFindings?.watch)
            ? rawFindings.watch.filter((t): t is string => typeof t === 'string')
            : [],
        },
      }
    } catch {
      return null
    }
  }

  /**
   * 从结果摘要宽松解析 Triage 分级标记（[紧急]/[本周]/[观察] 行）。
   * 无任何标记时返回空分级（收件箱显示无待处理事项）。
   */
  static parseFindings(summary: string): LoopFindings {
    const findings: LoopFindings = { urgent: [], thisWeek: [], watch: [] }
    for (const line of summary.split(/\n/)) {
      const t = line.trim()
      if (!t) continue
      if (t.startsWith('[紧急]')) findings.urgent.push(t.replace(/^\[紧急\]\s*/, ''))
      else if (t.startsWith('[本周]')) findings.thisWeek.push(t.replace(/^\[本周\]\s*/, ''))
      else if (t.startsWith('[观察]')) findings.watch.push(t.replace(/^\[观察\]\s*/, ''))
    }
    return findings
  }
}

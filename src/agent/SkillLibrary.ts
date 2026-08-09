/**
 * 技能库（方向三：从"记得"到"会做"）
 * 对齐 Agent Skills 开放标准（agentskills.io，截至 2026-08）：
 * - 目录式技能 `.nexus/skills/<name>/SKILL.md`（可携带模板/脚本/示例等资源），
 *   兼容旧的扁平 `.nexus/skills/<name>.md` 格式
 * - 渐进式披露：L1 元数据（name+description）注入系统提示 →
 *   L2 正文由 load_skill 工具按需加载 → L3 资源文件由 agent 用 read_file 读取
 * - 插件技能：addSkillsDir 追加插件技能根目录（项目级优先于插件级）
 *
 * 教训是陈述性知识，高频重复流程应固化为可执行技能。
 * 固化必须经用户确认：findConsolidationCandidates 只产出提议，
 * 由 Orchestrator 通过 system_info 事件提示用户，不自动写盘转正。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { lexicalScore, tokenize } from '../memory/LessonRetriever'
import type { MemoryStore } from '../memory/MemoryStore'
import type { Lesson, SkillStatus } from '../memory/types'

/** 同簇教训间的最低词项相似度 */
const SIMILARITY_THRESHOLD = 0.6
/** 触发技能合并提议的最小簇大小 */
const MIN_CLUSTER_SIZE = 3

export interface SkillFile {
  name: string
  description: string
  status: string
  content: string
  /** 技能来源根目录（项目级或插件级） */
  source: string
  /** 目录式技能是否携带资源文件（L3 渐进式披露） */
  hasResources: boolean
}

/** 技能合并提议（由同类高频教训聚簇产生，需用户确认后固化） */
export interface SkillProposal {
  name: string
  description: string
  steps: string[]
  lessonIds: number[]
}

/** 技能名清洗：仅保留字母数字连字符，防止路径穿越 */
function sanitizeSkillName(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'unnamed-skill'
  )
}

/** 解析简易 front-matter（key: value 行） */
function parseFrontMatter(content: string): Record<string, string> {
  const meta: Record<string, string> = {}
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return meta
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':')
    if (idx > 0) {
      meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
    }
  }
  return meta
}

/** 去掉 front-matter，返回正文 */
function stripFrontMatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n?/, '').trim()
}

/** readdir 容错包装（目录不存在/不可读时返回空） */
function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

export class SkillLibrary {
  private skillsDir: string
  private store: MemoryStore
  /** 额外技能根目录（插件技能），项目级优先：同名技能以先出现的根为准 */
  private extraSkillsDirs: string[] = []

  constructor(projectRoot: string, store: MemoryStore) {
    this.skillsDir = join(projectRoot, '.nexus', 'skills')
    this.store = store
  }

  /** 追加技能根目录（插件技能），重复目录忽略 */
  addSkillsDir(dir: string): void {
    if (dir === this.skillsDir || this.extraSkillsDirs.includes(dir)) return
    this.extraSkillsDirs.push(dir)
  }

  /** 所有技能根目录（项目级在前 = 优先级高） */
  private allSkillsDirs(): string[] {
    return [this.skillsDir, ...this.extraSkillsDirs]
  }

  /**
   * 列出所有技能（目录式 SKILL.md 优先，兼容扁平 .md；同名去重，项目级优先）
   */
  listSkillFiles(): SkillFile[] {
    const seen = new Set<string>()
    const files: SkillFile[] = []
    for (const root of this.allSkillsDirs()) {
      if (!existsSync(root)) continue
      for (const entry of readdirSync(root)) {
        const entryPath = join(root, entry)
        let file: SkillFile | null = null
        try {
          if (statSync(entryPath).isDirectory()) {
            file = this.readDirSkill(entryPath, entry, root)
          } else if (entry.endsWith('.md')) {
            file = this.readFlatSkill(entryPath, entry, root)
          }
        } catch {
          /* 跳过不可读条目 */
        }
        if (file && !seen.has(file.name)) {
          seen.add(file.name)
          files.push(file)
        }
      }
    }
    return files
  }

  /** 目录式技能：<dir>/SKILL.md 为入口，其余条目视为资源 */
  private readDirSkill(dirPath: string, dirName: string, source: string): SkillFile | null {
    const skillMd = join(dirPath, 'SKILL.md')
    if (!existsSync(skillMd)) return null
    const content = readFileSync(skillMd, 'utf-8')
    const meta = parseFrontMatter(content)
    const hasResources = readdirSync(dirPath).some((e) => e !== 'SKILL.md')
    return {
      name: sanitizeSkillName(meta.name ?? dirName),
      description: meta.description ?? '',
      status: meta.status ?? 'active',
      content,
      source,
      hasResources,
    }
  }

  /** 扁平技能：<name>.md（旧格式兼容，无资源文件） */
  private readFlatSkill(filePath: string, fileName: string, source: string): SkillFile | null {
    const content = readFileSync(filePath, 'utf-8')
    const meta = parseFrontMatter(content)
    return {
      name: sanitizeSkillName(meta.name ?? fileName.replace(/\.md$/, '')),
      description: meta.description ?? '',
      status: meta.status ?? 'candidate',
      content,
      source,
      hasResources: false,
    }
  }

  /**
   * L1 元数据：仅 active 技能的 name+description（注入系统提示，
   * 供模型判断任务是否匹配；正文不进上下文，避免窗口浪费）。
   */
  listActiveSkillMeta(): Array<{ name: string; description: string; hasResources: boolean }> {
    return this.listSkillFiles()
      .filter((s) => s.status === 'active')
      .map((s) => ({ name: s.name, description: s.description, hasResources: s.hasResources }))
  }

  /**
   * L2 按需加载：返回技能正文（去掉 front-matter）。
   * 目录式技能附带资源文件清单，agent 可用 read_file 进一步加载（L3）。
   */
  readSkillBody(name: string): string | null {
    const safeName = sanitizeSkillName(name)
    const skill = this.listSkillFiles().find((s) => s.name === safeName)
    if (!skill) return null

    const body = stripFrontMatter(skill.content)
    if (!skill.hasResources) return body

    // 目录式技能：列出资源文件供 agent 按需读取（渐进式披露 L3 入口）
    const dirPath = this.findSkillDir(skill)
    if (!dirPath) return body
    try {
      const resources = readdirSync(dirPath)
        .filter((e) => e !== 'SKILL.md')
        .map((e) => `- ${join(dirPath, e)}`)
      if (resources.length === 0) return body
      return `${body}\n\n## 可用资源文件（用 read_file 按需读取）\n${resources.join('\n')}`
    } catch {
      return body
    }
  }

  /** 定位目录式技能所在目录（找不到返回 null） */
  private findSkillDir(skill: SkillFile): string | null {
    if (!skill.hasResources) return null
    for (const root of this.allSkillsDirs()) {
      for (const entry of safeReaddir(root)) {
        const entryPath = join(root, entry)
        try {
          if (!statSync(entryPath).isDirectory()) continue
          if (!existsSync(join(entryPath, 'SKILL.md'))) continue
          const meta = parseFrontMatter(readFileSync(join(entryPath, 'SKILL.md'), 'utf-8'))
          if (sanitizeSkillName(meta.name ?? entry) === skill.name) return entryPath
        } catch {
          /* 忽略不可读条目 */
        }
      }
    }
    return null
  }

  /**
   * 创建技能：写盘 .md 文件并在 DB 登记元数据。
   * status 默认 candidate —— 未经验证的技能不直接生效（MindMemOS 调研结论：
   * 未优化的原始 Skill 直接注入反而降低任务成功率）。
   */
  createSkill(
    name: string,
    description: string,
    steps: string[],
    sourceLessonIds: number[] = [],
    status: SkillStatus = 'candidate',
  ): string {
    const safeName = sanitizeSkillName(name)
    mkdirSync(this.skillsDir, { recursive: true })

    const filePath = join(this.skillsDir, `${safeName}.md`)
    const body = [
      '---',
      `name: ${safeName}`,
      `description: ${description}`,
      `status: ${status}`,
      '---',
      '',
      `# ${safeName}`,
      '',
      description,
      '',
      '## 步骤',
      ...steps.map((step, i) => `${i + 1}. ${step}`),
      '',
    ].join('\n')
    writeFileSync(filePath, body, 'utf-8')

    this.store.createSkill(safeName, description, filePath, sourceLessonIds, status)
    return filePath
  }

  /** 转正技能（用户确认后调用）：更新 DB 状态并重写文件 front-matter */
  activateSkill(name: string): boolean {
    const safeName = sanitizeSkillName(name)
    this.store.activateSkill(safeName)

    const filePath = join(this.skillsDir, `${safeName}.md`)
    if (!existsSync(filePath)) return false
    try {
      const content = readFileSync(filePath, 'utf-8')
      writeFileSync(filePath, content.replace(/^status: .*$/m, 'status: active'), 'utf-8')
      return true
    } catch {
      return false
    }
  }

  /**
   * 技能合并提议：对 active 教训按 kind 分组后贪心聚簇
   * （与簇种子词项相似度 >= 阈值的归入同簇），簇大小 >= 3 时产出提议。
   * 仅提议不固化，固化需用户确认。
   */
  findConsolidationCandidates(lessons: Lesson[]): SkillProposal[] {
    const activeByKind = new Map<string, Lesson[]>()
    for (const lesson of lessons) {
      if (lesson.status !== 'active') continue
      const group = activeByKind.get(lesson.kind) ?? []
      group.push(lesson)
      activeByKind.set(lesson.kind, group)
    }

    const proposals: SkillProposal[] = []
    for (const [kind, group] of activeByKind) {
      const clusters = clusterLessons(group)
      for (const cluster of clusters) {
        if (cluster.length < MIN_CLUSTER_SIZE) continue
        const seed = cluster[0]
        proposals.push({
          name: sanitizeSkillName(`${kind}-pattern-${seed.id}`),
          description: `由 ${cluster.length} 条同类教训合并：${seed.triggerDesc}`,
          steps: cluster.map((l) => `${l.triggerDesc} → ${l.advice}`),
          lessonIds: cluster.map((l) => l.id),
        })
      }
    }
    return proposals
  }
}

/** 贪心聚簇：依次与已有簇的种子比较，相似则入簇，否则自成新簇 */
function clusterLessons(lessons: Lesson[]): Lesson[][] {
  const clusters: Lesson[][] = []
  for (const lesson of lessons) {
    const lessonTokens = tokenize(`${lesson.triggerDesc} ${lesson.advice}`)
    let placed = false
    for (const cluster of clusters) {
      const seed = cluster[0]
      const seedTokens = tokenize(`${seed.triggerDesc} ${seed.advice}`)
      if (lexicalScore(lessonTokens, seedTokens) >= SIMILARITY_THRESHOLD) {
        cluster.push(lesson)
        placed = true
        break
      }
    }
    if (!placed) clusters.push([lesson])
  }
  return clusters
}

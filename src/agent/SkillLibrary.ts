/**
 * 技能库（方向三：从"记得"到"会做"）
 * 技能 = .nexus/skills/<name>.md（front-matter 元数据 + 步骤清单）。
 * 教训是陈述性知识，高频重复流程应固化为可执行技能。
 *
 * 固化必须经用户确认：findConsolidationCandidates 只产出提议，
 * 由 Orchestrator 通过 system_info 事件提示用户，不自动写盘转正。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
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

export class SkillLibrary {
  private skillsDir: string
  private store: MemoryStore

  constructor(projectRoot: string, store: MemoryStore) {
    this.skillsDir = join(projectRoot, '.nexus', 'skills')
    this.store = store
  }

  /** 列出技能目录下的所有 .md 技能文件（含 front-matter 元数据） */
  listSkillFiles(): SkillFile[] {
    if (!existsSync(this.skillsDir)) return []
    const files: SkillFile[] = []
    for (const entry of readdirSync(this.skillsDir)) {
      if (!entry.endsWith('.md')) continue
      try {
        const content = readFileSync(join(this.skillsDir, entry), 'utf-8')
        const meta = parseFrontMatter(content)
        files.push({
          name: meta.name ?? entry.replace(/\.md$/, ''),
          description: meta.description ?? '',
          status: meta.status ?? 'candidate',
          content,
        })
      } catch {
        /* 跳过不可读文件 */
      }
    }
    return files
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

/**
 * 学习系统存储层
 * 经验（轨迹快照）、教训（提炼知识）、技能（固化流程）的持久化与治理。
 * 沿用 SemanticSearch 的模式：独立打开 .nexus/nexus.db（WAL 支持多连接），
 * 构造时运行迁移确保学习表存在，不侵入 NexusDB。
 */

import { Database } from 'bun:sqlite'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { runMigrations } from '../storage/migrations'
import type {
  Experience,
  LearningStats,
  Lesson,
  LessonStatus,
  NewLesson,
  SkillRecord,
  SkillStatus,
} from './types'

/** lessons 表容量上限，超出按评分淘汰（防记忆库无限膨胀稀释上下文质量） */
export const LESSON_CAP = 200
/** 有效性评分低于该阈值且命中样本足够时自动归档 */
const ARCHIVE_SCORE_THRESHOLD = 0.2
/** 触发自动归档所需的最小命中次数（避免样本不足时误杀） */
const ARCHIVE_MIN_HITS = 3

interface LessonRow {
  id: number
  trigger_desc: string
  advice: string
  kind: string
  status: string
  score: number
  hit_count: number
  success_count: number
  source_experience_id: string | null
  created_at: number
  last_verified_at: number | null
}

interface ExperienceRow {
  id: string
  session_id: string
  summary: string
  tool_sequence: string | null
  outcome: string
  error_label: string | null
  cost: number
  duration_ms: number
  created_at: number
}

function rowToLesson(row: LessonRow): Lesson {
  return {
    id: row.id,
    triggerDesc: row.trigger_desc,
    advice: row.advice,
    kind: row.kind as Lesson['kind'],
    status: row.status as LessonStatus,
    score: row.score,
    hitCount: row.hit_count,
    successCount: row.success_count,
    sourceExperienceId: row.source_experience_id ?? undefined,
    createdAt: row.created_at,
    lastVerifiedAt: row.last_verified_at ?? undefined,
  }
}

function rowToExperience(row: ExperienceRow): Experience {
  return {
    id: row.id,
    sessionId: row.session_id,
    summary: row.summary,
    toolSequence: row.tool_sequence ?? undefined,
    outcome: row.outcome as Experience['outcome'],
    errorLabel: row.error_label ?? undefined,
    cost: row.cost,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
  }
}

/** Laplace 平滑评分：(success + 1) / (hits + 2)，无样本时为中性 0.5 */
export function smoothedScore(successCount: number, hitCount: number): number {
  return (successCount + 1) / (hitCount + 2)
}

export class MemoryStore {
  private db: Database

  constructor(projectRoot: string) {
    const nexusDir = join(projectRoot, '.nexus')
    mkdirSync(nexusDir, { recursive: true })
    this.db = new Database(join(nexusDir, 'nexus.db'))
    this.db.exec('PRAGMA journal_mode = WAL')
    runMigrations(this.db)
  }

  close(): void {
    this.db.close()
  }

  // ─── 经验（方向一：轨迹采集） ──────────────────────────────────────────────

  /** 记录一条任务轨迹快照 */
  recordExperience(exp: Experience): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO experiences
         (id, session_id, summary, tool_sequence, outcome, error_label, cost, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        exp.id,
        exp.sessionId,
        exp.summary,
        exp.toolSequence ?? null,
        exp.outcome,
        exp.errorLabel ?? null,
        exp.cost,
        exp.durationMs,
        exp.createdAt,
      )
  }

  /** 获取尚未反思的经验（created_at 高于水位线，按时间升序） */
  getUnreflectedExperiences(limit = 5): Experience[] {
    const watermark = Number(this.getMeta('last_reflected_at') ?? '0')
    const rows = this.db
      .prepare('SELECT * FROM experiences WHERE created_at > ? ORDER BY created_at ASC LIMIT ?')
      .all(watermark, limit) as ExperienceRow[]
    return rows.map(rowToExperience)
  }

  /** 推进反思水位线（反思完成后调用，避免重复反思） */
  markReflected(upToTimestamp: number): void {
    this.db
      .prepare('INSERT OR REPLACE INTO learning_meta (key, value) VALUES (?, ?)')
      .run('last_reflected_at', String(upToTimestamp))
  }

  // ─── 教训（方向二/四：提炼与验证闭环） ────────────────────────────────────

  /**
   * 入库一条新教训（status 默认 candidate）。
   * 去重：trigger_desc + advice 完全相同时不重复插入，仅刷新验证时间。
   * @returns 教训 id
   */
  addLesson(lesson: NewLesson): number {
    const existing = this.db
      .prepare('SELECT id FROM lessons WHERE trigger_desc = ? AND advice = ?')
      .get(lesson.triggerDesc, lesson.advice) as { id: number } | undefined
    if (existing) {
      this.db
        .prepare('UPDATE lessons SET last_verified_at = ? WHERE id = ?')
        .run(Date.now(), existing.id)
      return existing.id
    }

    const result = this.db
      .prepare(
        `INSERT INTO lessons
         (trigger_desc, advice, kind, status, score, hit_count, success_count, source_experience_id, created_at)
         VALUES (?, ?, ?, 'candidate', 0.5, 0, 0, ?, ?)`,
      )
      .run(
        lesson.triggerDesc,
        lesson.advice,
        lesson.kind,
        lesson.sourceExperienceId ?? null,
        Date.now(),
      )
    return Number(result.lastInsertRowid)
  }

  /** 转正教训（candidate → active，通过真实命中验证后调用） */
  activateLesson(id: number): void {
    this.db
      .prepare("UPDATE lessons SET status = 'active', last_verified_at = ? WHERE id = ?")
      .run(Date.now(), id)
  }

  /** 归档教训（低分或过时时调用，不再参与检索） */
  archiveLesson(id: number): void {
    this.db.prepare("UPDATE lessons SET status = 'archived' WHERE id = ?").run(id)
  }

  deleteLesson(id: number): void {
    this.db.prepare('DELETE FROM lessons WHERE id = ?').run(id)
  }

  /**
   * 记录教训的一次命中结果（验证闭环核心）。
   * 命中且任务成功 → success_count+1；评分按 Laplace 平滑更新；
   * 评分跌破阈值且样本足够 → 自动归档（防止错误经验持续污染上下文）。
   * candidate 教训命中成功后转正为 active。
   */
  recordLessonOutcome(id: number, success: boolean): void {
    const row = this.db
      .prepare('SELECT status, hit_count, success_count FROM lessons WHERE id = ?')
      .get(id) as { status: string; hit_count: number; success_count: number } | undefined
    if (!row) return

    const hitCount = row.hit_count + 1
    const successCount = row.success_count + (success ? 1 : 0)
    const score = smoothedScore(successCount, hitCount)

    this.db
      .prepare(
        'UPDATE lessons SET hit_count = ?, success_count = ?, score = ?, last_verified_at = ? WHERE id = ?',
      )
      .run(hitCount, successCount, score, Date.now(), id)

    if (score < ARCHIVE_SCORE_THRESHOLD && hitCount >= ARCHIVE_MIN_HITS) {
      this.archiveLesson(id)
    } else if (success && row.status === 'candidate') {
      this.activateLesson(id)
    }
  }

  /** 列出教训（可按状态过滤） */
  listLessons(status?: LessonStatus, limit = 50): Lesson[] {
    const rows = status
      ? (this.db
          .prepare('SELECT * FROM lessons WHERE status = ? ORDER BY score DESC LIMIT ?')
          .all(status, limit) as LessonRow[])
      : (this.db
          .prepare('SELECT * FROM lessons ORDER BY score DESC LIMIT ?')
          .all(limit) as LessonRow[])
    return rows.map(rowToLesson)
  }

  /** 获取可检索的教训（candidate + active；candidate 需在真实命中中验证） */
  getRetrievableLessons(): Lesson[] {
    const rows = this.db
      .prepare("SELECT * FROM lessons WHERE status IN ('candidate', 'active') ORDER BY score DESC")
      .all() as LessonRow[]
    return rows.map(rowToLesson)
  }

  /**
   * 容量治理：总数超过 cap 时按评分升序淘汰，archived 优先、candidate 次之，
   * 尽量保留 active。返回删除条数。
   */
  enforceLessonCap(cap = LESSON_CAP): number {
    const total = (
      this.db.prepare('SELECT COUNT(*) as count FROM lessons').get() as { count: number }
    ).count
    if (total <= cap) return 0

    let toDelete = total - cap
    let deleted = 0
    for (const status of ['archived', 'candidate', 'active'] as const) {
      if (toDelete <= 0) break
      // active 是最后手段：仅当 archived+candidate 不够删时才触碰
      if (status === 'active' && toDelete <= 0) break
      const rows = this.db
        .prepare('SELECT id FROM lessons WHERE status = ? ORDER BY score ASC LIMIT ?')
        .all(status, toDelete) as Array<{ id: number }>
      for (const row of rows) {
        this.deleteLesson(row.id)
        deleted++
      }
      toDelete -= rows.length
    }
    return deleted
  }

  /**
   * 时效治理钩子：代码图谱检测到文件结构变化时调用。
   * 当前教训不携带文件关联，保留接口供后续按 trigger_desc 关联文件后实现标记 stale。
   */
  markStaleLessons(_filePaths: string[]): number {
    return 0
  }

  // ─── 技能（方向三：从"记得"到"会做"） ─────────────────────────────────────

  /** 登记技能记录（写盘 .md 由 SkillLibrary 负责，此处只存元数据） */
  createSkill(
    name: string,
    description: string,
    filePath: string | undefined,
    sourceLessonIds: number[],
    status: SkillStatus = 'candidate',
  ): number {
    const result = this.db
      .prepare(
        `INSERT INTO skills (name, description, file_path, status, source_lesson_ids, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(name, description, filePath ?? null, status, JSON.stringify(sourceLessonIds), Date.now())
    return Number(result.lastInsertRowid)
  }

  activateSkill(name: string): void {
    this.db.prepare("UPDATE skills SET status = 'active' WHERE name = ?").run(name)
  }

  deleteSkill(id: number): void {
    this.db.prepare('DELETE FROM skills WHERE id = ?').run(id)
  }

  listSkills(): SkillRecord[] {
    const rows = this.db.prepare('SELECT * FROM skills ORDER BY created_at DESC').all() as Array<{
      id: number
      name: string
      description: string
      file_path: string | null
      status: string
      source_lesson_ids: string | null
      created_at: number
    }>
    return rows.map((r) => {
      let ids: number[] = []
      try {
        ids = r.source_lesson_ids ? (JSON.parse(r.source_lesson_ids) as number[]) : []
      } catch {
        ids = []
      }
      return {
        id: r.id,
        name: r.name,
        description: r.description,
        filePath: r.file_path ?? undefined,
        status: r.status as SkillStatus,
        sourceLessonIds: ids,
        createdAt: r.created_at,
      }
    })
  }

  // ─── 统计（方向四：学习增益可量化） ───────────────────────────────────────

  getStats(): LearningStats {
    const experienceCount = (
      this.db.prepare('SELECT COUNT(*) as count FROM experiences').get() as { count: number }
    ).count
    const skillCount = (
      this.db.prepare('SELECT COUNT(*) as count FROM skills').get() as { count: number }
    ).count

    const lessonsByStatus: Record<LessonStatus, number> = { candidate: 0, active: 0, archived: 0 }
    const statusRows = this.db
      .prepare('SELECT status, COUNT(*) as count FROM lessons GROUP BY status')
      .all() as Array<{ status: string; count: number }>
    for (const row of statusRows) {
      if (row.status in lessonsByStatus) {
        lessonsByStatus[row.status as LessonStatus] = row.count
      }
    }

    const activeAgg = this.db
      .prepare("SELECT AVG(score) as avg_score FROM lessons WHERE status = 'active'")
      .get() as { avg_score: number | null }

    const hitAgg = this.db
      .prepare('SELECT SUM(hit_count) as hits, SUM(success_count) as successes FROM lessons')
      .get() as { hits: number | null; successes: number | null }

    return {
      experienceCount,
      lessonsByStatus,
      skillCount,
      avgActiveScore: activeAgg.avg_score ?? null,
      hitSuccessRate: hitAgg.hits && hitAgg.hits > 0 ? (hitAgg.successes ?? 0) / hitAgg.hits : null,
    }
  }

  // ─── 内部辅助 ──────────────────────────────────────────────────────────────

  private getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM learning_meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value ?? null
  }
}

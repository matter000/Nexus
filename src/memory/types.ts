/**
 * 学习系统类型定义
 * 经验（轨迹快照）、教训（提炼后的可复用知识）、技能（固化的流程）
 */

/** 任务结果：成功 / 失败 / 部分完成 */
export type ExperienceOutcome = 'success' | 'failure' | 'partial'

/** 教训类型：失败模式（避免重蹈覆辙） / 成功策略（复用有效路径） */
export type LessonKind = 'failure_pattern' | 'success_strategy'

/** 教训生命周期：candidate（待验证）→ active（已转正）→ archived（低分淘汰） */
export type LessonStatus = 'candidate' | 'active' | 'archived'

/** 技能生命周期：candidate（提议待确认）→ active（用户确认后生效） */
export type SkillStatus = 'candidate' | 'active'

/** 一次任务的结构化轨迹快照（反思的原料） */
export interface Experience {
  id: string
  sessionId: string
  /** 任务摘要（用户请求的一句话概括） */
  summary: string
  /** 工具调用序列（如 "read_file,grep,edit_file,bash"） */
  toolSequence?: string
  outcome: ExperienceOutcome
  /** 失败时的错误类型标签（如 test_failure / type_error） */
  errorLabel?: string
  cost: number
  durationMs: number
  createdAt: number
}

/** 从经验中提炼的可复用教训 */
export interface Lesson {
  id: number
  /** 触发条件描述（"当 X 场景时"） */
  triggerDesc: string
  /** 建议动作（"应先 Y"） */
  advice: string
  kind: LessonKind
  status: LessonStatus
  /** 有效性评分（0~1，Wilson 平滑） */
  score: number
  hitCount: number
  successCount: number
  sourceExperienceId?: string
  createdAt: number
  lastVerifiedAt?: number
}

/** 新教训入库参数（id/score/计数由存储层管理） */
export interface NewLesson {
  triggerDesc: string
  advice: string
  kind: LessonKind
  sourceExperienceId?: string
}

/** 技能库中的技能记录 */
export interface SkillRecord {
  id: number
  name: string
  description: string
  /** 对应 .nexus/skills/<name>.md 文件路径（可能尚未写盘） */
  filePath?: string
  status: SkillStatus
  /** 来源 lesson id 列表（JSON 序列化存储） */
  sourceLessonIds: number[]
  createdAt: number
}

/** 学习系统统计（/memory 与 learn:eval 用） */
export interface LearningStats {
  experienceCount: number
  lessonsByStatus: Record<LessonStatus, number>
  skillCount: number
  /** active lessons 的平均有效性评分（无数据时为 null） */
  avgActiveScore: number | null
  /** 全局命中率 success_count/hit_count（无命中时为 null） */
  hitSuccessRate: number | null
}

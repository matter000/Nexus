/**
 * LearningManager - 学习系统管理（经验采集 / 教训检索 / 技能库）
 * 学习系统是旁路能力：所有失败仅告警，绝不阻塞 Agent 主流程。
 * 闭环：经验记录 → 会话末反思提炼教训 → 命中反馈评分 → 技能合并提议 → 容量治理。
 */

import type { LanguageModel } from 'ai'
import { LessonRetriever } from '../memory/LessonRetriever'
import { MemoryStore } from '../memory/MemoryStore'
import { type FailurePattern, type LoopTraceRecord, TraceStore } from '../memory/TraceStore'
import type { Experience } from '../memory/types'
import { Reflector } from './Reflector'
import { SkillLibrary } from './SkillLibrary'

/** 会话末学习闭环的统计结果（由 Orchestrator 决定如何呈现给用户） */
export interface EndOfSessionLearningResult {
  /** 本次反思新提炼的教训数 */
  newLessons: number
  /** 检测到的技能合并提议数 */
  skillProposals: number
  /** 容量治理淘汰的低价值教训数 */
  deletedLessons: number
}

export class LearningManager {
  private memoryStore: MemoryStore | null = null
  private lessonRetriever: LessonRetriever | null = null
  private skillLibrary: SkillLibrary | null = null
  /** L4 trace 存储（循环执行轨迹持久化与失败模式聚类；失败静默降级） */
  private traceStore: TraceStore | null = null

  /** 学习系统是否可用 */
  get available(): boolean {
    return this.memoryStore !== null
  }

  /** 教训检索器（供 ContextAssembler 注入 L1 上下文） */
  get lessonProvider(): LessonRetriever | null {
    return this.lessonRetriever
  }

  /** 技能库实例（插件技能目录登记 / load_skill 读取器用） */
  getSkillLibrary(): SkillLibrary | null {
    return this.skillLibrary
  }

  /** 初始化学习系统；失败时整体不可用（静默降级） */
  init(projectRoot: string): void {
    try {
      this.memoryStore = new MemoryStore(projectRoot)
      this.lessonRetriever = new LessonRetriever(this.memoryStore)
      this.skillLibrary = new SkillLibrary(projectRoot, this.memoryStore)
      this.traceStore = new TraceStore(projectRoot)
    } catch (err) {
      console.warn('[Memory] 学习系统初始化失败，自主学习能力不可用:', err)
      this.memoryStore = null
      this.lessonRetriever = null
      this.skillLibrary = null
      this.traceStore = null
    }
  }

  /**
   * 记录一次任务经验，并对本任务命中的教训记录成功/失败反馈
   * （负反馈驱动低分教训自动归档，验证闭环核心）。
   */
  recordExperience(params: {
    userInput: string
    sessionId: string | null
    outcome: Experience['outcome']
    cost: number
    durationMs: number
  }): void {
    try {
      if (!this.memoryStore) return
      this.memoryStore.recordExperience({
        id: crypto.randomUUID(),
        sessionId: params.sessionId ?? 'unknown-session',
        summary: params.userInput.slice(0, 200),
        outcome: params.outcome,
        cost: params.cost,
        durationMs: params.durationMs,
        createdAt: Date.now(),
      })
      const hits = this.lessonRetriever?.lastHitIds ?? []
      for (const id of hits) {
        this.memoryStore.recordLessonOutcome(id, params.outcome === 'success')
      }
    } catch (err) {
      console.warn('[Memory] 经验记录失败:', err)
    }
  }

  /**
   * 会话结束学习闭环：反思未反思经验 → 技能合并提议 → 容量治理。
   * 执行完毕后关闭存储（会话级生命周期）。
   */
  async runEndOfSession(summarizerModel: LanguageModel): Promise<EndOfSessionLearningResult> {
    const result: EndOfSessionLearningResult = {
      newLessons: 0,
      skillProposals: 0,
      deletedLessons: 0,
    }
    try {
      if (!this.memoryStore) return result

      // a. 反思水位线之上的未反思经验，提炼为 candidate 教训
      const pending = this.memoryStore.getUnreflectedExperiences()
      if (pending.length > 0) {
        const reflector = new Reflector(summarizerModel)
        const lessons = await reflector.reflect(pending)
        for (const lesson of lessons) {
          this.memoryStore.addLesson({ ...lesson, sourceExperienceId: pending[0].id })
        }
        // 推进反思水位线（只标记本次批次，避免重复反思）
        this.memoryStore.markReflected(pending[pending.length - 1].createdAt)
        result.newLessons = lessons.length
      }

      // b. 技能合并提议：同类高频教训聚簇，仅提示用户确认固化
      if (this.skillLibrary) {
        result.skillProposals = this.skillLibrary.findConsolidationCandidates(
          this.memoryStore.listLessons(),
        ).length
      }

      // c. 容量治理：超过上限按评分淘汰低价值教训
      result.deletedLessons = this.memoryStore.enforceLessonCap()
    } catch (err) {
      console.warn('[Memory] 会话结束学习失败:', err)
    } finally {
      this.close()
    }
    return result
  }

  /**
   * L4：记录一轮循环执行轨迹（exec/goal/loop；失败静默）。
   * 采集点为 Orchestrator 循环结束（emitLoopTraceSummary / runGoal / runLoop）。
   */
  recordLoopTrace(trace: LoopTraceRecord): void {
    this.traceStore?.record(trace)
  }

  /**
   * L4：消费循环 trace 的失败模式——高频失败（count >= 3）且无等价教训时
   * 生成教训。advice 优先用 Reflector LLM 精化（NEXUS_L4_REFINE=off 可关闭），
   * 精化失败/关闭时降级为模板文案（零成本兜底）。返回统计供会话末播报。
   */
  async consumeLoopTraces(
    minCount = 3,
    summarizerModel?: LanguageModel,
  ): Promise<{
    patterns: FailurePattern[]
    newLessons: number
  }> {
    const result = { patterns: [] as FailurePattern[], newLessons: 0 }
    try {
      if (!this.traceStore || !this.memoryStore) return result
      const patterns = this.traceStore.failurePatterns(minCount)
      result.patterns = patterns
      const existing = this.memoryStore.listLessons()
      const refineEnabled = process.env.NEXUS_L4_REFINE !== 'off'
      for (const p of patterns) {
        const key = `[循环] ${p.loopName}: ${p.pattern}`
        // 已有等价教训（trigger_desc 前缀匹配）则跳过
        if (existing.some((l) => l.triggerDesc.startsWith(`[循环] ${p.loopName}:`))) continue
        // 先精化后降级：LLM 提炼具体 advice，失败/关闭用模板兜底
        let advice = `该失败模式在循环 ${p.loopName} 中重复出现 ${p.count} 次。建议：任务开始时先运行对应证据门禁确认基线；失败后检查验证结论中的具体缺失项再重试，避免重复无用功。`
        if (refineEnabled && summarizerModel) {
          try {
            const refined = await new Reflector(summarizerModel).refineLoopPattern(p)
            if (refined) advice = refined
          } catch {
            // 精化失败静默降级模板（学习是旁路增强）
          }
        }
        this.memoryStore.addLesson({
          triggerDesc: key,
          advice,
          kind: 'failure_pattern',
        })
        result.newLessons++
      }
    } catch (err) {
      console.warn('[Memory] 循环 trace 消费失败:', err)
    }
    return result
  }

  /** 查看学习记忆统计与 top 教训（/memory） */
  listMemory(): string {
    if (!this.memoryStore) return '学习系统不可用（未完成初始化）'
    const stats = this.memoryStore.getStats()
    const lessons = this.memoryStore.listLessons(undefined, 5)
    const skills = this.memoryStore.listSkills()
    const lines: string[] = [
      '── 学习记忆 ──',
      `经验: ${stats.experienceCount} 条`,
      `教训: candidate ${stats.lessonsByStatus.candidate} / active ${stats.lessonsByStatus.active} / archived ${stats.lessonsByStatus.archived}`,
      `平均 active 评分: ${stats.avgActiveScore === null ? 'N/A' : stats.avgActiveScore.toFixed(3)}`,
      `命中成功率: ${stats.hitSuccessRate === null ? 'N/A' : `${(stats.hitSuccessRate * 100).toFixed(1)}%`}`,
      `技能: ${stats.skillCount} 个`,
    ]
    if (lessons.length > 0) {
      lines.push('', 'top 教训：')
      for (const lesson of lessons) {
        const kind = lesson.kind === 'failure_pattern' ? '失败' : '成功'
        lines.push(
          `  [#${lesson.id}][${lesson.status}][${kind}][${lesson.score.toFixed(2)}] ${lesson.triggerDesc} → ${lesson.advice}`,
        )
      }
    }
    if (skills.length > 0) {
      lines.push('', '技能：')
      for (const skill of skills) {
        lines.push(`  [#${skill.id}][${skill.status}] ${skill.name} — ${skill.description}`)
      }
    }
    lines.push('', '提示: /memory delete lesson <id> 删除教训，/memory skills 查看技能文件')
    return lines.join('\n')
  }

  /** 删除一条教训或技能（/memory delete lesson|skill <id>） */
  deleteMemoryEntry(kind: 'lesson' | 'skill', id: number | string): string {
    if (!this.memoryStore) return '学习系统不可用（未完成初始化）'
    const numericId = typeof id === 'string' ? Number(id) : id
    if (!Number.isFinite(numericId)) return `无效的 id: ${String(id)}`
    if (kind === 'lesson') {
      this.memoryStore.deleteLesson(numericId)
    } else if (kind === 'skill') {
      this.memoryStore.deleteSkill(numericId)
    } else {
      return `不支持的删除类型: ${kind}（仅支持 lesson / skill）`
    }
    return `已删除 ${kind} #${numericId}`
  }

  /** 列出技能文件（/memory skills） */
  listSkills(): string {
    if (!this.skillLibrary) return '技能库不可用（未完成初始化）'
    const files = this.skillLibrary.listSkillFiles()
    if (files.length === 0) return '暂无技能文件（.nexus/skills/）'
    const lines: string[] = ['技能文件：']
    for (const file of files) {
      lines.push(`  [${file.status}] ${file.name} — ${file.description}`)
    }
    return lines.join('\n')
  }

  /** 关闭存储并重置（会话级生命周期结束） */
  close(): void {
    this.memoryStore?.close()
    this.traceStore?.close()
    this.memoryStore = null
    this.lessonRetriever = null
    this.skillLibrary = null
    this.traceStore = null
  }
}

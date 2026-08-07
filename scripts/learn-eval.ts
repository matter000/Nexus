#!/usr/bin/env bun
/**
 * learn-eval：学习增益评估脚本（方向四：学习增益可量化）
 * 纯本地读库、无需 LLM，可在 CI 机械执行。
 * 输出：经验总数、教训按状态分布、平均 active 评分、命中率、教训与技能清单。
 *
 * 用法: bun run learn:eval [projectRoot]
 */

import { MemoryStore } from '../src/memory/MemoryStore'

const projectRoot = process.argv[2] ?? process.cwd()

try {
  const store = new MemoryStore(projectRoot)
  const stats = store.getStats()
  const lessons = store.listLessons(undefined, 50)
  const skills = store.listSkills()

  const lines: string[] = []
  lines.push('═══ Nexus 学习增益报告 ═══')
  lines.push(`经验总数: ${stats.experienceCount}`)
  lines.push(
    `教训分布: candidate=${stats.lessonsByStatus.candidate} active=${stats.lessonsByStatus.active} archived=${stats.lessonsByStatus.archived}`,
  )
  lines.push(
    `平均 active 评分: ${stats.avgActiveScore === null ? 'N/A' : stats.avgActiveScore.toFixed(3)}`,
  )
  lines.push(
    `命中成功率: ${stats.hitSuccessRate === null ? 'N/A' : `${(stats.hitSuccessRate * 100).toFixed(1)}%`}`,
  )
  lines.push(`技能数: ${stats.skillCount}`)

  if (lessons.length > 0) {
    lines.push('', '── 教训清单（top 50，按评分降序）──')
    for (const lesson of lessons) {
      lines.push(
        `[#${lesson.id}] [${lesson.status}] [${lesson.kind}] score=${lesson.score.toFixed(3)} hits=${lesson.hitCount} success=${lesson.successCount}`,
        `  trigger: ${lesson.triggerDesc}`,
        `  advice: ${lesson.advice}`,
      )
    }
  }

  if (skills.length > 0) {
    lines.push('', '── 技能清单 ──')
    for (const skill of skills) {
      lines.push(
        `[#${skill.id}] [${skill.status}] ${skill.name} — ${skill.description}（来源 lessons: ${skill.sourceLessonIds.join(',') || '无'}）`,
      )
    }
  }

  console.log(lines.join('\n'))
  store.close()
  process.exit(0)
} catch (err) {
  console.error(`learn-eval 失败: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}

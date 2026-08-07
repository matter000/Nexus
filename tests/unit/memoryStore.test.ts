/**
 * 单元测试: MemoryStore 学习存储层
 * CRUD、教训去重、评分升降与自动归档、容量治理、反思水位线
 */

import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { LESSON_CAP, MemoryStore } from '../../src/memory/MemoryStore'
import type { Experience } from '../../src/memory/types'

const tmpRoot = mkdtempSync(join(tmpdir(), 'nexus-memory-'))
const store = new MemoryStore(tmpRoot)

function makeExperience(overrides: Partial<Experience> = {}): Experience {
  return {
    id: crypto.randomUUID(),
    sessionId: 'test-session',
    summary: '修复测试失败',
    outcome: 'success',
    cost: 0.01,
    durationMs: 1000,
    createdAt: Date.now(),
    ...overrides,
  }
}

/** Windows 上 WAL 模式 close 后文件短暂锁定，删除失败不阻塞测试 */
function safeRm(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    /* 临时目录残留无害，忽略 */
  }
}

afterAll(() => {
  store.close()
  safeRm(tmpRoot)
})

describe('MemoryStore 经验', () => {
  it('recordExperience 记录并可统计', () => {
    store.recordExperience(makeExperience({ summary: '经验-A' }))
    const stats = store.getStats()
    expect(stats.experienceCount).toBeGreaterThanOrEqual(1)
  })
})

describe('MemoryStore 教训', () => {
  it('addLesson 默认 candidate 且 score 为中性 0.5', () => {
    const id = store.addLesson({
      triggerDesc: '当运行测试失败时',
      advice: '应先查看具体断言错误',
      kind: 'failure_pattern',
    })
    const lessons = store.listLessons()
    const lesson = lessons.find((l) => l.id === id)
    expect(lesson).toBeDefined()
    expect(lesson?.status).toBe('candidate')
    expect(lesson?.score).toBe(0.5)
  })

  it('addLesson 相同 trigger+advice 去重不重复插入', () => {
    const a = store.addLesson({
      triggerDesc: '当出现类型错误时',
      advice: '应先运行 tsc 检查',
      kind: 'failure_pattern',
    })
    const b = store.addLesson({
      triggerDesc: '当出现类型错误时',
      advice: '应先运行 tsc 检查',
      kind: 'failure_pattern',
    })
    expect(b).toBe(a)
  })

  it('recordLessonOutcome 成功后 candidate 转正且评分上升', () => {
    const id = store.addLesson({
      triggerDesc: '当修改公共接口时',
      advice: '应同步更新所有调用方',
      kind: 'failure_pattern',
    })
    store.recordLessonOutcome(id, true)
    const lesson = store.listLessons().find((l) => l.id === id)
    // smoothedScore(1, 1) = 2/3 > 0.5
    expect(lesson?.score).toBeCloseTo(2 / 3)
    expect(lesson?.status).toBe('active')
    expect(lesson?.hitCount).toBe(1)
    expect(lesson?.successCount).toBe(1)
  })

  it('recordLessonOutcome 连续失败后评分下降并自动归档', () => {
    const id = store.addLesson({
      triggerDesc: '当使用旧 API 时',
      advice: '应先确认其是否已废弃',
      kind: 'failure_pattern',
    })
    // 3 次命中全部失败: score = (0+1)/(3+2) = 0.2，未跌破阈值(>= 0.2 不算 < 0.2)
    store.recordLessonOutcome(id, false)
    store.recordLessonOutcome(id, false)
    store.recordLessonOutcome(id, false)
    let lesson = store.listLessons().find((l) => l.id === id)
    expect(lesson?.score).toBe(0.2)
    expect(lesson?.status).not.toBe('archived')

    // 第 4 次失败: score = 1/6 < 0.2 且 hits=4 >= 3 → 自动归档
    store.recordLessonOutcome(id, false)
    lesson = store.listLessons().find((l) => l.id === id)
    expect(lesson?.score).toBeCloseTo(1 / 6)
    expect(lesson?.status).toBe('archived')
  })

  it('enforceLessonCap 超出上限按评分淘汰 archived 优先', () => {
    const capStore = new MemoryStore(join(tmpRoot, 'cap'))
    const lowId = capStore.addLesson({
      triggerDesc: '低价值教训-淘汰目标',
      advice: '低价值-应被优先淘汰',
      kind: 'failure_pattern',
    })
    capStore.archiveLesson(lowId)
    for (let i = 0; i < 8; i++) {
      capStore.addLesson({
        triggerDesc: `教训-保留-${i}`,
        advice: `保留内容-${i}`,
        kind: 'success_strategy',
      })
    }
    const deleted = capStore.enforceLessonCap(5)
    expect(deleted).toBe(4)
    // 淘汰后总数 <= 5
    expect(capStore.listLessons(undefined, 100).length).toBeLessThanOrEqual(5)
    // 低分 archived 教训已被淘汰
    const remaining = capStore.listLessons(undefined, 100)
    expect(remaining.some((l) => l.id === lowId)).toBe(false)
    capStore.close()
    safeRm(join(tmpRoot, 'cap'))
  })

  it('LESSON_CAP 默认值为 200', () => {
    expect(LESSON_CAP).toBe(200)
  })
})

describe('MemoryStore 反思水位线', () => {
  it('getUnreflectedExperiences 只返回水位线之上的经验，markReflected 推进水位线', () => {
    const wmStore = new MemoryStore(join(tmpRoot, 'wm'))
    const now = Date.now()
    const oldExp = makeExperience({ createdAt: now - 10000, summary: '旧经验' })
    const newExp = makeExperience({ createdAt: now, summary: '新经验' })
    wmStore.recordExperience(oldExp)
    wmStore.recordExperience(newExp)

    // 未设水位线：两条都可见
    expect(wmStore.getUnreflectedExperiences().length).toBe(2)

    // 水位线推进到 newExp.createdAt：旧经验不再可见
    wmStore.markReflected(newExp.createdAt)
    const pending = wmStore.getUnreflectedExperiences()
    expect(pending.length).toBe(0)

    // 新增一条更晚的经验：重新可见
    const later = makeExperience({ createdAt: now + 10000, summary: '更晚经验' })
    wmStore.recordExperience(later)
    expect(wmStore.getUnreflectedExperiences().length).toBe(1)
    wmStore.close()
    safeRm(join(tmpRoot, 'wm'))
  })
})

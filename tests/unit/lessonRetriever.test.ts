/**
 * 单元测试: LessonRetriever 教训检索
 * 分词、词项重叠评分排序、active 加成、阈值过滤、lastHitIds 记录
 */

import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { LessonRetriever, lexicalScore, tokenize } from '../../src/memory/LessonRetriever'
import { MemoryStore } from '../../src/memory/MemoryStore'

const tmpRoot = mkdtempSync(join(tmpdir(), 'nexus-retriever-'))

/** Windows 上 WAL 模式 close 后文件短暂锁定，删除失败不阻塞测试 */
function safeRm(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    /* 临时目录残留无害，忽略 */
  }
}

afterAll(() => {
  safeRm(tmpRoot)
})

describe('tokenize 分词', () => {
  it('提取 ASCII 单词（小写化，长度 >= 2）', () => {
    const tokens = tokenize('Fix TypeScript errors in src/App.tsx')
    expect(tokens.has('fix')).toBe(true)
    expect(tokens.has('typescript')).toBe(true)
    expect(tokens.has('errors')).toBe(true)
    expect(tokens.has('in')).toBe(true) // 双字符词也产生 token
    expect(tokens.has('src')).toBe(true)
  })

  it('单字符 ASCII 不产生 token', () => {
    const tokens = tokenize('a b c')
    expect(tokens.size).toBe(0)
  })

  it('中文按字二元组切分', () => {
    const tokens = tokenize('修复测试失败')
    expect(tokens.has('修复')).toBe(true)
    expect(tokens.has('复测')).toBe(true)
    expect(tokens.has('测试')).toBe(true)
    expect(tokens.has('试失')).toBe(true)
    expect(tokens.has('失败')).toBe(true)
  })

  it('单个中文字保留单字', () => {
    const tokens = tokenize('修')
    expect(tokens.has('修')).toBe(true)
  })
})

describe('lexicalScore 词项重叠评分', () => {
  it('完全重叠得 1 分，无重叠得 0 分', () => {
    expect(lexicalScore(tokenize('修复测试'), tokenize('修复测试'))).toBe(1)
    expect(lexicalScore(tokenize('修复测试'), tokenize('部署发布'))).toBe(0)
  })

  it('短查询命中长文档也能得高分（分母取较小集合）', () => {
    // 查询 2 个 token，文档 6 个 token，交集 2 → 2/2 = 1
    const q = tokenize('测试失败')
    const doc = tokenize('当运行测试失败时应该先查看断言')
    expect(lexicalScore(q, doc)).toBe(1)
  })

  it('空集合得 0 分', () => {
    expect(lexicalScore(new Set(), tokenize('abc'))).toBe(0)
    expect(lexicalScore(tokenize('abc'), new Set())).toBe(0)
  })
})

describe('LessonRetriever.retrieve', () => {
  it('按相关性排序返回 top-K，active 教训享受加成', async () => {
    const isolated = new MemoryStore(join(tmpRoot, 'sort'))
    try {
      const idA = isolated.addLesson({
        triggerDesc: '当运行测试失败时',
        advice: '应先查看具体断言错误',
        kind: 'failure_pattern',
      })
      const idB = isolated.addLesson({
        triggerDesc: '当测试环境部署时',
        advice: '应确认环境变量齐全',
        kind: 'failure_pattern',
      })
      isolated.activateLesson(idA)

      const retriever = new LessonRetriever(isolated, { disableEmbedding: true })
      const results = await retriever.retrieve('运行测试失败', 3)

      // A（active）词项重叠 5/5 = 1.0 + 0.1 加成；B 仅重叠"测试" 1/min(5,6) = 0.2
      expect(results.length).toBe(2)
      expect(results[0].lesson.id).toBe(idA)
      expect(results[1].lesson.id).toBe(idB)
      expect(results[0].score).toBeGreaterThan(results[1].score)
      // lastHitIds 记录本次命中
      expect(retriever.lastHitIds).toEqual([idA, idB])
    } finally {
      isolated.close()
      safeRm(join(tmpRoot, 'sort'))
    }
  })

  it('低于相关性阈值的教训被过滤', async () => {
    const isolated = new MemoryStore(join(tmpRoot, 'threshold'))
    try {
      isolated.addLesson({
        triggerDesc: '当处理图片资源时',
        advice: '应压缩后再上传',
        kind: 'success_strategy',
      })
      const retriever = new LessonRetriever(isolated, { disableEmbedding: true })
      // 查询与教训无任何词项重叠 → 0 分 < 0.08 → 不返回
      const results = await retriever.retrieve('数据库迁移失败', 3)
      expect(results).toEqual([])
      expect(retriever.lastHitIds).toEqual([])
    } finally {
      isolated.close()
      safeRm(join(tmpRoot, 'threshold'))
    }
  })

  it('空查询或空库返回空数组', async () => {
    const isolated = new MemoryStore(join(tmpRoot, 'empty'))
    try {
      const retriever = new LessonRetriever(isolated, { disableEmbedding: true })
      expect(await retriever.retrieve('')).toEqual([])
      expect(await retriever.retrieve('   ')).toEqual([])
      expect(await retriever.retrieve('任何查询')).toEqual([])
    } finally {
      isolated.close()
      safeRm(join(tmpRoot, 'empty'))
    }
  })
})

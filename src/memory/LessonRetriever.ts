/**
 * 教训检索器
 * 按当前任务文本检索相关教训，供 Assembler 注入系统提示。
 * 默认使用确定性词项重叠打分（可测试、零模型依赖）；
 * embedding 可用时（懒加载 @xenova/transformers）与词项分按 0.5/0.5 加权。
 *
 * 检索范围包含 candidate + active：candidate 必须在真实任务命中中积累验证样本，
 * 否则永远无法转正（验证闭环的前提）。active 享受小幅排序加成。
 */

import type { MemoryStore } from './MemoryStore'
import type { Lesson } from './types'

/** active 教训的排序加成（已验证经验优先于待验证经验） */
const ACTIVE_BONUS = 0.1
/** 低于该分数的检索结果视为不相关，直接丢弃 */
const MIN_RELEVANCE = 0.08

/**
 * 中英文混合分词：ASCII 按单词切分（小写化），中文按字二元组切分。
 * 纯函数导出，便于单测。
 */
export function tokenize(text: string): Set<string> {
  const tokens = new Set<string>()

  // ASCII 单词（长度 >= 2 才有区分度）
  const asciiWords = text.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []
  for (const word of asciiWords) {
    tokens.add(word)
  }

  // 中文字符提取后按二元组切分（单字区分度太低）
  const cjkChars = text.match(/[\u4e00-\u9fff]/g) ?? []
  for (let i = 0; i < cjkChars.length - 1; i++) {
    tokens.add(cjkChars[i] + cjkChars[i + 1])
  }
  // 仅一个中文字时保留单字
  if (cjkChars.length === 1) tokens.add(cjkChars[0])

  return tokens
}

/**
 * 词项重叠评分（Jaccard 变体）：交集 / 较小集合大小。
 * 用较小集合做分母，让"短查询命中长教训"也能得到高分。
 * 纯函数导出，便于单测。
 */
export function lexicalScore(queryTokens: Set<string>, docTokens: Set<string>): number {
  if (queryTokens.size === 0 || docTokens.size === 0) return 0
  let intersection = 0
  for (const token of queryTokens) {
    if (docTokens.has(token)) intersection++
  }
  if (intersection === 0) return 0
  return intersection / Math.min(queryTokens.size, docTokens.size)
}

export interface RetrievedLesson {
  lesson: Lesson
  score: number
}

export class LessonRetriever {
  private store: MemoryStore
  private pipeline:
    | ((text: string, opts: Record<string, unknown>) => Promise<{ data: Float32Array }>)
    | null = null
  private embeddingFailed = false
  /** 教训文本 → 向量的缓存（lesson id 维度） */
  private embeddingCache = new Map<number, Float32Array>()
  /** 禁用 embedding（测试等需要确定性打分的场景） */
  private disableEmbedding: boolean
  /** 最近一次检索命中的教训 id（供 Orchestrator 记录验证结果） */
  lastHitIds: number[] = []

  constructor(store: MemoryStore, opts: { disableEmbedding?: boolean } = {}) {
    this.store = store
    this.disableEmbedding = opts.disableEmbedding ?? false
  }

  /**
   * 检索与查询相关的 top-K 教训。
   * 永不抛错：embedding 不可用时自动降级为纯词项打分。
   */
  async retrieve(query: string, topK = 3): Promise<RetrievedLesson[]> {
    const lessons = this.store.getRetrievableLessons()
    if (lessons.length === 0 || !query.trim()) return []

    const queryTokens = tokenize(query)
    const queryEmbedding = await this.tryEmbed(query)

    const scored: RetrievedLesson[] = []
    for (const lesson of lessons) {
      const docText = `${lesson.triggerDesc} ${lesson.advice}`
      const lexical = lexicalScore(queryTokens, tokenize(docText))

      let combined = lexical
      if (queryEmbedding) {
        const docEmbedding = await this.getLessonEmbedding(lesson, docText)
        if (docEmbedding) {
          const semantic = cosineSimilarity(queryEmbedding, docEmbedding)
          // 余弦相似度归一化到 [0,1]（模型输出可能为负相关）
          combined = 0.5 * lexical + 0.5 * Math.max(0, semantic)
        }
      }

      if (lesson.status === 'active') combined += ACTIVE_BONUS
      if (combined >= MIN_RELEVANCE) {
        scored.push({ lesson, score: combined })
      }
    }

    scored.sort((a, b) => b.score - a.score)
    const top = scored.slice(0, topK)
    this.lastHitIds = top.map((r) => r.lesson.id)
    return top
  }

  /** 懒加载 embedding pipeline；失败一次后不再重试（避免每次检索都卡加载） */
  private async tryEmbed(text: string): Promise<Float32Array | null> {
    if (this.embeddingFailed || this.disableEmbedding) return null
    try {
      if (!this.pipeline) {
        const transformers = await import('@xenova/transformers')
        const pipe = await transformers.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')
        this.pipeline = pipe as unknown as (
          text: string,
          opts: Record<string, unknown>,
        ) => Promise<{ data: Float32Array }>
      }
      const output = await this.pipeline(text, { pooling: 'mean', normalize: true })
      return output.data
    } catch {
      this.embeddingFailed = true
      this.pipeline = null
      return null
    }
  }

  private async getLessonEmbedding(lesson: Lesson, text: string): Promise<Float32Array | null> {
    const cached = this.embeddingCache.get(lesson.id)
    if (cached) return cached
    const embedding = await this.tryEmbed(text)
    if (embedding) this.embeddingCache.set(lesson.id, embedding)
    return embedding
  }
}

/** 余弦相似度（向量均已归一化，但为健壮性仍完整计算） */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

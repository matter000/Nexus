/**
 * 语义检索 (v1.1)
 * 使用 @xenova/transformers 本地 embedding + SQLite 存储 + 余弦相似度搜索
 *
 * 隐私底线: embedding 模型跑本地 (Xenova/all-MiniLM-L6-v2), 不把代码发外部
 * 回退策略: 如果 embedding 模型加载失败, 自动降级为 TF-IDF 关键词匹配
 */

import { Database } from 'bun:sqlite'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'

// ─── 类型定义 ──────────────────────────────────────────────────────────────────

export interface SearchResult {
  filePath: string
  startLine: number
  endLine: number
  content: string
  score: number
  symbol?: string
}

export interface EmbeddingRecord {
  id: string
  filePath: string
  startLine: number
  endLine: number
  content: string
  embedding: Float32Array
}

// ─── 配置常量 ──────────────────────────────────────────────────────────────────

const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2'
const MAX_CHUNK_CHARS = 1500
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx'])
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.nexus',
  '.qoder',
  'build',
  'coverage',
  '.cache',
  '.next',
  '.output',
])

// ─── Embedding Pipeline 类型 ──────────────────────────────────────────────────

type EmbeddingPipeline = (
  text: string,
  opts?: Record<string, unknown>,
) => Promise<{ data: Float32Array; dims: number[] }>

// ─── 语义搜索引擎 ──────────────────────────────────────────────────────────────

export class SemanticSearchEngine {
  private projectRoot: string
  private initialized = false
  private initPromise: Promise<void> | null = null
  private db: Database | null = null
  private pipeline: EmbeddingPipeline | null = null
  private useEmbedding = false
  private tfidfIndex: TfidfIndex | null = null
  private statsCache: { totalChunks: number; totalFiles: number } | null = null

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot
  }

  /** 初始化: 加载模型 + 构建索引 (幂等) */
  async init(): Promise<void> {
    if (this.initialized) return
    if (this.initPromise) return this.initPromise

    this.initPromise = this._doInit().finally(() => {
      this.initPromise = null
    })
    return this.initPromise
  }

  private async _doInit(): Promise<void> {
    // 尝试加载 embedding 模型
    try {
      // 动态 import — 如果 @xenova/transformers 未安装或运行时报错则降级
      const transformers = await import('@xenova/transformers')
      // 配置本地缓存目录, 避免权限问题
      if (transformers.env) {
        transformers.env.cacheDir = join(this.projectRoot, '.nexus', 'models')
        transformers.env.allowLocalModels = true
      }
      const pipe = await transformers.pipeline('feature-extraction', EMBEDDING_MODEL)
      this.pipeline = pipe as unknown as EmbeddingPipeline
      this.useEmbedding = true
    } catch {
      // 模型加载失败 → 降级为 TF-IDF
      this.useEmbedding = false
    }

    // 连接 SQLite
    this.db = this.getDb()

    // 构建/刷新索引
    await this.buildIndex()

    this.initialized = true
  }

  /** 语义搜索: 返回 top-K 相似代码块 */
  async search(query: string, topK = 5): Promise<SearchResult[]> {
    if (!this.initialized) await this.init()

    if (this.useEmbedding && this.pipeline && this.db) {
      return this.embeddingSearch(query, topK)
    }
    return this.tfidfSearch(query, topK)
  }

  /** 增量索引: 只重算变化的文件 */
  async reindex(changedFiles: string[]): Promise<void> {
    if (!this.initialized) await this.init()
    if (!this.db) return

    for (const file of changedFiles) {
      this.deleteFileChunks(file)
      if (this.isCodeFile(file)) {
        const fullPath = join(this.projectRoot, file)
        try {
          const content = readFileSync(fullPath, 'utf-8')
          await this.indexFile(file, content)
        } catch {
          /* file may have been deleted */
        }
      }
    }
    this.statsCache = null
  }

  /** 获取索引统计 */
  getStats(): { totalChunks: number; totalFiles: number } {
    if (this.statsCache) return this.statsCache
    if (!this.db) return { totalChunks: 0, totalFiles: 0 }

    const totalRow = this.db.prepare('SELECT COUNT(*) as count FROM embeddings').get() as {
      count: number
    }
    const fileRow = this.db
      .prepare('SELECT COUNT(DISTINCT file_path) as count FROM embeddings')
      .get() as { count: number }

    this.statsCache = { totalChunks: totalRow.count, totalFiles: fileRow.count }
    return this.statsCache
  }

  // ─── Embedding 搜索 ────────────────────────────────────────────────────────

  private async embeddingSearch(query: string, topK: number): Promise<SearchResult[]> {
    const queryEmbedding = await this.getEmbedding(query)

    const allChunks = this.getAllChunks()
    const scored: SearchResult[] = []

    for (const chunk of allChunks) {
      const score = cosineSimilarity(queryEmbedding, chunk.embedding)
      scored.push({
        filePath: chunk.file_path,
        startLine: chunk.start_line,
        endLine: chunk.end_line,
        content: chunk.content,
        score,
      })
    }

    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, topK)
  }

  // ─── 索引构建 ──────────────────────────────────────────────────────────────

  private async buildIndex(): Promise<void> {
    if (!this.db) return

    const existingCount = this.db.prepare('SELECT COUNT(*) as count FROM embeddings').get() as {
      count: number
    }
    if (existingCount.count > 0) return // 已有索引, 跳过

    const files = this.scanProject()

    for (const relPath of files) {
      try {
        const fullPath = join(this.projectRoot, relPath)
        const content = readFileSync(fullPath, 'utf-8')
        await this.indexFile(relPath, content)
      } catch {
        /* skip unreadable files */
      }
    }

    this.statsCache = null
  }

  private async indexFile(relPath: string, content: string): Promise<void> {
    if (!this.db) return

    const chunks = chunkCode(content)
    const insertStmt = this.db.prepare(
      `INSERT OR REPLACE INTO embeddings (id, file_path, start_line, end_line, content, embedding, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )

    const now = Date.now()

    for (const chunk of chunks) {
      const id = `${relPath}:${chunk.startLine}-${chunk.endLine}`

      let embeddingBlob: Buffer | null = null
      if (this.useEmbedding && this.pipeline) {
        try {
          const embedding = await this.getEmbedding(chunk.content)
          embeddingBlob = float32ToBuffer(embedding)
        } catch {
          /* skip embedding for this chunk */
        }
      }

      insertStmt.run(
        id,
        relPath,
        chunk.startLine,
        chunk.endLine,
        chunk.content,
        embeddingBlob,
        now,
        now,
      )
    }

    // 如果 embedding 不可用, 构建 TF-IDF 索引
    if (!this.useEmbedding) {
      this.tfidfIndex = null // 清除缓存, 下次搜索时重建
    }
  }

  private async getEmbedding(text: string): Promise<Float32Array> {
    if (!this.pipeline) throw new Error('Embedding pipeline not loaded')
    const output = await this.pipeline(text, { pooling: 'mean', normalize: true })
    return output.data as Float32Array
  }

  // ─── TF-IDF 回退搜索 ──────────────────────────────────────────────────────

  private tfidfSearch(query: string, topK: number): Promise<SearchResult[]> {
    if (!this.tfidfIndex) {
      this.tfidfIndex = buildTfidfIndex(this.projectRoot)
    }
    return Promise.resolve(searchTfidf(this.tfidfIndex, query, topK))
  }

  // ─── DB 辅助方法 ──────────────────────────────────────────────────────────

  private getDb(): Database {
    const nexusDir = join(this.projectRoot, '.nexus')
    const dbPath = join(nexusDir, 'nexus.db')
    const db = new Database(dbPath)
    db.exec('PRAGMA journal_mode = WAL')

    // 确保 embeddings 表存在 (migration v2)
    db.exec(`
      CREATE TABLE IF NOT EXISTS embeddings (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        content TEXT NOT NULL,
        embedding BLOB,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_embeddings_file ON embeddings(file_path);
    `)
    return db
  }

  private deleteFileChunks(filePath: string): void {
    if (!this.db) return
    this.db.prepare('DELETE FROM embeddings WHERE file_path = ?').run(filePath)
  }

  private getAllChunks(): Array<{
    file_path: string
    start_line: number
    end_line: number
    content: string
    embedding: Float32Array
  }> {
    if (!this.db) return []
    const rows = this.db
      .prepare('SELECT file_path, start_line, end_line, content, embedding FROM embeddings')
      .all() as Array<{
      file_path: string
      start_line: number
      end_line: number
      content: string
      embedding: Buffer | null
    }>
    return rows
      .filter((r) => r.embedding != null)
      .map((r) => ({
        file_path: r.file_path,
        start_line: r.start_line,
        end_line: r.end_line,
        content: r.content,
        embedding: bufferToFloat32(r.embedding!),
      }))
  }

  // ─── 文件扫描 ──────────────────────────────────────────────────────────────

  private scanProject(): string[] {
    const files: string[] = []
    const scan = (dir: string): void => {
      let entries: import('fs').Dirent[]
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const fullPath = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (!IGNORED_DIRS.has(entry.name)) scan(fullPath)
        } else if (entry.isFile()) {
          const relPath = relative(this.projectRoot, fullPath).replace(/\\/g, '/')
          if (this.isCodeFile(relPath)) files.push(relPath)
        }
      }
    }
    scan(this.projectRoot)
    return files
  }

  private isCodeFile(filePath: string): boolean {
    return CODE_EXTENSIONS.has(filePath.substring(filePath.lastIndexOf('.')))
  }
}

// ─── 全局单例 ──────────────────────────────────────────────────────────────────

let _instance: SemanticSearchEngine | null = null

export function getSemanticSearchEngine(projectRoot: string): SemanticSearchEngine {
  if (!_instance) _instance = new SemanticSearchEngine(projectRoot)
  return _instance
}

// ─── 文件分块 ──────────────────────────────────────────────────────────────────

interface CodeChunk {
  startLine: number
  endLine: number
  content: string
}

function chunkCode(source: string): CodeChunk[] {
  const lines = source.split('\n')
  const chunks: CodeChunk[] = []
  let currentStart = 0
  let currentLines: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    currentLines.push(line)

    const isBlank = line.trim() === ''
    const isEnd = i === lines.length - 1

    if (isBlank || isEnd) {
      const blockContent = currentLines.join('\n').trim()
      if (blockContent.length > 0) {
        if (blockContent.length > MAX_CHUNK_CHARS && currentLines.length > 3) {
          // 块太大: 尝试从中间的空行处分割
          const mid = Math.floor(currentLines.length / 2)
          let splitAt = mid
          for (let j = mid; j >= 0 && j < currentLines.length; j++) {
            if (currentLines[j].trim() === '') {
              splitAt = j
              break
            }
          }
          const first = currentLines.slice(0, splitAt).join('\n').trim()
          const second = currentLines.slice(splitAt).join('\n').trim()
          if (first)
            chunks.push({
              startLine: currentStart + 1,
              endLine: currentStart + splitAt,
              content: first,
            })
          if (second)
            chunks.push({ startLine: currentStart + splitAt + 1, endLine: i + 1, content: second })
        } else {
          chunks.push({ startLine: currentStart + 1, endLine: i + 1, content: blockContent })
        }
      }
      currentStart = i + 1
      currentLines = []
    }
  }

  // 处理尾部未以空行结尾的内容
  if (currentLines.length > 0) {
    const blockContent = currentLines.join('\n').trim()
    if (blockContent.length > 0) {
      chunks.push({ startLine: currentStart + 1, endLine: lines.length, content: blockContent })
    }
  }

  // 合并过小的相邻块
  const merged: CodeChunk[] = []
  for (const chunk of chunks) {
    const last = merged[merged.length - 1]
    if (last && last.content.length + chunk.content.length < MAX_CHUNK_CHARS) {
      last.endLine = chunk.endLine
      last.content += '\n\n' + chunk.content
    } else {
      merged.push({ ...chunk })
    }
  }

  return merged.length > 0 ? merged : [{ startLine: 1, endLine: lines.length, content: source }]
}

// ─── 余弦相似度 ────────────────────────────────────────────────────────────────

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0
  let dot = 0,
    normA = 0,
    normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

// ─── Float32Array ↔ Buffer 转换 ────────────────────────────────────────────────

function float32ToBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)
}

function bufferToFloat32(buf: Buffer): Float32Array {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  return new Float32Array(ab)
}

// ─── TF-IDF 回退实现 ──────────────────────────────────────────────────────────

interface TfidfChunk {
  filePath: string
  startLine: number
  endLine: number
  content: string
  terms: Map<string, number> // term → tf
}

interface TfidfIndex {
  chunks: TfidfChunk[]
  df: Map<string, number> // term → 包含该 term 的 chunk 数量
  totalChunks: number
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2)
}

function buildTfidfIndex(projectRoot: string): TfidfIndex {
  const chunks: TfidfChunk[] = []
  const df = new Map<string, number>()

  const files = scanProjectFiles(projectRoot)
  for (const { relPath, content } of files) {
    const codeChunks = chunkCode(content)
    for (const chunk of codeChunks) {
      const terms = new Map<string, number>()
      const tokens = tokenize(chunk.content)
      const uniqueTerms = new Set<string>()
      for (const token of tokens) {
        terms.set(token, (terms.get(token) ?? 0) + 1)
        uniqueTerms.add(token)
      }
      // 归一化 TF
      const total = tokens.length || 1
      for (const [term, count] of terms) {
        terms.set(term, count / total)
      }
      for (const term of uniqueTerms) {
        df.set(term, (df.get(term) ?? 0) + 1)
      }
      chunks.push({
        filePath: relPath,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        content: chunk.content,
        terms,
      })
    }
  }

  return { chunks, df, totalChunks: chunks.length }
}

function searchTfidf(index: TfidfIndex, query: string, topK: number): SearchResult[] {
  const queryTerms = tokenize(query)
  if (queryTerms.length === 0) return []

  const scored: SearchResult[] = []
  for (const chunk of index.chunks) {
    let score = 0
    for (const term of queryTerms) {
      const tf = chunk.terms.get(term) ?? 0
      const docFreq = index.df.get(term) ?? 0
      if (tf > 0 && docFreq > 0) {
        const idf = Math.log((index.totalChunks + 1) / (docFreq + 1)) + 1
        score += tf * idf
      }
    }
    if (score > 0) {
      scored.push({
        filePath: chunk.filePath,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        content: chunk.content,
        score,
      })
    }
  }

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, topK)
}

function scanProjectFiles(projectRoot: string): Array<{ relPath: string; content: string }> {
  const results: Array<{ relPath: string; content: string }> = []

  const scan = (dir: string): void => {
    let entries: import('fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) scan(fullPath)
      } else if (
        entry.isFile() &&
        CODE_EXTENSIONS.has(entry.name.substring(entry.name.lastIndexOf('.')))
      ) {
        try {
          const content = readFileSync(fullPath, 'utf-8')
          const relPath = relative(projectRoot, fullPath).replace(/\\/g, '/')
          results.push({ relPath, content })
        } catch {
          /* skip */
        }
      }
    }
  }

  scan(projectRoot)
  return results
}

// ─── 工具定义 ──────────────────────────────────────────────────────────────────

export const semanticSearchToolDefinition = {
  name: 'semantic_search',
  description:
    '语义搜索代码。与 grep 不同,语义搜索能跨词面匹配(如搜索"登录"能找到 authenticate、signIn)。返回最相关的代码块。',
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string' as const,
        description: '搜索查询(自然语言或代码片段)',
      },
      top_k: {
        type: 'number' as const,
        description: '返回结果数量(默认 5)',
      },
    },
    required: ['query'],
  },
  requiresApproval: false,
  phase: 'both' as const,
}

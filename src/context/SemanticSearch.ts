/**
 * 语义检索 (v1.1 引入)
 * 本地 embedding + SQLite 索引,跨词面匹配
 * 隐私底线: embedding 模型跑本地(transformers.js),不把代码发外部
 *
 * 当前为 placeholder,Phase 4 实现完整功能
 */

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

/**
 * 语义搜索引擎
 * TODO Phase 4: 使用 transformers.js (Xenova/all-MiniLM-L6-v2) 实现本地 embedding
 */
export class SemanticSearchEngine {
  private projectRoot: string
  private initialized = false

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot
  }

  /** 初始化:加载模型 + 建立索引 */
  async init(): Promise<void> {
    // TODO Phase 4:
    // 1. 加载 transformers.js embedding 模型
    // 2. 扫描项目文件,切分函数级代码块
    // 3. 计算 embedding 并存入 SQLite
    this.initialized = true
  }

  /** 语义搜索:返回 top-K 相似代码块 */
  async search(query: string, topK = 5): Promise<SearchResult[]> {
    if (!this.initialized) {
      await this.init()
    }

    // TODO Phase 4:
    // 1. 将 query 转为 embedding
    // 2. 在 SQLite 中做余弦相似度搜索
    // 3. 返回 top-K 结果
    return []
  }

  /** 增量索引:只重算变化的文件 */
  async reindex(changedFiles: string[]): Promise<void> {
    // TODO Phase 4:
    // 1. 删除变化文件的旧 embedding
    // 2. 重新切分 + 计算 embedding
    // 3. 写入 SQLite
  }

  /** 获取索引统计 */
  getStats(): { totalChunks: number; totalFiles: number } {
    // TODO Phase 4: 从 SQLite 查询
    return { totalChunks: 0, totalFiles: 0 }
  }
}

/**
 * semantic_search 工具定义
 * Phase 4 注册到工具层
 */
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

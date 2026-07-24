/**
 * 代码图谱 (v1.1 引入)
 * 用 tree-sitter 解析每个文件,提取函数/类/方法的签名 + docstring
 * 生成“地图”(每文件压缩到几行),常驻 L1 上下文
 *
 * 当前为 TypeScript 侧空图谱 fallback
 * v2 时由 Go 引擎的 tree-sitter 后台索引服务提供实现
 */

export interface CodeSymbol {
  name: string
  kind: 'function' | 'class' | 'method' | 'interface' | 'type' | 'variable'
  filePath: string
  startLine: number
  endLine: number
  signature: string
  docstring?: string
  exports: boolean
}

export interface FileSkeleton {
  filePath: string
  symbols: CodeSymbol[]
  imports: string[]
  lineCount: number
}

export interface CodeGraph {
  files: Map<string, FileSkeleton>
  /** 符号名 → 定义位置 */
  symbolIndex: Map<string, CodeSymbol[]>
  /** 文件 → 依赖的文件 */
  dependencyGraph: Map<string, string[]>
}

// ─── GraphEngine 接口 (零改动迁移保证) ─────────────────────────────────────

/**
 * 代码图谱引擎接口
 * Agent 编排层通过此接口访问代码图谱,不直接依赖具体实现
 *
 * v2 引入 Go 引擎时:
 * - Go 端运行 tree-sitter 后台索引服务,监听文件变更增量更新
 * - TypeScript 侧通过 IPC/gRPC 调用 Go 引擎的索引结果
 * - 替换 TypeScriptGraphEngine 为 GoGraphEngine,Agent loop 零改动
 *
 * TODO v2 对接方式:
 * ```typescript
 * class GoGraphEngine implements GraphEngine {
 *   private rpc: GoRpcClient
 *
 *   constructor(enginePath: string) {
 *     // 启动 Go 后台索引守护进程
 *     this.rpc = new GoRpcClient(enginePath, ['--mode', 'index'])
 *   }
 *
 *   async buildGraph(projectRoot: string): Promise<CodeGraph> {
 *     return this.rpc.call('build_graph', { projectRoot })
 *   }
 *
 *   async querySymbol(name: string): Promise<CodeSymbol[]> {
 *     return this.rpc.call('query_symbol', { name })
 *   }
 *
 *   async getDependencies(filePath: string): Promise<string[]> {
 *     return this.rpc.call('get_dependencies', { filePath })
 *   }
 *
 *   isAvailable(): boolean {
 *     return this.rpc.isConnected()
 *   }
 * }
 * ```
 */
export interface GraphEngine {
  /** 构建全量代码图谱 */
  buildGraph(projectRoot: string): Promise<CodeGraph>

  /** 查询符号定义(跨文件) */
  querySymbol(name: string): Promise<CodeSymbol[]>

  /** 获取文件的依赖列表 */
  getDependencies(filePath: string): Promise<string[]>

  /** 增量更新:只重算变化的文件 */
  updateGraph(changedFiles: string[]): Promise<CodeGraph>

  /** 检测引擎是否可用 */
  isAvailable(): boolean

  /** 引擎名称 */
  readonly name: string
}

// ─── TypeScript 默认实现 (空图谱 fallback) ─────────────────────────────────

/**
 * TypeScript 侧图谱引擎
 * 当前返回空图谱,作为 Go 引擎不可用时的 fallback
 */
export class TypeScriptGraphEngine implements GraphEngine {
  readonly name = 'typescript'
  private graph: CodeGraph = { files: new Map(), symbolIndex: new Map(), dependencyGraph: new Map() }

  async buildGraph(_projectRoot: string): Promise<CodeGraph> {
    // TODO Phase 4: 使用 tree-sitter (WASM) 实现本地 AST 解析
    return this.graph
  }

  async querySymbol(_name: string): Promise<CodeSymbol[]> {
    return []
  }

  async getDependencies(_filePath: string): Promise<string[]> {
    return []
  }

  async updateGraph(_changedFiles: string[]): Promise<CodeGraph> {
    return this.graph
  }

  isAvailable(): boolean {
    return true
  }
}

/**
 * 创建图谱引擎实例
 * 当前返回 TypeScriptGraphEngine;v2 时检测 Go 引擎是否可用
 */
export function createGraphEngine(): GraphEngine {
  // TODO v2: 检测 Go 引擎二进制是否存在
  // const goEnginePath = findGoEngine()
  // if (goEnginePath) return new GoGraphEngine(goEnginePath)
  return new TypeScriptGraphEngine()
}

/**
 * 构建代码图谱(便捷函数,委托给 GraphEngine)
 */
export async function buildCodeGraph(projectRoot: string): Promise<CodeGraph> {
  const engine = createGraphEngine()
  return engine.buildGraph(projectRoot)
}

/**
 * 将代码图谱格式化为 L1 上下文片段
 * 让 agent 知道全库有什么,而不需要逐文件 read
 */
export function formatGraphForContext(graph: CodeGraph): string {
  if (graph.files.size === 0) {
    return ''
  }

  const parts: string[] = ['## 代码地图']
  for (const [filePath, skeleton] of graph.files) {
    const symbols = skeleton.symbols
      .map((s) => `  ${s.kind} ${s.signature}`)
      .join('\n')
    parts.push(`### ${filePath}\n${symbols}`)
  }
  return parts.join('\n\n')
}

/**
 * 增量更新:只重算变化的文件(便捷函数,委托给 GraphEngine)
 */
export async function updateCodeGraph(
  graph: CodeGraph,
  changedFiles: string[]
): Promise<CodeGraph> {
  const engine = createGraphEngine()
  return engine.updateGraph(changedFiles)
}

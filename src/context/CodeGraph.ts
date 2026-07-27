/**
 * 代码图谱 (v1.1 引入)
 * 使用 TypeScript Compiler API 解析 TS/JS 文件
 * 提取函数/类/接口/类型声明 + import/export 关系
 * 生成"地图"(每文件压缩到几行),常驻 L1 上下文
 */

import ts from 'typescript'
import { readdir, readFile } from 'fs/promises'
import { join, relative, extname } from 'path'
import { getParserForFile, getSupportedExtensions } from './parsers/index'

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

// ─── 排除目录 ──────────────────────────────────────────────────────────────

const EXCLUDED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt',
  'coverage', '__pycache__', '.cache', 'bun.lock',
])

const SUPPORTED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', ...getSupportedExtensions()])

// ─── 文件遍历 ──────────────────────────────────────────────────────────────

async function collectFiles(dir: string, rootDir: string): Promise<string[]> {
  const results: string[] = []
  let entries: import('fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return results
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) {
        results.push(...await collectFiles(fullPath, rootDir))
      }
    } else if (entry.isFile()) {
      const ext = extname(entry.name)
      if (SUPPORTED_EXTENSIONS.has(ext)) {
        results.push(relative(rootDir, fullPath).replace(/\\/g, '/'))
      }
    }
  }
  return results
}

// ─── AST 解析 ──────────────────────────────────────────────────────────────

function getJSDocComment(node: ts.Node, sourceFile: ts.SourceFile): string | undefined {
  const jsDoc = (node as unknown as { jsDoc?: ts.JSDoc[] }).jsDoc
  if (jsDoc && jsDoc.length > 0) {
    return jsDoc.map((d) => d.comment ?? '').filter(Boolean).join('\n') || undefined
  }
  return undefined
}

function getSignature(node: ts.Node, sourceFile: ts.SourceFile): string {
  // Get just the first line or a compact representation
  const text = node.getText(sourceFile)
  const firstLine = text.split('\n')[0].trim()
  // Truncate long signatures
  return firstLine.length > 120 ? firstLine.slice(0, 120) + '...' : firstLine
}

function isExported(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false
}

function parseSourceFile(content: string, filePath: string): { symbols: CodeSymbol[]; imports: string[]; lineCount: number } {
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )

  const symbols: CodeSymbol[] = []
  const imports: string[] = []
  const lineCount = sourceFile.getLineAndCharacterOfPosition(sourceFile.getEnd()).line + 1

  function visit(node: ts.Node): void {
    // Extract imports
    if (ts.isImportDeclaration(node)) {
      const moduleSpec = node.moduleSpecifier
      if (ts.isStringLiteral(moduleSpec)) {
        imports.push(moduleSpec.text)
      }
    }

    // Function declarations
    if (ts.isFunctionDeclaration(node) && node.name) {
      const startLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
      const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1
      symbols.push({
        name: node.name.text,
        kind: 'function',
        filePath,
        startLine,
        endLine,
        signature: getSignature(node, sourceFile),
        docstring: getJSDocComment(node, sourceFile),
        exports: isExported(node),
      })
    }

    // Class declarations
    if (ts.isClassDeclaration(node) && node.name) {
      const startLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
      const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1
      symbols.push({
        name: node.name.text,
        kind: 'class',
        filePath,
        startLine,
        endLine,
        signature: getSignature(node, sourceFile),
        docstring: getJSDocComment(node, sourceFile),
        exports: isExported(node),
      })
      // Extract methods (top-level only, don't recurse into function bodies)
      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) && member.name) {
          const mName = ts.isIdentifier(member.name) ? member.name.text : member.name.getText(sourceFile)
          const mStartLine = sourceFile.getLineAndCharacterOfPosition(member.getStart(sourceFile)).line + 1
          const mEndLine = sourceFile.getLineAndCharacterOfPosition(member.getEnd()).line + 1
          symbols.push({
            name: `${node.name.text}.${mName}`,
            kind: 'method',
            filePath,
            startLine: mStartLine,
            endLine: mEndLine,
            signature: getSignature(member, sourceFile),
            docstring: getJSDocComment(member, sourceFile),
            exports: false,
          })
        }
      }
      return // Don't recurse deeper into class body
    }

    // Interface declarations
    if (ts.isInterfaceDeclaration(node) && node.name) {
      const startLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
      const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1
      symbols.push({
        name: node.name.text,
        kind: 'interface',
        filePath,
        startLine,
        endLine,
        signature: getSignature(node, sourceFile),
        docstring: getJSDocComment(node, sourceFile),
        exports: isExported(node),
      })
    }

    // Type alias declarations
    if (ts.isTypeAliasDeclaration(node) && node.name) {
      const startLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
      const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1
      symbols.push({
        name: node.name.text,
        kind: 'type',
        filePath,
        startLine,
        endLine,
        signature: getSignature(node, sourceFile),
        docstring: getJSDocComment(node, sourceFile),
        exports: isExported(node),
      })
    }

    // Top-level variable declarations (const/let/var)
    if (ts.isVariableStatement(node) && isExported(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          const startLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
          const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1
          symbols.push({
            name: decl.name.text,
            kind: 'variable',
            filePath,
            startLine,
            endLine,
            signature: getSignature(node, sourceFile),
            docstring: getJSDocComment(node, sourceFile),
            exports: true,
          })
        }
      }
    }

    ts.forEachChild(node, visit)
  }

  ts.forEachChild(sourceFile, visit)

  return { symbols, imports, lineCount }
}

// ─── TypeScript 默认实现 ─────────────────────────────────────────────────

/**
 * TypeScript 侧图谱引擎
 * 使用 TypeScript Compiler API 解析文件,提取代码结构
 */
export class TypeScriptGraphEngine implements GraphEngine {
  readonly name = 'typescript'
  private graph: CodeGraph = { files: new Map(), symbolIndex: new Map(), dependencyGraph: new Map() }
  private projectRoot: string = ''

  async buildGraph(projectRoot: string): Promise<CodeGraph> {
    this.projectRoot = projectRoot
    this.graph = { files: new Map(), symbolIndex: new Map(), dependencyGraph: new Map() }

    const files = await collectFiles(projectRoot, projectRoot)
    // 大项目限制: 超过 1000 个文件时只提取顶层声明
    const isLargeProject = files.length > 1000

    for (const relPath of files) {
      await this.parseAndAddFile(relPath, isLargeProject)
    }

    return this.graph
  }

  async querySymbol(name: string): Promise<CodeSymbol[]> {
    const results: CodeSymbol[] = []
    const lowerName = name.toLowerCase()

    for (const [symbolName, symbols] of this.graph.symbolIndex) {
      if (symbolName.toLowerCase() === lowerName || symbolName.toLowerCase().includes(lowerName)) {
        results.push(...symbols)
      }
    }
    return results
  }

  async getDependencies(filePath: string): Promise<string[]> {
    return this.graph.dependencyGraph.get(filePath) ?? []
  }

  async updateGraph(changedFiles: string[]): Promise<CodeGraph> {
    const isLargeProject = this.graph.files.size > 1000

    for (const filePath of changedFiles) {
      // Remove old data for this file
      this.removeFile(filePath)
      // Re-parse
      await this.parseAndAddFile(filePath, isLargeProject)
    }

    return this.graph
  }

  isAvailable(): boolean {
    return true
  }

  /** 解析并添加单个文件到图谱 */
  private async parseAndAddFile(relPath: string, topOnly: boolean): Promise<void> {
    const absPath = join(this.projectRoot, relPath)
    let content: string
    try {
      content = await readFile(absPath, 'utf-8')
    } catch {
      return // 文件不可读,跳过
    }

    try {
      const ext = extname(relPath)
      let symbols: CodeSymbol[]
      let imports: string[]
      let lineCount: number

      // TS/JS 用精确 TypeScript Compiler API，其他语言优先 tree-sitter 后降级正则
      if (['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'].includes(ext)) {
        const parsed = parseSourceFile(content, relPath)
        symbols = parsed.symbols
        imports = parsed.imports
        lineCount = parsed.lineCount
      } else {
        // 尝试 tree-sitter（懒加载 WASM grammar，失败不阻塞）
        let parsed: { symbols: CodeSymbol[]; imports: string[] } | null = null
        try {
          const { parseWithTreeSitter } = await import('./parsers/treesitter')
          parsed = await parseWithTreeSitter(content, relPath)
        } catch {
          // tree-sitter 不可用（grammar 加载失败或模块不存在），降级
        }
        if (parsed) {
          symbols = parsed.symbols
          imports = parsed.imports
          lineCount = content.split('\n').length
        } else {
          // 降级：回退到正则 parser
          const parser = getParserForFile(relPath)
          if (!parser) return
          const regexParsed = parser.parse(content, relPath)
          symbols = regexParsed.symbols
          imports = regexParsed.imports
          lineCount = content.split('\n').length
        }
      }

      const skeleton: FileSkeleton = { filePath: relPath, symbols, imports, lineCount }
      this.graph.files.set(relPath, skeleton)

      // Build symbol index
      for (const symbol of symbols) {
        const existing = this.graph.symbolIndex.get(symbol.name) ?? []
        existing.push(symbol)
        this.graph.symbolIndex.set(symbol.name, existing)
      }

      // Build dependency graph (resolve relative imports)
      const resolvedDeps: string[] = []
      for (const imp of imports) {
        if (imp.startsWith('.')) {
          // Resolve relative import path
          const dir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : ''
          const resolved = join(dir, imp).replace(/\\/g, '/')
          resolvedDeps.push(resolved)
        } else {
          // External package - just record the package name
          resolvedDeps.push(imp)
        }
      }
      this.graph.dependencyGraph.set(relPath, resolvedDeps)
    } catch {
      // 单个文件解析失败不阻塞整个图谱构建
    }
  }

  /** 移除文件的旧数据 */
  private removeFile(filePath: string): void {
    const oldSkeleton = this.graph.files.get(filePath)
    if (!oldSkeleton) return

    // Remove symbols from index
    for (const symbol of oldSkeleton.symbols) {
      const existing = this.graph.symbolIndex.get(symbol.name)
      if (existing) {
        const filtered = existing.filter((s) => s.filePath !== filePath)
        if (filtered.length > 0) {
          this.graph.symbolIndex.set(symbol.name, filtered)
        } else {
          this.graph.symbolIndex.delete(symbol.name)
        }
      }
    }

    this.graph.files.delete(filePath)
    this.graph.dependencyGraph.delete(filePath)
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
    // Only show exported symbols for compact context
    const exportSymbols = skeleton.symbols.filter((s) => s.exports || s.kind === 'class' || s.kind === 'interface' || s.kind === 'type')
    if (exportSymbols.length === 0) continue

    const symbols = exportSymbols
      .map((s) => `  ${s.kind} ${s.name} (L${s.startLine}-${s.endLine})`)
      .join('\n')
    parts.push(`### ${filePath} (${skeleton.lineCount}L)\n${symbols}`)
  }
  return parts.join('\n\n')
}

/**
 * 增量更新:只重算变化的文件
 * 直接在传入的 graph 上操作，避免创建新引擎实例导致图谱丢失。
 *
 * 步骤:
 * 1. 对每个变更文件，移除其在 graph 中的旧数据（符号索引 + 依赖图 + 文件骨架）
 * 2. 重新解析变更文件并添加回 graph
 * 3. 若文件已删除（读取失败），则只移除不添加
 *
 * @param graph 原始图谱（会被原地修改）
 * @param changedFiles 相对于 projectRoot 的文件路径列表
 * @param projectRoot 项目根目录（用于读取文件绝对路径）
 */
export async function updateCodeGraph(
  graph: CodeGraph,
  changedFiles: string[],
  projectRoot?: string,
): Promise<CodeGraph> {
  const root = projectRoot ?? process.cwd()
  for (const filePath of changedFiles) {
    // 移除旧数据
    removeFileFromGraph(graph, filePath)
    // 重新解析并添加（文件已删除时静默跳过）
    await parseAndAddToGraph(graph, filePath, root)
  }
  return graph
}

/** 从 graph 中移除指定文件的所有数据 */
function removeFileFromGraph(graph: CodeGraph, filePath: string): void {
  const oldSkeleton = graph.files.get(filePath)
  if (!oldSkeleton) return

  // 从符号索引中移除该文件的符号
  for (const symbol of oldSkeleton.symbols) {
    const existing = graph.symbolIndex.get(symbol.name)
    if (existing) {
      const filtered = existing.filter((s) => s.filePath !== filePath)
      if (filtered.length > 0) {
        graph.symbolIndex.set(symbol.name, filtered)
      } else {
        graph.symbolIndex.delete(symbol.name)
      }
    }
  }

  graph.files.delete(filePath)
  graph.dependencyGraph.delete(filePath)
}

/** 解析单个文件并添加到 graph（文件不存在时静默跳过） */
async function parseAndAddToGraph(graph: CodeGraph, relPath: string, projectRoot: string): Promise<void> {
  const absPath = join(projectRoot, relPath)
  let content: string
  try {
    content = await readFile(absPath, 'utf-8')
  } catch {
    return // 文件不可读（可能已删除），静默跳过
  }

  try {
    const ext = extname(relPath)
    let symbols: CodeSymbol[]
    let imports: string[]
    let lineCount: number

    if (['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'].includes(ext)) {
      const parsed = parseSourceFile(content, relPath)
      symbols = parsed.symbols
      imports = parsed.imports
      lineCount = parsed.lineCount
    } else {
      // 尝试 tree-sitter（懒加载，失败降级正则）
      let parsed: { symbols: CodeSymbol[]; imports: string[] } | null = null
      try {
        const { parseWithTreeSitter } = await import('./parsers/treesitter')
        parsed = await parseWithTreeSitter(content, relPath)
      } catch { /* 降级 */ }
      if (parsed) {
        symbols = parsed.symbols
        imports = parsed.imports
        lineCount = content.split('\n').length
      } else {
        const parser = getParserForFile(relPath)
        if (!parser) return
        const regexParsed = parser.parse(content, relPath)
        symbols = regexParsed.symbols
        imports = regexParsed.imports
        lineCount = content.split('\n').length
      }
    }

    const skeleton: FileSkeleton = { filePath: relPath, symbols, imports, lineCount }
    graph.files.set(relPath, skeleton)

    // 重建符号索引
    for (const symbol of symbols) {
      const existing = graph.symbolIndex.get(symbol.name) ?? []
      existing.push(symbol)
      graph.symbolIndex.set(symbol.name, existing)
    }

    // 重建依赖图
    const resolvedDeps: string[] = []
    for (const imp of imports) {
      if (imp.startsWith('.')) {
        const dir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : ''
        const resolved = join(dir, imp).replace(/\\/g, '/')
        resolvedDeps.push(resolved)
      } else {
        resolvedDeps.push(imp)
      }
    }
    graph.dependencyGraph.set(relPath, resolvedDeps)
  } catch {
    // 单个文件解析失败不阻塞
  }
}

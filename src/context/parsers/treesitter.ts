/**
 * Tree-sitter 代码骨架提取
 * 使用 tree-sitter WASM grammars 为多语言提供精确的 AST 解析。
 *
 * 设计原则：
 * - 懒加载：grammar 仅在首次使用时加载，避免启动拖慢
 * - 降级策略：加载失败时返回 null，调用方回退到正则 parser
 * - 与现有 LanguageParser 接口兼容
 */

import { Parser, Language, type Node as SyntaxNode } from 'web-tree-sitter'
import { getWasmPath } from 'tree-sitter-wasm'
import type { CodeSymbol } from '../CodeGraph'

// ─── 类型定义 ──────────────────────────────────────────────────────────────────

export type TreeSitterLang = 'go' | 'python' | 'rust' | 'java'

/** 文件扩展名 → tree-sitter 语言名 */
export const EXT_TO_LANG: Record<string, TreeSitterLang> = {
  '.go': 'go',
  '.py': 'python',
  '.rs': 'rust',
  '.java': 'java',
}

/** tree-sitter 解析结果 */
export interface TreeSitterParsed {
  symbols: CodeSymbol[]
  imports: string[]
}

// ─── 状态管理 ──────────────────────────────────────────────────────────────────

const loadedLanguages = new Map<TreeSitterLang, Language>()
const languageLoadPromises = new Map<TreeSitterLang, Promise<Language | null>>()
let parserInitPromise: Promise<void> | null = null

async function ensureInitialized(): Promise<void> {
  if (parserInitPromise) return parserInitPromise
  parserInitPromise = Parser.init().then(() => {
    // Parser.init() resolves when the WASM runtime is ready
  })
  return parserInitPromise
}

/** 懒加载指定语言的 grammar，失败返回 null（并发安全） */
async function loadLanguage(lang: TreeSitterLang): Promise<Language | null> {
  if (loadedLanguages.has(lang)) return loadedLanguages.get(lang)!
  // 防止并发调用时重复加载
  const pending = languageLoadPromises.get(lang)
  if (pending) return pending
  const promise = (async () => {
    try {
      await ensureInitialized()
      const wasmPath = getWasmPath(lang)
      const language = await Language.load(wasmPath)
      loadedLanguages.set(lang, language)
      return language
    } catch {
      return null
    }
  })()
  languageLoadPromises.set(lang, promise)
  promise.then(() => languageLoadPromises.delete(lang))
  return promise
}

// ─── 公共入口 ──────────────────────────────────────────────────────────────────

/**
 * 使用 tree-sitter 解析文件，提取符号和导入。
 * 返回 null 表示 grammar 加载失败，调用方应降级到正则 parser。
 */
export async function parseWithTreeSitter(
  content: string,
  filePath: string,
): Promise<TreeSitterParsed | null> {
  const ext = filePath.slice(filePath.lastIndexOf('.'))
  const lang = EXT_TO_LANG[ext]
  if (!lang) return null

  const language = await loadLanguage(lang)
  if (!language) return null

  const parser = new Parser()
  parser.setLanguage(language)

  try {
    const tree = parser.parse(content)
    if (!tree) return null
    const walker = getWalker(lang)
    return walker(tree.rootNode, content, filePath)
  } catch {
    return null
  }
}

// ─── 语言特定 Walker ───────────────────────────────────────────────────────────

type WalkerFn = (root: SyntaxNode, content: string, filePath: string) => TreeSitterParsed

function getWalker(lang: TreeSitterLang): WalkerFn {
  const walkers: Record<TreeSitterLang, WalkerFn> = {
    go: walkGoAST,
    python: walkPythonAST,
    rust: walkRustAST,
    java: walkJavaAST,
  }
  return walkers[lang]
}

// ─── Go Walker ─────────────────────────────────────────────────────────────────

function walkGoAST(root: SyntaxNode, _content: string, filePath: string): TreeSitterParsed {
  const symbols: CodeSymbol[] = []
  const imports: string[] = []

  for (const node of root.descendantsOfType('import_spec')) {
    const pathNode = node.childForFieldName('path')
    if (pathNode) imports.push(pathNode.text.replace(/"/g, ''))
  }

  // function_declaration: func name(...) ... (no receiver)
  for (const node of root.descendantsOfType('function_declaration')) {
    const nameNode = node.childForFieldName('name')
    if (!nameNode) continue
    symbols.push({
      name: nameNode.text,
      kind: 'function',
      filePath,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      signature: getFirstLine(node.text),
      exports: nameNode.text[0] === nameNode.text[0].toUpperCase(),
    })
  }

  // method_declaration: func (receiver) name(...) ...
  for (const node of root.descendantsOfType('method_declaration')) {
    const nameNode = node.childForFieldName('name')
    if (!nameNode) continue
    symbols.push({
      name: nameNode.text,
      kind: 'method',
      filePath,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      signature: getFirstLine(node.text),
      exports: nameNode.text[0] === nameNode.text[0].toUpperCase(),
    })
  }

  // type_spec (struct/interface)
  for (const node of root.descendantsOfType('type_spec')) {
    const nameNode = node.childForFieldName('name')
    if (!nameNode) continue
    const typeNode = node.childForFieldName('type')
    const isInterface = typeNode?.type === 'interface_type'
    symbols.push({
      name: nameNode.text,
      kind: isInterface ? 'interface' : 'class',
      filePath,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      signature: getFirstLine(node.text),
      exports: nameNode.text[0] === nameNode.text[0].toUpperCase(),
    })
  }

  return { symbols, imports }
}

// ─── Python Walker ─────────────────────────────────────────────────────────────

function walkPythonAST(root: SyntaxNode, _content: string, filePath: string): TreeSitterParsed {
  const symbols: CodeSymbol[] = []
  const imports: string[] = []

  // import_statement / import_from_statement
  for (const node of root.descendantsOfType('import_statement')) {
    imports.push(node.text.trim())
  }
  for (const node of root.descendantsOfType('import_from_statement')) {
    imports.push(node.text.trim())
  }

  // function_definition
  for (const node of root.descendantsOfType('function_definition')) {
    const nameNode = node.childForFieldName('name')
    if (!nameNode) continue
    const isMethod = node.parent?.type === 'class_definition' || node.parent?.type === 'block'
    symbols.push({
      name: nameNode.text,
      kind: isMethod ? 'method' : 'function',
      filePath,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      signature: getFirstLine(node.text),
      exports: !nameNode.text.startsWith('_'),
    })
  }

  // class_definition
  for (const node of root.descendantsOfType('class_definition')) {
    const nameNode = node.childForFieldName('name')
    if (!nameNode) continue
    symbols.push({
      name: nameNode.text,
      kind: 'class',
      filePath,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      signature: getFirstLine(node.text),
      exports: !nameNode.text.startsWith('_'),
    })
  }

  return { symbols, imports }
}

// ─── Rust Walker ───────────────────────────────────────────────────────────────

function walkRustAST(root: SyntaxNode, _content: string, filePath: string): TreeSitterParsed {
  const symbols: CodeSymbol[] = []
  const imports: string[] = []

  for (const node of root.descendantsOfType('use_declaration')) {
    imports.push(node.text.trim().replace(/;$/, ''))
  }
  for (const node of root.descendantsOfType('use_as_clause')) {
    imports.push(node.text.trim().replace(/;$/, ''))
  }

  // function_item
  for (const node of root.descendantsOfType('function_item')) {
    const nameNode = node.childForFieldName('name')
    if (!nameNode) continue
    const hasPub = node.text.trim().startsWith('pub')
    const hasImpl = node.parent?.type === 'impl_item'
    symbols.push({
      name: nameNode.text,
      kind: hasImpl ? 'method' : 'function',
      filePath,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      signature: getFirstLine(node.text),
      exports: hasPub,
    })
  }

  // struct_item / enum_item / trait_item / impl_item
  for (const kind of ['struct_item', 'enum_item', 'trait_item', 'impl_item'] as const) {
    for (const node of root.descendantsOfType(kind)) {
      const nameNode = node.childForFieldName('name')
      if (!nameNode) continue
      const hasPub = node.text.trim().startsWith('pub')
      const isTrait = kind === 'trait_item'
      symbols.push({
        name: nameNode.text,
        kind: isTrait ? 'interface' : 'class',
        filePath,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        signature: getFirstLine(node.text),
        exports: hasPub,
      })
    }
  }

  return { symbols, imports }
}

// ─── Java Walker ───────────────────────────────────────────────────────────────

function walkJavaAST(root: SyntaxNode, _content: string, filePath: string): TreeSitterParsed {
  const symbols: CodeSymbol[] = []
  const imports: string[] = []

  for (const node of root.descendantsOfType('import_declaration')) {
    const text = node.text.trim().replace(/;$/, '')
    imports.push(text)
  }

  // class_declaration / interface_declaration / enum_declaration
  for (const node of root.descendantsOfType(['class_declaration', 'interface_declaration', 'enum_declaration'])) {
    const nameNode = node.childForFieldName('name')
    if (!nameNode) continue
    const isPublic = node.text.match(/^\s*public/)
    symbols.push({
      name: nameNode.text,
      kind: node.type === 'interface_declaration' ? 'interface' : 'class',
      filePath,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      signature: getFirstLine(node.text),
      exports: !!isPublic,
    })
  }

  // method_declaration (only top-level, not inside nested classes)
  for (const node of root.descendantsOfType('method_declaration')) {
    const nameNode = node.childForFieldName('name')
    if (!nameNode) continue
    const isPublic = node.text.match(/^\s*public/)
    symbols.push({
      name: nameNode.text,
      kind: 'method',
      filePath,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      signature: getFirstLine(node.text),
      exports: !!isPublic,
    })
  }

  return { symbols, imports }
}

// ─── 辅助函数 ──────────────────────────────────────────────────────────────────

function getFirstLine(text: string): string {
  const firstLine = text.split('\n')[0]?.trim() ?? text
  return firstLine.length > 120 ? firstLine.slice(0, 120) + '...' : firstLine
}

// ─── 批量预加载（可选） ────────────────────────────────────────────────────────

/**
 * 预加载所有 tree-sitter grammar（在 CodeGraph 后台构建时调用）。
 * 失败的语言会在 parseWithTreeSitter 调用时触发降级策略。
 */
export async function preloadAllLanguages(): Promise<void> {
  const langs: TreeSitterLang[] = ['go', 'python', 'rust', 'java']
  await Promise.allSettled(langs.map((l) => loadLanguage(l)))
}

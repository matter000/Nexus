/**
 * lsp 工具 — 语义级代码智能（基于 TypeScript LanguageService）
 *
 * 2026 年 coding agent 能力分水岭：LSP 让 agent "少猜"（语义层），
 * 与编译/测试反馈（验证层）结合才稳定。首期仅支持 TS/JS（无需外部
 * language server 进程，直接用 typescript 编译器 API），其他语言回退
 * grep/search_symbol。
 *
 * 与 search_symbol 分工：search_symbol 按名模糊搜（轻量、跨语言），
 * lsp 按语义精确查（定义/引用/诊断，重量级按需加载）。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { extname, isAbsolute, join } from 'path'
import ts from 'typescript'
import type { ToolDefinition, ToolResult } from '../agent/types'
import type { ToolContext, ToolHandler } from './registry'

/** 项目文件数超过该值时拒绝加载 LanguageService（防大仓库内存爆炸） */
const MAX_FILES = 3000
/** definition 最多返回处数 */
const MAX_DEFINITIONS = 5
/** references 最多返回处数 */
const MAX_REFERENCES = 20
/** diagnostics 最多返回条数 */
const MAX_DIAGNOSTICS = 15

const SUPPORTED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx'])
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.nexus'])

/** LanguageService 宿主（按 projectRoot 惰性单例缓存） */
interface ServiceHost {
  service: ts.LanguageService
  files: Map<string, { version: number; snapshot: ts.IScriptSnapshot | null }>
}

const hosts = new Map<string, ServiceHost | 'too-large'>()

/** 文件内容快照缓存（含 lib 库文件，避免重复读盘） */
const snapshotCache = new Map<string, ts.IScriptSnapshot>()

/** 读取任意文件为快照（未登记文件/lib 文件也需提供内容，否则 Program 为空） */
function snapshotFor(fileName: string): ts.IScriptSnapshot | undefined {
  const cached = snapshotCache.get(fileName)
  if (cached) return cached
  try {
    const snap = ts.ScriptSnapshot.fromString(readFileSync(fileName, 'utf-8'))
    snapshotCache.set(fileName, snap)
    return snap
  } catch {
    return undefined
  }
}

/** 收集项目内受支持的文件（深度遍历，忽略常见产物目录） */
function collectFiles(root: string): string[] {
  const results: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 12 || results.length > MAX_FILES) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (IGNORED_DIRS.has(name) || name.startsWith('.')) continue
      const full = join(dir, name)
      let stat: ReturnType<typeof statSync>
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        walk(full, depth + 1)
      } else if (SUPPORTED_EXTENSIONS.has(extname(name))) {
        results.push(full)
        if (results.length > MAX_FILES) return
      }
    }
  }
  walk(root, 0)
  return results
}

/** 获取/创建 projectRoot 对应的 LanguageService（超大仓库返回 null） */
function getService(projectRoot: string): ServiceHost | null {
  const cached = hosts.get(projectRoot)
  if (cached === 'too-large') return null
  if (cached) return cached

  const filePaths = collectFiles(projectRoot)
  if (filePaths.length > MAX_FILES) {
    hosts.set(projectRoot, 'too-large')
    return null
  }

  const files = new Map<string, { version: number; snapshot: ts.IScriptSnapshot | null }>()
  for (const f of filePaths) files.set(f, { version: 0, snapshot: null })

  const compilerOptions: ts.CompilerOptions = {
    allowJs: true,
    jsx: ts.JsxEmit.Preserve,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    allowNonTsExtensions: false,
  }

  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => Array.from(files.keys()),
    getScriptVersion: (fileName) => String(files.get(fileName)?.version ?? 0),
    getScriptSnapshot: (fileName) => {
      // 已登记文件：失效时重读（edit_file 后内容更新）
      const entry = files.get(fileName)
      if (entry) {
        if (!entry.snapshot) {
          entry.snapshot = snapshotFor(fileName) ?? null
        }
        return entry.snapshot ?? undefined
      }
      // 未登记文件（lib 库/依赖 d.ts）：直接读盘，缺失时 TS 自行降级
      return snapshotFor(fileName)
    },
    getCurrentDirectory: () => projectRoot,
    getCompilationSettings: () => compilerOptions,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: (f) => files.has(f) || existsSync(f),
    readFile: (f) => {
      try {
        return readFileSync(f, 'utf-8')
      } catch {
        return undefined
      }
    },
  }

  const serviceHost: ServiceHost = {
    service: ts.createLanguageService(host, ts.createDocumentRegistry()),
    files,
  }
  hosts.set(projectRoot, serviceHost)
  return serviceHost
}

/** 确保被查询文件已登记（可能是刚创建的文件）；返回绝对路径或 null */
function ensureFile(serviceHost: ServiceHost, projectRoot: string, path: string): string | null {
  const abs = isAbsolute(path) ? path : join(projectRoot, path)
  if (!serviceHost.files.has(abs)) {
    if (!existsSync(abs)) return null
    serviceHost.files.set(abs, { version: 0, snapshot: null })
  } else {
    // 失效缓存快照，读到最新内容（文件可能被 edit_file 修改）
    const entry = serviceHost.files.get(abs)
    if (entry) {
      entry.snapshot = null
      entry.version++
    }
    snapshotCache.delete(abs)
  }
  return abs
}

/** symbol 或 line 定位为目标位置（position）；都缺省时返回 null */
function resolvePosition(
  serviceHost: ServiceHost,
  absPath: string,
  symbol: string | undefined,
  line: number | undefined,
): number | null {
  const content = serviceHost.service.getProgram()?.getSourceFile(absPath)?.getFullText()
  if (content === undefined) return null
  if (typeof symbol === 'string' && symbol.length > 0) {
    const idx = content.indexOf(symbol)
    if (idx < 0) return null
    return idx + Math.floor(symbol.length / 2)
  }
  if (typeof line === 'number' && line >= 1) {
    const lineStarts = serviceHost.service.getProgram()?.getSourceFile(absPath)?.getLineStarts()
    if (!lineStarts || line - 1 >= lineStarts.length) return null
    return lineStarts[line - 1]
  }
  return null
}

/** position → 文件:行号 的可读定位 */
function formatLocation(
  program: ts.Program,
  fileName: string,
  position: number,
  projectRoot: string,
): string {
  const sf = program.getSourceFile(fileName)
  if (!sf) return `${fileName}:?`
  const { line, character } = sf.getLineAndCharacterOfPosition(position)
  const rel = fileName.startsWith(projectRoot)
    ? fileName.slice(projectRoot.length).replace(/^[\\/]/, '')
    : fileName
  const lineText = sf.getFullText().split('\n')[line]?.trim().slice(0, 80) ?? ''
  return `${rel}:${line + 1}:${character + 1}  ${lineText}`
}

const definition: ToolDefinition = {
  name: 'lsp',
  description:
    '语义级代码智能（TS/JS）：definition 精确定义跳转、references 引用查找、diagnostics 语义诊断（类型错误等）。比 search_symbol 精确但更重，按需使用；其他语言请用 grep/search_symbol。',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['definition', 'references', 'diagnostics'],
        description: 'definition=定义跳转; references=引用查找; diagnostics=语义诊断',
      },
      path: {
        type: 'string',
        description: '目标文件路径（相对于项目根目录）',
      },
      symbol: {
        type: 'string',
        description: '符号名（definition/references 用；给定后在文件内定位首个匹配）',
      },
      line: {
        type: 'number',
        description: '行号（1 起，definition/references 可选替代 symbol）',
      },
    },
    required: ['action', 'path'],
  },
  requiresApproval: false,
  phase: 'both',
}

async function execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const { callId, projectRoot } = context
  const action = params.action as string
  const path = params.path as string
  const symbol = params.symbol as string | undefined
  const line = params.line as number | undefined

  if (!SUPPORTED_EXTENSIONS.has(extname(path))) {
    return {
      callId,
      tool: 'lsp',
      result: '',
      error: `lsp 工具暂不支持 ${extname(path) || '该类型'} 文件（仅 TS/JS），请用 grep 或 search_symbol`,
    }
  }

  const serviceHost = getService(projectRoot)
  if (!serviceHost) {
    return {
      callId,
      tool: 'lsp',
      result: '',
      error: `项目文件数超过 ${MAX_FILES}，lsp 工具已禁用，请用 grep/search_symbol`,
    }
  }

  const absPath = ensureFile(serviceHost, projectRoot, path)
  if (!absPath) {
    return { callId, tool: 'lsp', result: '', error: `文件不存在: ${path}` }
  }

  // 文件集可能变化（新文件登记/内容失效），强制重建语义缓存后再查询
  serviceHost.service.cleanupSemanticCache()
  const program = serviceHost.service.getProgram()
  if (!program) {
    return { callId, tool: 'lsp', result: '', error: 'LanguageService 初始化失败' }
  }

  try {
    if (action === 'diagnostics') {
      const diagnostics = [
        ...serviceHost.service.getSyntacticDiagnostics(absPath),
        ...serviceHost.service.getSemanticDiagnostics(absPath),
      ]
      if (diagnostics.length === 0) {
        return { callId, tool: 'lsp', result: `${path}: 无诊断问题` }
      }
      // 错误优先（category Error 排前）
      const sorted = diagnostics
        .slice()
        .sort(
          (a, b) =>
            (a.category === ts.DiagnosticCategory.Error ? 0 : 1) -
            (b.category === ts.DiagnosticCategory.Error ? 0 : 1),
        )
      const lines = sorted.slice(0, MAX_DIAGNOSTICS).map((d) => {
        const pos = d.start ?? 0
        const { line: ln } = program.getSourceFile(absPath)?.getLineAndCharacterOfPosition(pos) ?? {
          line: 0,
        }
        const sev = d.category === ts.DiagnosticCategory.Error ? '错误' : '警告'
        return `[${sev}] ${path}:${ln + 1} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`
      })
      const more =
        diagnostics.length > MAX_DIAGNOSTICS
          ? `\n...（共 ${diagnostics.length} 条，仅显示前 ${MAX_DIAGNOSTICS} 条）`
          : ''
      return { callId, tool: 'lsp', result: lines.join('\n') + more }
    }

    // definition / references 需要定位
    const position = resolvePosition(serviceHost, absPath, symbol, line)
    if (position === null) {
      return {
        callId,
        tool: 'lsp',
        result: '',
        error: symbol
          ? `在 ${path} 中未找到符号 "${symbol}"`
          : '需要提供 symbol 或 line 参数定位查询位置',
      }
    }

    if (action === 'definition') {
      const defs = serviceHost.service.getDefinitionAtPosition(absPath, position) ?? []
      if (defs.length === 0) {
        return { callId, tool: 'lsp', result: `未找到 ${symbol ?? '该位置'} 的定义` }
      }
      const lines = defs
        .slice(0, MAX_DEFINITIONS)
        .map((d) => formatLocation(program, d.fileName, d.textSpan.start, projectRoot))
      return { callId, tool: 'lsp', result: lines.join('\n') }
    }

    if (action === 'references') {
      const refs = serviceHost.service.getReferencesAtPosition(absPath, position) ?? []
      if (refs.length === 0) {
        return { callId, tool: 'lsp', result: `未找到 ${symbol ?? '该位置'} 的引用` }
      }
      const lines = refs
        .slice(0, MAX_REFERENCES)
        .map((r) => formatLocation(program, r.fileName, r.textSpan.start, projectRoot))
      const more =
        refs.length > MAX_REFERENCES
          ? `\n...（共 ${refs.length} 处，仅显示前 ${MAX_REFERENCES} 处）`
          : ''
      return { callId, tool: 'lsp', result: lines.join('\n') + more }
    }

    return { callId, tool: 'lsp', result: '', error: `未知 action: ${action}` }
  } catch (err) {
    return {
      callId,
      tool: 'lsp',
      result: '',
      error: `lsp 查询失败: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

export const lspTool: ToolHandler = { definition, execute }

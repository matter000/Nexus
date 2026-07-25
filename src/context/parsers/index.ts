/**
 * 多语言正则解析器
 * 为 Python/Go/Rust/Java 提供轻量级函数/类签名提取
 * 覆盖 80% 场景，无需 tree-sitter 依赖
 */

import type { CodeSymbol } from '../CodeGraph'

export interface LanguageParser {
  /** 支持的文件扩展名 */
  extensions: Set<string>
  /** 从文件内容提取符号 */
  parse(content: string, filePath: string): { symbols: CodeSymbol[]; imports: string[] }
}

// ─── Python Parser ──────────────────────────────────────────────────────────────

const pythonParser: LanguageParser = {
  extensions: new Set(['.py']),
  parse(content: string, filePath: string) {
    const symbols: CodeSymbol[] = []
    const imports: string[] = []
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const lineNum = i + 1

      // import 语句
      const importMatch = line.match(/^(?:from\s+(\S+)\s+)?import\s+(.+)/)
      if (importMatch) {
        imports.push(importMatch[1] ?? importMatch[2].trim())
        continue
      }

      // 函数定义: def xxx(
      const funcMatch = line.match(/^(\s*)(?:async\s+)?def\s+(\w+)\s*\(/)
      if (funcMatch) {
        const indent = funcMatch[1].length
        const name = funcMatch[2]
        // 找到函数体结束（下一个同级或更低缩进的行）
        const endLine = findBlockEnd(lines, i, indent)
        const isMethod = indent > 0
        symbols.push({
          name,
          kind: isMethod ? 'method' : 'function',
          filePath,
          startLine: lineNum,
          endLine: endLine + 1,
          signature: line.trim().slice(0, 120),
          exports: !name.startsWith('_'),
        })
        continue
      }

      // 类定义: class xxx:
      const classMatch = line.match(/^class\s+(\w+)/)
      if (classMatch) {
        const name = classMatch[1]
        const endLine = findBlockEnd(lines, i, 0)
        symbols.push({
          name,
          kind: 'class',
          filePath,
          startLine: lineNum,
          endLine: endLine + 1,
          signature: line.trim().slice(0, 120),
          exports: !name.startsWith('_'),
        })
      }
    }

    return { symbols, imports }
  },
}

// ─── Go Parser ──────────────────────────────────────────────────────────────────

const goParser: LanguageParser = {
  extensions: new Set(['.go']),
  parse(content: string, filePath: string) {
    const symbols: CodeSymbol[] = []
    const imports: string[] = []
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const lineNum = i + 1

      // import
      const importMatch = line.match(/^\s*import\s+(?:"([^"]+)"|\(([^)]*)\))/)
      if (importMatch) {
        if (importMatch[1]) imports.push(importMatch[1])
        if (importMatch[2]) {
          const pkgs = importMatch[2].match(/"([^"]+)"/g)
          if (pkgs) imports.push(...pkgs.map((p) => p.replace(/"/g, '')))
        }
        continue
      }

      // 函数: func xxx( 或 func (receiver) xxx(
      const funcMatch = line.match(/^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(/)
      if (funcMatch) {
        const name = funcMatch[1]
        const endLine = findBraceEnd(lines, i)
        symbols.push({
          name,
          kind: 'function',
          filePath,
          startLine: lineNum,
          endLine: endLine + 1,
          signature: line.trim().slice(0, 120),
          exports: name[0] === name[0].toUpperCase(),
        })
        continue
      }

      // 类型: type xxx struct/interface
      const typeMatch = line.match(/^type\s+(\w+)\s+(struct|interface)/)
      if (typeMatch) {
        const name = typeMatch[1]
        const kind = typeMatch[2] === 'interface' ? 'interface' : 'class'
        const endLine = findBraceEnd(lines, i)
        symbols.push({
          name,
          kind: kind as 'interface' | 'class',
          filePath,
          startLine: lineNum,
          endLine: endLine + 1,
          signature: line.trim().slice(0, 120),
          exports: name[0] === name[0].toUpperCase(),
        })
      }
    }

    return { symbols, imports }
  },
}

// ─── Rust Parser ────────────────────────────────────────────────────────────────

const rustParser: LanguageParser = {
  extensions: new Set(['.rs']),
  parse(content: string, filePath: string) {
    const symbols: CodeSymbol[] = []
    const imports: string[] = []
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const lineNum = i + 1

      // use 语句
      const useMatch = line.match(/^use\s+(.+);/)
      if (useMatch) {
        imports.push(useMatch[1])
        continue
      }

      // 函数: fn xxx( 或 pub fn xxx(
      const funcMatch = line.match(/^\s*(pub(?:\(crate\))?\s+)?(?:async\s+)?fn\s+(\w+)/)
      if (funcMatch) {
        const isPub = !!funcMatch[1]
        const name = funcMatch[2]
        const endLine = findBraceEnd(lines, i)
        symbols.push({
          name,
          kind: 'function',
          filePath,
          startLine: lineNum,
          endLine: endLine + 1,
          signature: line.trim().slice(0, 120),
          exports: isPub,
        })
        continue
      }

      // struct/enum/trait/impl
      const structMatch = line.match(/^\s*(pub(?:\(crate\))?\s+)?(struct|enum|trait|impl)\s+(\w+)/)
      if (structMatch) {
        const isPub = !!structMatch[1]
        const kind = structMatch[2] === 'trait' ? 'interface' : 'class'
        const name = structMatch[3]
        const endLine = findBraceEnd(lines, i)
        symbols.push({
          name,
          kind: kind as 'interface' | 'class',
          filePath,
          startLine: lineNum,
          endLine: endLine + 1,
          signature: line.trim().slice(0, 120),
          exports: isPub,
        })
      }
    }

    return { symbols, imports }
  },
}

// ─── Java Parser ────────────────────────────────────────────────────────────────

const javaParser: LanguageParser = {
  extensions: new Set(['.java']),
  parse(content: string, filePath: string) {
    const symbols: CodeSymbol[] = []
    const imports: string[] = []
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const lineNum = i + 1

      // import
      const importMatch = line.match(/^import\s+(?:static\s+)?(.+);/)
      if (importMatch) {
        imports.push(importMatch[1])
        continue
      }

      // 类/接口: public class xxx / interface xxx
      const classMatch = line.match(/^\s*(?:public|private|protected)?\s*(?:abstract\s+)?(class|interface|enum)\s+(\w+)/)
      if (classMatch) {
        const kind = classMatch[1] === 'interface' ? 'interface' : 'class'
        const name = classMatch[2]
        const endLine = findBraceEnd(lines, i)
        symbols.push({
          name,
          kind: kind as 'interface' | 'class',
          filePath,
          startLine: lineNum,
          endLine: endLine + 1,
          signature: line.trim().slice(0, 120),
          exports: line.includes('public'),
        })
        continue
      }

      // 方法: public void xxx( / private String xxx(
      const methodMatch = line.match(/^\s*(?:public|private|protected)\s+(?:static\s+)?(?:\w+(?:<[^>]+>)?)\s+(\w+)\s*\(/)
      if (methodMatch) {
        const name = methodMatch[1]
        const endLine = findBraceEnd(lines, i)
        symbols.push({
          name,
          kind: 'method',
          filePath,
          startLine: lineNum,
          endLine: endLine + 1,
          signature: line.trim().slice(0, 120),
          exports: line.includes('public'),
        })
      }
    }

    return { symbols, imports }
  },
}

// ─── 辅助函数 ────────────────────────────────────────────────────────────────────

/** Python: 找到缩进块的结束行 */
function findBlockEnd(lines: string[], startIdx: number, baseIndent: number): number {
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue // 跳过空行
    const indent = line.match(/^(\s*)/)?.[1].length ?? 0
    if (indent <= baseIndent) return i - 1
  }
  return lines.length - 1
}

/** 大括号语言: 找到匹配的 } 所在行 */
function findBraceEnd(lines: string[], startIdx: number): number {
  let depth = 0
  let started = false
  for (let i = startIdx; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; started = true }
      if (ch === '}') { depth-- }
      if (started && depth === 0) return i
    }
  }
  return lines.length - 1
}

// ─── 注册表 ──────────────────────────────────────────────────────────────────────

const parsers: LanguageParser[] = [pythonParser, goParser, rustParser, javaParser]

/** 根据文件扩展名获取对应的解析器 */
export function getParserForFile(filePath: string): LanguageParser | null {
  const ext = filePath.substring(filePath.lastIndexOf('.'))
  return parsers.find((p) => p.extensions.has(ext)) ?? null
}

/** 获取所有支持的多语言扩展名 */
export function getSupportedExtensions(): Set<string> {
  const exts = new Set<string>()
  for (const p of parsers) {
    for (const ext of p.extensions) exts.add(ext)
  }
  return exts
}

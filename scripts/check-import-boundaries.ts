#!/usr/bin/env bun
/**
 * Import boundary checker.
 * Enforces module dependency rules: lower layers must not import from higher layers.
 *
 * Layer hierarchy (lower index = lower layer):
 *   core < storage < sandbox < router < context < tools < agent < harness < cli < tui
 *
 * Rule: a module may only import from layers with a LOWER or EQUAL index,
 * except that `types` and `utils` are shared and can be imported by anyone.
 */

import { Glob } from 'bun'
import { readFileSync } from 'node:fs'
import { resolve, dirname, relative } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')

const LAYERS: Record<string, number> = {
  core: 0,
  storage: 1,
  sandbox: 2,
  router: 3,
  context: 4,
  tools: 5,
  agent: 6,
  harness: 7,
  cli: 8,
  tui: 9,
}

// Shared modules that any layer can import
const SHARED = new Set(['types', 'utils', 'config', 'config-secrets', 'index'])

// Shared type-only files that any layer can import (path relative to src/, no extension)
const SHARED_TYPE_FILES = new Set(['agent/types', 'harness/types'])

// Known existing violations (baseline). New violations will fail the check.
// Format: "source-file: import-path"
const KNOWN_VIOLATIONS = new Set([
  'src/tools/registry.ts: ../agent/SubAgent',
  // 多引擎分派工具（dispatch_agent/run_pipeline）需引用引擎注册表与流水线运行器，
  // 属于既有架构债务（HEAD 已存在），待引擎层下沉或经接口解耦后移除
  'src/tools/registry.ts: ../agent/AgentEngine',
  'src/tools/registry.ts: ../agent/PipelineRunner',
  'src/context/Assembler.ts: ../tools/registry',
])

function getLayer(filePath: string): { name: string; rank: number } | null {
  const rel = relative(resolve(ROOT, 'src'), filePath).replace(/\\/g, '/')
  const parts = rel.split('/')
  if (parts.length < 2) return null
  const dir = parts[0]
  if (dir in LAYERS) return { name: dir, rank: LAYERS[dir] }
  return null
}

function extractImports(content: string): string[] {
  const imports: string[] = []
  const re = /(?:import|export)\s+.*?from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    imports.push(m[1] ?? m[2])
  }
  return imports
}

function resolveImportLayer(
  importPath: string,
  fromFile: string,
): { layer: string; relPath: string } | null {
  // Only check relative imports within src/
  if (!importPath.startsWith('.')) return null
  const resolved = resolve(dirname(fromFile), importPath).replace(/\\/g, '/')
  const srcDir = resolve(ROOT, 'src').replace(/\\/g, '/')
  if (!resolved.startsWith(srcDir)) return null
  const rel = resolved.slice(srcDir.length + 1).replace(/\.(ts|tsx)$/, '')
  // Check if it's a shared type file
  if (SHARED_TYPE_FILES.has(rel)) return null
  const parts = rel.split('/')
  const dir = parts[0]
  if (dir in LAYERS) return { layer: dir, relPath: rel }
  return null
}

async function main() {
  const glob = new Glob('src/**/*.{ts,tsx}')
  const violations: string[] = []

  for await (const file of glob.scan(ROOT)) {
    const absPath = resolve(ROOT, file)
    const sourceLayer = getLayer(absPath)
    if (!sourceLayer) continue

    const content = readFileSync(absPath, 'utf-8')
    const imports = extractImports(content)

    for (const imp of imports) {
      const target = resolveImportLayer(imp, absPath)
      if (!target) continue
      if (SHARED.has(target.layer)) continue

      const targetRank = LAYERS[target.layer]
      if (targetRank > sourceLayer.rank) {
        const relFile = relative(ROOT, absPath).replace(/\\/g, '/')
        violations.push(
          `  ${relFile}: src/${sourceLayer.name} (L${sourceLayer.rank}) → src/${target.layer} (L${targetRank}) via "${imp}"`,
        )
      }
    }
  }

  if (violations.length > 0) {
    const newViolations = violations.filter((v) => {
      // Extract "file: import" key from the formatted string
      const match = v.match(/^\s+(.+?):\s+src\/\w+\s+\(L\d+\)\s+→\s+src\/\w+\s+\(L\d+\)\s+via\s+"(.+)"$/)
      if (!match) return true
      const key = `${match[1].replace(/\\/g, '/')}: ${match[2]}`
      return !KNOWN_VIOLATIONS.has(key)
    })

    if (newViolations.length > 0) {
      console.error(`\n❌ NEW import boundary violations (${newViolations.length}):\n`)
      for (const v of newViolations) console.error(v)
      console.error('\nLower layers must not import from higher layers.\n')
      process.exit(1)
    } else {
      console.log(
        `⚠️  ${violations.length} known baseline violations (allowed). No new violations.`,
      )
    }
  } else {
    console.log('✅ No import boundary violations found.')
  }
}

main()

#!/usr/bin/env bun
/**
 * run-tests-isolated：逐文件进程隔离的测试运行器
 *
 * 根治 bun test 同进程顺序执行多文件时 mock.module 跨文件泄漏问题
 * （每个测试文件独立 bun 进程运行，模块 mock 不再互相污染）。
 * 代价是进程启动开销（约 +1-2 分钟），换取全量测试可单命令稳定复现。
 *
 * 用法: bun run scripts/run-tests-isolated.ts
 * 排除项: treesitter / pluginLoader / skillLibrary 对应文件由 CI 独立步骤运行
 * （tree-sitter WASM 内存冲突与技能插件测试历史上需要独立进程环境）。
 */

import { spawnSync } from 'child_process'
import { readdirSync, statSync } from 'fs'
import { join, relative } from 'path'

const ROOT = join(import.meta.dir, '..')

/** 由 CI 独立步骤运行的文件（不在主套件重复跑） */
const EXCLUDED_BASENAMES = new Set(['treesitter.test.ts', 'pluginLoader.test.ts', 'skillLibrary.test.ts'])

function collectTestFiles(dir: string): string[] {
  const results: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      results.push(...collectTestFiles(full))
    } else if (/\.test\.(ts|tsx)$/.test(entry) && !EXCLUDED_BASENAMES.has(entry)) {
      results.push(full)
    }
  }
  return results.sort()
}

const files = [
  ...collectTestFiles(join(ROOT, 'tests', 'unit')),
  ...collectTestFiles(join(ROOT, 'tests', 'integration')),
]

console.log(`进程隔离模式：共 ${files.length} 个测试文件（tree-sitter/skill-plugin 由独立步骤运行）\n`)

let passFiles = 0
let failFiles = 0
let totalPass = 0
let totalFail = 0
const failures: string[] = []

for (const file of files) {
  const rel = relative(ROOT, file)
  const result = spawnSync('bun', ['test', file], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    ...(process.platform === 'win32' ? { windowsHide: true } : {}),
  })
  const output = `${result.stdout?.toString() ?? ''}${result.stderr?.toString() ?? ''}`
  // 从 bun test 输出尾部提取计数（"N pass" / "N fail"）
  const passMatch = output.match(/(\d+)\s+pass/)
  const failMatch = output.match(/(\d+)\s+fail/)
  const pass = passMatch ? Number.parseInt(passMatch[1], 10) : 0
  const fail = failMatch ? Number.parseInt(failMatch[1], 10) : 0
  totalPass += pass
  totalFail += fail

  if (result.status === 0) {
    passFiles++
    console.log(`  ✓ ${rel} (${pass} pass)`)
  } else {
    failFiles++
    failures.push(rel)
    console.log(`  ✗ ${rel} (${pass} pass / ${fail} fail)`)
    // 失败文件输出详细日志（截断防刷屏）
    const detail = output.trim()
    console.log(detail.length > 3000 ? `${detail.slice(-3000)}` : detail)
  }
}

console.log(
  `\n═══ 隔离测试汇总 ═══\n文件: ${passFiles} 通过 / ${failFiles} 失败（共 ${files.length}）\n用例: ${totalPass} pass / ${totalFail} fail`,
)
if (failures.length > 0) {
  console.log(`失败文件:\n${failures.map((f) => `  - ${f}`).join('\n')}`)
  process.exit(1)
}
process.exit(0)

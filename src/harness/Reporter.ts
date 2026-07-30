/**
 * 报告生成器 — 终端彩色输出 + JSON 导出
 */

import type { EvalReport, EvalResult } from './types'

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const CYAN = '\x1b[36m'
const YELLOW = '\x1b[33m'
const MUTED = '\x1b[90m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'

/** 终端表格报告 */
export function printReport(report: EvalReport): void {
  const modeLabel = report.mode === 'real' ? '真实' : 'Mock'
  const passRate =
    report.tasksTotal > 0 ? ((report.tasksPassed / report.tasksTotal) * 100).toFixed(0) : '0'

  // 头部
  console.log(`\n${CYAN}══════════════════════════════════════════════${RESET}`)
  console.log(`${BOLD}  Nexus Harness Report${RESET}`)
  console.log(`${CYAN}══════════════════════════════════════════════${RESET}`)
  console.log(
    `  ${BOLD}Mode:${RESET} ${modeLabel}  |  ${BOLD}Tasks:${RESET} ${report.tasksTotal}  |  ${BOLD}Passed:${RESET} ${GREEN}${report.tasksPassed}${RESET}  |  ${BOLD}Failed:${RESET} ${RED}${report.tasksFailed}${RESET}`,
  )
  console.log(
    `  ${BOLD}Pass Rate:${RESET} ${passRate}%  |  ${BOLD}Cost:${RESET} $${report.totalCost.toFixed(4)}  |  ${BOLD}Time:${RESET} ${formatDuration(report.totalDurationMs)}`,
  )
  console.log(`${CYAN}══════════════════════════════════════════════${RESET}`)

  // 任务结果
  for (const r of report.results) {
    const icon = r.pass ? `${GREEN}✅${RESET}` : `${RED}❌${RESET}`
    const pad = ' '.repeat(Math.max(0, 12 - r.taskName.length))
    const costStr =
      report.mode === 'real' ? `$${r.cost.toFixed(3)}`.padStart(9) : '    mock'.padStart(9)
    const timeStr = formatDuration(r.durationMs).padStart(6)
    const catStr = r.category.padEnd(12)
    const diffStr = r.difficulty.padEnd(6)

    console.log(
      `  ${icon} ${r.taskId.padEnd(12)} ${r.taskName.padEnd(14)} ${MUTED}${catStr}${diffStr}${RESET} ${costStr}  ${timeStr}`,
    )

    if (!r.pass && r.reason) {
      const reasonLines = r.reason.split('\n').slice(0, 3)
      for (const line of reasonLines) {
        console.log(`     ${MUTED}──${RESET} ${line.slice(0, 80)}`)
      }
    }
  }

  console.log(`${CYAN}══════════════════════════════════════════════${RESET}\n`)
}

/** 导出 JSON 格式报告 */
export function exportJSON(report: EvalReport): string {
  return JSON.stringify(report, null, 2)
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`
}

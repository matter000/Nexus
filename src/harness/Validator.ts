/**
 * 验证器 — 对任务结果执行验证规则
 */

import { readFile, access } from 'fs/promises'
import { join } from 'path'
import { spawn } from 'child_process'
import type { ValidateRule, EvalTask } from './types'

export interface ValidateResult {
  pass: boolean
  reason?: string
  rulesPassed: number
  rulesTotal: number
  details: Array<{ rule: ValidateRule; pass: boolean; reason?: string }>
}

/** 对任务结果执行所有验证规则 */
export async function validateTask(dir: string, task: EvalTask): Promise<ValidateResult> {
  const details: Array<{ rule: ValidateRule; pass: boolean; reason?: string }> = []

  for (const rule of task.validate) {
    const result = await checkRule(dir, rule)
    details.push({ rule, pass: result.pass, reason: result.reason })
  }

  const rulesPassed = details.filter((d) => d.pass).length
  const rulesTotal = details.length
  const firstFailed = details.find((d) => !d.pass)

  return {
    pass: rulesPassed === rulesTotal,
    reason: firstFailed?.reason,
    rulesPassed,
    rulesTotal,
    details,
  }
}

async function checkRule(dir: string, rule: ValidateRule): Promise<{ pass: boolean; reason?: string }> {
  try {
    switch (rule.type) {
      case 'file_exists': {
        try {
          await access(join(dir, rule.path))
          return { pass: true }
        } catch {
          return { pass: false, reason: `文件不存在: ${rule.path}` }
        }
      }
      case 'file_not_exists': {
        try {
          await access(join(dir, rule.path))
          return { pass: false, reason: `文件不应存在: ${rule.path}` }
        } catch {
          return { pass: true }
        }
      }
      case 'file_contains': {
        try {
          const content = await readFile(join(dir, rule.path), 'utf-8')
          if (content.includes(rule.pattern)) {
            return { pass: true }
          }
          return { pass: false, reason: `${rule.path} 未包含: ${rule.pattern}` }
        } catch {
          return { pass: false, reason: `无法读取: ${rule.path}` }
        }
      }
      case 'file_not_contains': {
        try {
          const content = await readFile(join(dir, rule.path), 'utf-8')
          if (!content.includes(rule.pattern)) {
            return { pass: true }
          }
          return { pass: false, reason: `${rule.path} 不应包含: ${rule.pattern}` }
        } catch {
          return { pass: true } // 文件不存在也算"不包含"
        }
      }
      case 'bash_pass': {
        const output = await runCommand(rule.command, dir)
        if (output.exitCode === 0) {
          return { pass: true }
        }
        return { pass: false, reason: `命令失败 (exit ${output.exitCode}): ${rule.command}\n${output.stderr}` }
      }
      case 'bash_output_contains': {
        const output = await runCommand(rule.command, dir)
        if (output.exitCode !== 0) {
          return { pass: false, reason: `命令失败 (exit ${output.exitCode}): ${rule.command}` }
        }
        if (output.stdout.includes(rule.pattern)) {
          return { pass: true }
        }
        return { pass: false, reason: `命令输出未包含: ${rule.pattern}\n输出: ${output.stdout.slice(0, 200)}` }
      }
      default:
        return { pass: false, reason: `未知验证类型: ${(rule as ValidateRule).type}` }
    }
  } catch (err) {
    return { pass: false, reason: `验证异常: ${err instanceof Error ? err.message : String(err)}` }
  }
}

function runCommand(command: string, cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
      ...(process.platform === 'win32' ? { windowsHide: true } : {}),
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('close', (code) => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code ?? 1 }))
    child.on('error', (err) => resolve({ stdout: '', stderr: err.message, exitCode: 1 }))
  })
}

/**
 * 单元测试: EvidenceGate 确定性证据门禁（Loop Engineering）
 * 验证：配置命令执行判定、未配置跳过、输出截断、超时按 skipped 处理
 */

import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { EvidenceGate } from '../../src/agent/EvidenceGate'

/** 在临时目录构造一个带 package.json 的假项目（用于探测用例） */
async function createFakeProject(scripts: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nexus-evidence-'))
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts }), 'utf-8')
  // bun 锁文件：探测到 script 后以 bun run 执行
  await writeFile(join(dir, 'bun.lock'), '', 'utf-8')
  return dir
}

describe('EvidenceGate 命令执行', () => {
  it('配置命令退出码 0 → passed', async () => {
    const dir = await createFakeProject({})
    const gate = new EvidenceGate({ lintCommand: 'bun -e process.exit(0)' }, dir)
    const result = await gate.runAll()
    const lint = result.results.find((r) => r.gate === 'lint')!
    expect(lint.skipped).toBe(false)
    expect(lint.exitCode).toBe(0)
    expect(lint.passed).toBe(true)
    expect(result.passed).toBe(true)
  })

  it('配置命令退出码 1 → 未通过且聚合 passed=false', async () => {
    const dir = await createFakeProject({})
    const gate = new EvidenceGate({ testCommand: 'bun -e process.exit(1)' }, dir)
    const result = await gate.runAll()
    const test = result.results.find((r) => r.gate === 'test')!
    expect(test.skipped).toBe(false)
    expect(test.exitCode).toBe(1)
    expect(test.passed).toBe(false)
    expect(result.passed).toBe(false)
  })

  it('未配置命令且项目无对应 script → skipped，聚合视为通过', async () => {
    const dir = await createFakeProject({})
    const gate = new EvidenceGate(undefined, dir)
    const result = await gate.runAll()
    expect(result.results.every((r) => r.skipped)).toBe(true)
    expect(result.passed).toBe(true)
  })

  it('探测 package.json scripts：lint script → bun run lint', async () => {
    // script 值用 exit 0：经 bun run 执行后退出码为 0（避免嵌套 bun 引号问题）
    const dir = await createFakeProject({ lint: 'exit 0' })
    const gate = new EvidenceGate(undefined, dir)
    const result = await gate.runAll()
    const lint = result.results.find((r) => r.gate === 'lint')!
    expect(lint.skipped).toBe(false)
    expect(lint.command).toBe('bun run lint')
    expect(lint.passed).toBe(true)
  })
})

describe('EvidenceGate 输出与超时护栏', () => {
  it('超长输出截断保留尾部', async () => {
    const dir = await createFakeProject({})
    const gate = new EvidenceGate(
      {
        // 双引号包裹整个 JS（cmd 下保留为单个参数），JS 内用单引号字符串
        lintCommand: 'bun -e "console.log(\'x\'.repeat(3000))"',
        maxOutputBytes: 200,
      },
      dir,
    )
    const result = await gate.runAll()
    const lint = result.results.find((r) => r.gate === 'lint')!
    expect(lint.output.length).toBeLessThanOrEqual(220) // 截断 + 前缀
    expect(lint.output).toContain('（已截断）')
    expect(lint.output.endsWith('xxx')).toBe(true)
    expect(lint.passed).toBe(true)
  })

  it('命令超时 → skipped 不误判失败', async () => {
    const dir = await createFakeProject({})
    const gate = new EvidenceGate(
      {
        // 双引号包裹：避免 cmd 把箭头函数中的 > 解释为重定向符
        lintCommand: 'bun -e "setTimeout(function(){},30000)"',
        timeoutMs: 300,
      },
      dir,
    )
    const result = await gate.runAll()
    const lint = result.results.find((r) => r.gate === 'lint')!
    expect(lint.skipped).toBe(true)
    expect(result.passed).toBe(true)
  })
})

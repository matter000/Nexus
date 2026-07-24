/**
 * 单元测试: CLI 参数解析
 */

import { describe, it, expect } from 'bun:test'
import { parseArgs } from '../../src/cli/args'

describe('parseArgs', () => {
  it('无参数返回默认值', () => {
    const args = parseArgs([])
    expect(args.permissionMode).toBe('ask')
    expect(args.verbose).toBe(false)
    expect(args.skipPlan).toBe(false)
    expect(args.version).toBe(false)
    expect(args.help).toBe(false)
    expect(args.prompt).toBeUndefined()
  })

  it('解析 --version', () => {
    const args = parseArgs(['--version'])
    expect(args.version).toBe(true)
  })

  it('解析 -h', () => {
    const args = parseArgs(['-h'])
    expect(args.help).toBe(true)
  })

  it('解析 -m 模型', () => {
    const args = parseArgs(['-m', 'gpt-4o'])
    expect(args.model).toBe('gpt-4o')
  })

  it('解析 --model 模型', () => {
    const args = parseArgs(['--model', 'claude-sonnet-4-20250514'])
    expect(args.model).toBe('claude-sonnet-4-20250514')
  })

  it('解析 --permission', () => {
    const args = parseArgs(['--permission', 'auto-edit'])
    expect(args.permissionMode).toBe('auto-edit')
  })

  it('解析 --skip-plan', () => {
    const args = parseArgs(['--skip-plan'])
    expect(args.skipPlan).toBe(true)
  })

  it('解析 --verbose', () => {
    const args = parseArgs(['--verbose'])
    expect(args.verbose).toBe(true)
  })

  it('解析位置参数为 prompt', () => {
    const args = parseArgs(['重构', 'utils', '模块'])
    expect(args.prompt).toBe('重构 utils 模块')
  })

  it('混合参数和位置参数', () => {
    const args = parseArgs(['-m', 'gpt-4o', '--skip-plan', '修复 bug'])
    expect(args.model).toBe('gpt-4o')
    expect(args.skipPlan).toBe(true)
    expect(args.prompt).toBe('修复 bug')
  })

  it('解析 --max-iterations', () => {
    const args = parseArgs(['--max-iterations', '30'])
    expect(args.maxIterations).toBe(30)
  })

  it('解析 --non-interactive', () => {
    const args = parseArgs(['--non-interactive', '运行测试'])
    expect(args.nonInteractive).toBe(true)
    expect(args.prompt).toBe('运行测试')
  })

  it('解析 --cwd', () => {
    const args = parseArgs(['--cwd', '/tmp/project'])
    expect(args.cwd).toBe('/tmp/project')
  })
})

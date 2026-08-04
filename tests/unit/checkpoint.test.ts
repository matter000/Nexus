/**
 * 单元测试: CheckpointManager Git 检查点管理
 * 验证初始化、创建、回滚、合并等 Git 操作
 * 使用临时目录隔离每个测试，避免污染项目仓库
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { CheckpointManager } from '../../src/sandbox/Checkpoint'

// Git 环境变量，避免并行测试中 git config 互相干扰
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Nexus Test',
  GIT_AUTHOR_EMAIL: 'test@nexus.dev',
  GIT_COMMITTER_NAME: 'Nexus Test',
  GIT_COMMITTER_EMAIL: 'test@nexus.dev',
}

// 帮助函数：在临时目录中执行 git 命令
async function gitRun(args: string[], cwd: string): Promise<{ stdout: string; exitCode: number }> {
  const { spawn } = await import('child_process')
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, ...GIT_ENV },
    })
    let stdout = ''
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    child.on('close', (code) => resolve({ stdout: stdout.trim(), exitCode: code ?? 1 }))
    child.on('error', () => resolve({ stdout: '', exitCode: 1 }))
  })
}

// 初始化临时目录为 git 仓库并配置用户信息
async function initGitRepo(cwd: string) {
  await gitRun(['init', '-q'], cwd)
}

describe('CheckpointManager', () => {
  let tmpDir: string

  beforeEach(async () => {
    // 为每个测试创建独立的临时目录
    tmpDir = await mkdtemp(join(tmpdir(), 'nexus-checkpoint-test-'))
    // 初始化为 git 仓库（环境变量 GIT_ENV 保证 commit 不依赖全局配置）
    await initGitRepo(tmpDir)
  })

  afterEach(async () => {
    // 清理临时目录
    try {
      await rm(tmpDir, { recursive: true, force: true })
    } catch {
      // Windows 可能因文件锁定失败，忽略
    }
  })

  it('在非 git 目录下能正确初始化（执行 git init）', async () => {
    const cm = new CheckpointManager(tmpDir)
    await cm.init()

    // 验证 git 仓库已创建
    const result = await gitRun(['rev-parse', '--is-inside-work-tree'], tmpDir)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('true')
  })

  it('init() 后 getCurrentStep() 返回 0', async () => {
    const cm = new CheckpointManager(tmpDir)
    await cm.init()
    expect(cm.getCurrentStep()).toBe(0)
  })

  it('init() 重复调用不报错（幂等）', async () => {
    const cm = new CheckpointManager(tmpDir)
    await cm.init()
    await cm.init() // 第二次应直接返回
    expect(cm.getCurrentStep()).toBe(0)
  })

  it('create() 方法创建 checkpoint 并返回 { step, message }', async () => {
    const cm = new CheckpointManager(tmpDir)
    await cm.init()

    // 创建一个文件变更
    await writeFile(join(tmpDir, 'test.txt'), 'hello nexus', 'utf-8')

    const checkpoint = await cm.create('添加测试文件')
    expect(checkpoint).not.toBeNull()
    expect(checkpoint!.step).toBe(1)
    expect(checkpoint!.message).toBe('添加测试文件')
    expect(checkpoint!.commitHash).toBeDefined()
    expect(checkpoint!.commitHash.length).toBeGreaterThan(0)
    expect(checkpoint!.filesChanged).toContain('test.txt')
  }, 15000)

  it('create() 无变更时返回 null', async () => {
    const cm = new CheckpointManager(tmpDir)
    await cm.init()

    // 无任何文件变更
    const checkpoint = await cm.create('空变更')
    expect(checkpoint).toBeNull()
  })

  it('undo() 方法回滚到上一个 checkpoint', async () => {
    const cm = new CheckpointManager(tmpDir)
    await cm.init()

    // 第一次变更
    await writeFile(join(tmpDir, 'file1.txt'), '内容1', 'utf-8')
    await cm.create('第一步')

    // 第二次变更
    await writeFile(join(tmpDir, 'file2.txt'), '内容2', 'utf-8')
    await cm.create('第二步')

    expect(cm.getCurrentStep()).toBe(2)

    // 回滚
    const result = await cm.undo()
    expect(result).toContain('已回滚步骤 2')
    expect(cm.getCurrentStep()).toBe(1)
    expect(cm.hasCheckpoints()).toBe(true) // 还有第一个 checkpoint
  }, 15000)

  it('undo() 无 checkpoint 时返回提示', async () => {
    const cm = new CheckpointManager(tmpDir)
    await cm.init()

    const result = await cm.undo()
    expect(result).toBe('没有可回滚的检查点')
  })

  it('getAll() 返回 checkpoint 列表', async () => {
    const cm = new CheckpointManager(tmpDir)
    await cm.init()

    await writeFile(join(tmpDir, 'a.txt'), 'a', 'utf-8')
    await cm.create('步骤A')

    await writeFile(join(tmpDir, 'b.txt'), 'b', 'utf-8')
    await cm.create('步骤B')

    const all = cm.getAll()
    expect(all.length).toBe(2)
    expect(all[0].step).toBe(1)
    expect(all[0].message).toBe('步骤A')
    expect(all[1].step).toBe(2)
    expect(all[1].message).toBe('步骤B')
  }, 15000)

  it('getAll() 返回副本，不影响内部状态', async () => {
    const cm = new CheckpointManager(tmpDir)
    await cm.init()

    await writeFile(join(tmpDir, 'x.txt'), 'x', 'utf-8')
    await cm.create('测试')

    const all = cm.getAll()
    all.pop() // 修改返回的数组
    expect(cm.getAll().length).toBe(1) // 内部状态不受影响
  })

  it('hasCheckpoints() 在有/无 checkpoint 时返回正确布尔值', async () => {
    const cm = new CheckpointManager(tmpDir)
    await cm.init()

    expect(cm.hasCheckpoints()).toBe(false)

    await writeFile(join(tmpDir, 'file.txt'), 'data', 'utf-8')
    await cm.create('创建文件')

    expect(cm.hasCheckpoints()).toBe(true)
  })

  it('mergeToWorkBranch() 能正确合并', async () => {
    const cm = new CheckpointManager(tmpDir)
    await cm.init()

    // 创建变更和 checkpoint
    await writeFile(join(tmpDir, 'merge-test.txt'), 'merge content', 'utf-8')
    await cm.create('合并测试')

    const result = await cm.mergeToWorkBranch()
    expect(result.success).toBe(true)
    expect(result.message).toContain('合并')
  })

  it('mergeToWorkBranch() 无 checkpoint 时返回 success', async () => {
    const cm = new CheckpointManager(tmpDir)
    await cm.init()

    const result = await cm.mergeToWorkBranch()
    expect(result.success).toBe(true)
    expect(result.message).toContain('无检查点需要合并')
  })

  it('create() 支持 todoId 参数', async () => {
    const cm = new CheckpointManager(tmpDir)
    await cm.init()

    await writeFile(join(tmpDir, 'todo-file.txt'), 'todo content', 'utf-8')
    const checkpoint = await cm.create('关联 todo', 'todo-123')

    expect(checkpoint).not.toBeNull()
    expect(checkpoint!.todoId).toBe('todo-123')
  }, 15000)

  it('多次 create() 步骤号递增', async () => {
    const cm = new CheckpointManager(tmpDir)
    await cm.init()

    await writeFile(join(tmpDir, 'f1.txt'), '1', 'utf-8')
    const cp1 = await cm.create('步骤1')

    await writeFile(join(tmpDir, 'f2.txt'), '2', 'utf-8')
    const cp2 = await cm.create('步骤2')

    await writeFile(join(tmpDir, 'f3.txt'), '3', 'utf-8')
    const cp3 = await cm.create('步骤3')

    expect(cp1!.step).toBe(1)
    expect(cp2!.step).toBe(2)
    expect(cp3!.step).toBe(3)
    expect(cm.getCurrentStep()).toBe(3)
  }, 15000)
})

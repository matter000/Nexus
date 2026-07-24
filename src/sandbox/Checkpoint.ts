/**
 * Git 检查点管理
 * 每个 edit 后自动 commit,支持回滚到任意步骤
 * 继承 Aider 的核心设计:让 "agent 犯错" 从灾难变成 "按一下 undo"
 */

import { spawn } from 'child_process'
import type { Checkpoint } from '../agent/types'

/** 执行 git 命令 */
function git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
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

export class CheckpointManager {
  private projectRoot: string
  private branch: string
  private checkpoints: Checkpoint[] = []
  private step = 0
  private initialized = false

  constructor(projectRoot: string, branch = 'nexus/checkpoints') {
    this.projectRoot = projectRoot
    this.branch = branch
  }

  /** 初始化检查点系统:确保在 git 仓库中,创建 checkpoint 分支 */
  async init(): Promise<void> {
    if (this.initialized) return

    // 检查是否是 git 仓库
    const status = await git(['rev-parse', '--is-inside-work-tree'], this.projectRoot)
    if (status.exitCode !== 0) {
      // 不是 git 仓库,初始化一个
      await git(['init'], this.projectRoot)
    }

    // 确保有初始提交(空仓库无法创建分支)
    const log = await git(['log', '--oneline', '-1'], this.projectRoot)
    if (log.exitCode !== 0) {
      await git(['add', '-A'], this.projectRoot)
      await git(['commit', '--allow-empty', '-m', 'nexus: initial checkpoint'], this.projectRoot)
    }

    // 创建或切换到 checkpoint 分支
    const branchCheck = await git(['rev-parse', '--verify', this.branch], this.projectRoot)
    if (branchCheck.exitCode !== 0) {
      // 分支不存在,从当前 HEAD 创建
      await git(['checkout', '-b', this.branch], this.projectRoot)
    } else {
      await git(['checkout', this.branch], this.projectRoot)
    }

    this.initialized = true
  }

  /** 创建检查点:暂存所有变更并提交 */
  async create(message: string, todoId?: string): Promise<Checkpoint | null> {
    if (!this.initialized) await this.init()

    this.step++

    // 暂存所有变更
    await git(['add', '-A'], this.projectRoot)

    // 检查是否有变更
    const diffCheck = await git(['diff', '--cached', '--quiet'], this.projectRoot)
    if (diffCheck.exitCode === 0) {
      // 无变更,不创建提交
      this.step--
      return null
    }

    // 提交
    const commitMsg = `nexus [step ${this.step}]: ${message}`
    const commit = await git(['commit', '-m', commitMsg], this.projectRoot)
    if (commit.exitCode !== 0) {
      this.step--
      return null
    }

    // 获取 commit hash
    const hashResult = await git(['rev-parse', 'HEAD'], this.projectRoot)
    const commitHash = hashResult.stdout

    // 获取变更文件列表
    const filesResult = await git(['diff', '--name-only', 'HEAD~1', 'HEAD'], this.projectRoot)
    const filesChanged = filesResult.stdout ? filesResult.stdout.split('\n').filter(Boolean) : []

    const checkpoint: Checkpoint = {
      step: this.step,
      commitHash,
      message,
      todoId,
      timestamp: Date.now(),
      filesChanged,
    }

    this.checkpoints.push(checkpoint)
    return checkpoint
  }

  /** 回滚到上一个检查点 */
  async undo(): Promise<string> {
    if (this.checkpoints.length === 0) {
      return '没有可回滚的检查点'
    }

    const last = this.checkpoints[this.checkpoints.length - 1]
    const targetHash = this.checkpoints.length > 1
      ? this.checkpoints[this.checkpoints.length - 2].commitHash
      : `${last.commitHash}~1`

    const result = await git(['reset', '--hard', targetHash], this.projectRoot)
    if (result.exitCode !== 0) {
      return `回滚失败: ${result.stderr}`
    }

    this.checkpoints.pop()
    this.step--
    return `已回滚步骤 ${last.step}: ${last.message}`
  }

  /** 回滚到指定步骤 */
  async jumpTo(step: number): Promise<string> {
    const target = this.checkpoints.find((cp) => cp.step === step)
    if (!target) {
      return `未找到步骤 ${step} 的检查点`
    }

    const result = await git(['reset', '--hard', target.commitHash], this.projectRoot)
    if (result.exitCode !== 0) {
      return `跳转失败: ${result.stderr}`
    }

    // 移除该步骤之后的所有检查点
    this.checkpoints = this.checkpoints.filter((cp) => cp.step <= step)
    this.step = step
    return `已跳转到步骤 ${step}: ${target.message}`
  }

  /** 获取所有检查点 */
  getAll(): Checkpoint[] {
    return [...this.checkpoints]
  }

  /** 获取当前步骤号 */
  getCurrentStep(): number {
    return this.step
  }

  /** 会话结束时,询问是否合并到工作分支 */
  async mergeToWorkBranch(targetBranch: string): Promise<string> {
    const result = await git(['checkout', targetBranch], this.projectRoot)
    if (result.exitCode !== 0) {
      return `切换到 ${targetBranch} 失败: ${result.stderr}`
    }

    const merge = await git(['merge', this.branch, '--no-edit'], this.projectRoot)
    if (merge.exitCode !== 0) {
      return `合并失败: ${merge.stderr}`
    }

    return `已将 ${this.checkpoints.length} 个检查点合并到 ${targetBranch}`
  }
}

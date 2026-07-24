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
  private workBranch = '' // 用户进入会话前的工作分支
  private checkpoints: Checkpoint[] = []
  private step = 0
  private initialized = false
  /** 是否启用检查点（对应 config.checkpoint.autoCheckpoint） */
  private enabled = true

  constructor(projectRoot: string, branch = 'nexus/checkpoints') {
    this.projectRoot = projectRoot
    this.branch = branch
  }

  /** 设置是否启用检查点 */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
  }

  /** 检查点是否启用 */
  isEnabled(): boolean {
    return this.enabled
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

    // 记录当前工作分支(在切换到 checkpoint 分支之前)
    const currentBranch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], this.projectRoot)
    if (currentBranch.exitCode === 0 && currentBranch.stdout && currentBranch.stdout !== 'HEAD') {
      this.workBranch = currentBranch.stdout
    } else {
      // detached HEAD 或无法获取分支名,使用 'main' 作为 fallback
      this.workBranch = 'main'
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
    // 检查点未启用时不创建（也不惰性初始化，避免意外切换分支）
    if (!this.enabled) return null
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

  /** 是否有检查点历史 */
  hasCheckpoints(): boolean {
    return this.checkpoints.length > 0
  }

  /** 获取用户进入会话前的工作分支名 */
  getWorkBranch(): string {
    return this.workBranch
  }

  /** 会话结束时,将 checkpoint 分支合并回工作分支 */
  async mergeToWorkBranch(targetBranch?: string): Promise<{ success: boolean; message: string }> {
    const target = targetBranch ?? this.workBranch
    if (!target) {
      return { success: false, message: '无法确定目标工作分支' }
    }

    if (this.checkpoints.length === 0) {
      // 即使无检查点，也要切回工作分支（init 可能已切换到 checkpoint 分支）
      if (this.initialized) {
        const checkout = await git(['checkout', target], this.projectRoot)
        if (checkout.exitCode !== 0) {
          return { success: false, message: `切换到 ${target} 失败: ${checkout.stderr}` }
        }
      }
      return { success: true, message: '无检查点需要合并' }
    }

    // 切回工作分支
    const checkout = await git(['checkout', target], this.projectRoot)
    if (checkout.exitCode !== 0) {
      return { success: false, message: `切换到 ${target} 失败: ${checkout.stderr}` }
    }

    // 合并 checkpoint 分支
    const merge = await git(['merge', this.branch, '--no-edit'], this.projectRoot)
    if (merge.exitCode !== 0) {
      // 检测是否为合并冲突
      const isConflict = merge.stderr.includes('CONFLICT') || merge.stderr.includes('Automatic merge failed')
      if (isConflict) {
        // 中止合并,保留工作区状态,让用户手动解决
        await git(['merge', '--abort'], this.projectRoot)
        return {
          success: false,
          message: `合并冲突!checkpoint 分支 "${this.branch}" 与 "${target}" 存在冲突。` +
            `请手动执行: git checkout ${target} && git merge ${this.branch}，解决冲突后提交。`,
        }
      }
      return { success: false, message: `合并失败: ${merge.stderr}` }
    }

    // 注意: 不删除 checkpoint 分支,保留历史以支持 /undo
    return {
      success: true,
      message: `已将 ${this.checkpoints.length} 个检查点合并到 ${target}`,
    }
  }
}

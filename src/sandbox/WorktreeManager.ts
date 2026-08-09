/**
 * WorktreeManager - 多智能体并行写的 git worktree 隔离
 *
 * 业界实践（Claude Code isolation: worktree / Codex worktree: true 同款）：
 * 每个写子任务在独立 worktree + 独立分支中执行，物理上杜绝并行写踩脚；
 * 完成后由编排层审批合并回主工作区。共享同一 .git 对象库，几乎不占额外空间。
 *
 * 保守策略：非 git 仓库或无 git 命令时 create 返回 null，调用方回退串行执行。
 */

import { spawn } from 'child_process'
import { join } from 'path'

/** worktree 分支前缀（便于识别与清理） */
export const WORKTREE_BRANCH_PREFIX = 'nexus-agent/'
/** worktree 目录（项目根内，已 gitignore） */
export const WORKTREE_DIR = join('.nexus', 'worktrees')
/** git 命令超时（ms） */
const GIT_TIMEOUT_MS = 30_000
/** 提交身份兜底（用户未配置全局 git config 时保证 worktree 提交可用，不修改任何 git 配置） */
const GIT_IDENTITY_ENV = {
  GIT_AUTHOR_NAME: 'Nexus Agent',
  GIT_AUTHOR_EMAIL: 'agent@nexus.local',
  GIT_COMMITTER_NAME: 'Nexus Agent',
  GIT_COMMITTER_EMAIL: 'agent@nexus.local',
}

export interface WorktreeInfo {
  taskId: string
  /** worktree 工作目录绝对路径 */
  path: string
  /** 独立分支名 */
  branch: string
  /** 创建时的基线 commit（主仓库 HEAD），diff 计算用 */
  baseSha: string
}

export interface MergeResult {
  success: boolean
  message: string
}

export class WorktreeManager {
  private active = new Map<string, WorktreeInfo>()

  constructor(private projectRoot: string) {}

  /** git 可用且项目是 git 仓库 */
  async isAvailable(): Promise<boolean> {
    const result = await this.execGit(['rev-parse', '--is-inside-work-tree'], this.projectRoot)
    return result.exitCode === 0 && result.stdout.trim() === 'true'
  }

  /**
   * 为任务创建独立 worktree（基于主仓库当前 HEAD 新建分支）。
   * 失败（无 git / 非仓库 / 分支冲突）返回 null，调用方回退串行。
   */
  async create(taskId: string): Promise<WorktreeInfo | null> {
    if (this.active.has(taskId)) return this.active.get(taskId)!

    const baseResult = await this.execGit(['rev-parse', 'HEAD'], this.projectRoot)
    if (baseResult.exitCode !== 0) return null

    const path = join(this.projectRoot, WORKTREE_DIR, taskId)
    const branch = `${WORKTREE_BRANCH_PREFIX}${taskId}`
    const addResult = await this.execGit(['worktree', 'add', path, '-b', branch], this.projectRoot)
    if (addResult.exitCode !== 0) return null

    const info: WorktreeInfo = { taskId, path, branch, baseSha: baseResult.stdout.trim() }
    this.active.set(taskId, info)
    return info
  }

  /** 提交 worktree 内未提交的变更（无变更时跳过）。返回是否有新提交 */
  async commitChanges(taskId: string, message: string): Promise<boolean> {
    const info = this.active.get(taskId)
    if (!info) return false

    const status = await this.execGit(['status', '--porcelain'], info.path)
    if (status.exitCode !== 0 || status.stdout.trim().length === 0) return false

    const add = await this.execGit(['add', '-A'], info.path)
    if (add.exitCode !== 0) return false
    const commit = await this.execGit(['commit', '-m', message, '--no-verify'], info.path)
    return commit.exitCode === 0
  }

  /**
   * 变更摘要（相对创建基线）：name-status 文件清单 + 截断的 patch。
   * 供合并审批展示与 reviewer 引擎审查输入。
   */
  async getDiffSummary(taskId: string, maxChars = 4000): Promise<string> {
    const info = this.active.get(taskId)
    if (!info) return ''

    const files = await this.execGit(['diff', info.baseSha, 'HEAD', '--name-status'], info.path)
    const uncommitted = await this.execGit(['status', '--porcelain'], info.path)
    const parts: string[] = []
    if (files.stdout.trim()) parts.push(files.stdout.trim())
    if (uncommitted.stdout.trim()) parts.push(`未提交变更:\n${uncommitted.stdout.trim()}`)
    if (parts.length === 0) return '(无变更)'

    const patch = await this.execGit(['diff', info.baseSha, 'HEAD', '--stat'], info.path)
    if (patch.stdout.trim()) parts.push(patch.stdout.trim())

    let summary = parts.join('\n\n')
    if (summary.length > maxChars) summary = `${summary.slice(0, maxChars)}\n...（diff 过长已截断）`
    return summary
  }

  /** 是否有变更（已提交或工作区未提交） */
  async hasChanges(taskId: string): Promise<boolean> {
    const info = this.active.get(taskId)
    if (!info) return false
    const committed = await this.execGit(['diff', '--quiet', info.baseSha, 'HEAD'], info.path)
    if (committed.exitCode !== 0) return true // diff --quiet 退出码 1 = 有差异
    const uncommitted = await this.execGit(['status', '--porcelain'], info.path)
    return uncommitted.stdout.trim().length > 0
  }

  /** 在主仓库合并任务分支（调用前应先获用户审批）。冲突时 abort 并保留现场 */
  async merge(taskId: string): Promise<MergeResult> {
    const info = this.active.get(taskId)
    if (!info) return { success: false, message: `未知 worktree 任务: ${taskId}` }

    const result = await this.execGit(['merge', info.branch, '--no-edit'], this.projectRoot)
    if (result.exitCode === 0) {
      return { success: true, message: `已合并 ${info.branch} 到主工作区` }
    }
    // 冲突：回滚合并状态，保留 worktree 分支供人工处理
    await this.execGit(['merge', '--abort'], this.projectRoot)
    return {
      success: false,
      message: `合并 ${info.branch} 冲突，已回滚合并状态。worktree 保留在 ${info.path}，请人工处理后用 git merge ${info.branch} 重试`,
    }
  }

  /** 分支是否已完全并入当前 HEAD（合并成功后清理判断用） */
  async isMerged(taskId: string): Promise<boolean> {
    const info = this.active.get(taskId)
    if (!info) return false
    const result = await this.execGit(
      ['merge-base', '--is-ancestor', info.branch, 'HEAD'],
      this.projectRoot,
    )
    return result.exitCode === 0
  }

  /** 删除 worktree 与分支（force，清理用） */
  async remove(taskId: string): Promise<void> {
    const info = this.active.get(taskId)
    if (!info) return
    await this.execGit(['worktree', 'remove', '--force', info.path], this.projectRoot)
    await this.execGit(['branch', '-D', info.branch], this.projectRoot)
    this.active.delete(taskId)
  }

  /** 当前活跃的 worktree 任务列表 */
  listActive(): WorktreeInfo[] {
    return Array.from(this.active.values())
  }

  /**
   * 会话结束清理：已合并或无变更的 worktree 删除；
   * 仍有未合并变更的保留（防丢失工作成果），仅从登记表移除。
   */
  async shutdown(): Promise<void> {
    for (const info of Array.from(this.active.values())) {
      const merged = await this.isMerged(info.taskId)
      const changed = await this.hasChanges(info.taskId)
      if (merged || !changed) {
        await this.remove(info.taskId)
      } else {
        // 保留现场，仅注销登记（避免重复 shutdown 误删）
        this.active.delete(info.taskId)
      }
    }
  }

  private execGit(
    args: string[],
    cwd: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve) => {
      const child = spawn('git', args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: GIT_TIMEOUT_MS,
        env: { ...GIT_IDENTITY_ENV, ...process.env },
        ...(process.platform === 'win32' ? { windowsHide: true } : {}),
      })
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString()
      })
      child.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString()
      })
      child.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }))
      child.on('error', (err) => resolve({ stdout: '', stderr: err.message, exitCode: 1 }))
    })
  }
}

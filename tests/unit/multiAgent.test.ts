/**
 * 单元测试: 多智能体协作系统
 * TaskBoard（共享任务板）/ Mailbox（信箱）/ WorktreeManager（隔离）/
 * SubAgent 成本熔断与审查闭环 / dispatch_subagents worktree 合并审批
 */

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { spawn } from 'child_process'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { TaskBoard } from '../../src/agent/TaskBoard'
import { Mailbox } from '../../src/agent/Mailbox'
import { WorktreeManager } from '../../src/sandbox/WorktreeManager'

// ─── generateText 脚本化 mock（按出队顺序返回预设响应） ──────────────────────
type ScriptedResponse = { text: string; toolCalls?: Array<{ toolName: string; input: unknown }> }
let script: ScriptedResponse[] = []
let generateTextCallCount = 0

;(mock as any).module('ai', () => ({
  generateText: async () => {
    generateTextCallCount++
    const next = script.shift()
    return {
      text: next?.text ?? '完成',
      toolCalls: next?.toolCalls ?? [],
      usage: { inputTokens: 10, outputTokens: 5 },
    }
  },
}))

import { AgentEngineRegistry } from '../../src/agent/AgentEngine'
import { SubAgent } from '../../src/agent/SubAgent'
import type { SubAgentResult, SubAgentTask } from '../../src/agent/types'
import { CostTracker } from '../../src/router/CostTracker'
import { createToolRegistry } from '../../src/tools/registry'

// ─── 工具 fixture ─────────────────────────────────────────────────────────────

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Nexus Test',
  GIT_AUTHOR_EMAIL: 'test@nexus.dev',
  GIT_COMMITTER_NAME: 'Nexus Test',
  GIT_COMMITTER_EMAIL: 'test@nexus.dev',
}

function gitRun(args: string[], cwd: string): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...GIT_ENV, ...process.env },
    })
    let stdout = ''
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    child.on('close', (code) => resolve({ stdout: stdout.trim(), exitCode: code ?? 1 }))
    child.on('error', () => resolve({ stdout: '', exitCode: 1 }))
  })
}

/** 临时 git 仓库（含初始提交，worktree 分支需基于 HEAD） */
async function makeGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nexus-worktree-test-'))
  await gitRun(['init', '-q'], dir)
  await writeFile(join(dir, 'base.txt'), 'base\n')
  await gitRun(['add', '-A'], dir)
  await gitRun(['commit', '-q', '-m', 'init'], dir)
  return dir
}

function createMockToolRegistry(opts: {
  onEdit?: (path: string, projectRoot: string) => Promise<void>
} = {}) {
  return {
    getForPhase: () => [],
    getAll: () => [],
    get: () => undefined,
    execute: async (name: string, params: Record<string, unknown>, context: { projectRoot: string }) => {
      if (name === 'edit_file' && opts.onEdit) {
        await opts.onEdit(params.path as string, context.projectRoot)
      }
      return { result: 'ok', error: undefined }
    },
  } as never
}

function createSubAgentConfig(overrides: Record<string, unknown> = {}) {
  return {
    model: {} as never,
    toolRegistry: createMockToolRegistry(),
    toolContext: {
      projectRoot: '/tmp',
      callId: '',
      maxReadLines: 2000,
      maxOutputBytes: 102400,
      bashTimeout: 30,
      todos: [],
    },
    maxIterations: 10,
    onEvent: () => {},
    permissionMode: 'yolo' as const,
    requestApproval: async () => true,
    costTracker: new CostTracker(),
    modelRole: 'executor' as const,
    providerName: 'anthropic' as const,
    modelName: 'claude-sonnet-4-20250514',
    costPer1kInput: 0.003,
    costPer1kOutput: 0.015,
    ...overrides,
  }
}

// ─── TaskBoard ───────────────────────────────────────────────────────────────

describe('TaskBoard 共享任务板', () => {
  it('syncFromTodos 灌入任务并映射状态', () => {
    const board = new TaskBoard()
    board.syncFromTodos([
      { id: '1', content: '步骤一', status: 'pending' },
      { id: '2', content: '步骤二', status: 'complete' },
    ])
    const list = board.list()
    expect(list.length).toBe(2)
    expect(list[0].status).toBe('pending')
    expect(list[1].status).toBe('done')
  })

  it('claim 先到先得，重复认领失败', () => {
    const board = new TaskBoard()
    board.add('1', '任务一')
    const first = board.claim('agent-a', '1')
    const second = board.claim('agent-b', '1')
    expect(first?.id).toBe('1')
    expect(second).toBeNull()
    expect(board.list()[0].claimedBy).toBe('agent-a')
  })

  it('缺省 task_id 时认领第一条 pending', () => {
    const board = new TaskBoard()
    board.add('1', '任务一')
    board.add('2', '任务二')
    const claimed = board.claim('agent-a')
    expect(claimed?.id).toBe('1')
  })

  it('仅认领者可 complete', () => {
    const board = new TaskBoard()
    board.add('1', '任务一')
    board.claim('agent-a', '1')
    expect(board.complete('1', 'agent-b')).toBe(false)
    expect(board.complete('1', 'agent-a', '做完了')).toBe(true)
    expect(board.list()[0].status).toBe('done')
  })
})

// ─── Mailbox ─────────────────────────────────────────────────────────────────

describe('Mailbox 引擎间信箱', () => {
  it('按 agentId 投递，readUnread 读后标记已读', () => {
    const box = new Mailbox()
    box.send('lead', 'coder-t1', '先改 utils 再改 index')
    const unread = box.readUnread('coder-t1')
    expect(unread.length).toBe(1)
    expect(unread[0].from).toBe('lead')
    // 再次读取无未读
    expect(box.readUnread('coder-t1').length).toBe(0)
  })

  it('无信箱的 agent 读取返回空数组', () => {
    const box = new Mailbox()
    expect(box.readUnread('nobody')).toEqual([])
  })

  it('formatMessages 带发送者标记', () => {
    const text = Mailbox.formatMessages([
      { from: 'lead', to: 'a', content: 'hello', timestamp: 0, read: false },
    ])
    expect(text).toContain('[来自 lead]')
    expect(text).toContain('hello')
  })
})

// ─── WorktreeManager ─────────────────────────────────────────────────────────

describe('WorktreeManager worktree 隔离', () => {
  let repo: string

  beforeEach(async () => {
    repo = await makeGitRepo()
  })

  afterAll(async () => {
    // afterAll 统一清理（repo 在部分测试中已被 remove，force 忽略）
  })

  it('非 git 目录 isAvailable 为 false 且 create 返回 null', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'nexus-nongit-'))
    const wm = new WorktreeManager(plain)
    expect(await wm.isAvailable()).toBe(false)
    expect(await wm.create('t1')).toBeNull()
    await rm(plain, { recursive: true, force: true })
  })

  it('create → 写入 → commitChanges → merge 全流程', async () => {
    const wm = new WorktreeManager(repo)
    const info = await wm.create('t1')
    expect(info).not.toBeNull()
    expect(info?.branch).toBe('nexus-agent/t1')

    // 在 worktree 中产生变更
    await writeFile(join(info!.path, 'feature.txt'), 'new feature\n')
    expect(await wm.hasChanges('t1')).toBe(true)
    expect(await wm.commitChanges('t1', 'test commit')).toBe(true)

    // diff 摘要包含新文件
    const diff = await wm.getDiffSummary('t1')
    expect(diff).toContain('feature.txt')

    // 合并前主仓库无该文件
    const mainBefore = await gitRun(['cat-file', '-e', 'HEAD:feature.txt'], repo)
    expect(mainBefore.exitCode).not.toBe(0)

    const merge = await wm.merge('t1')
    expect(merge.success).toBe(true)

    // 合并后主工作区出现该文件
    const content = await Bun.file(join(repo, 'feature.txt')).text()
    expect(content).toContain('new feature')

    await wm.remove('t1')
    expect(wm.listActive().length).toBe(0)
    await rm(repo, { recursive: true, force: true })
  })

  it('无变更时 hasChanges 为 false，shutdown 清理', async () => {
    const wm = new WorktreeManager(repo)
    await wm.create('t-empty')
    expect(await wm.hasChanges('t-empty')).toBe(false)
    await wm.shutdown()
    expect(wm.listActive().length).toBe(0)
    await rm(repo, { recursive: true, force: true })
  })
})

// ─── SubAgent 成本熔断与审查闭环 ──────────────────────────────────────────────

describe('SubAgent 成本熔断', () => {
  beforeEach(() => {
    script = []
    generateTextCallCount = 0
  })

  it('会话成本超限时拒绝分派子任务，不调用 LLM', async () => {
    const costTracker = new CostTracker()
    costTracker.record({
      role: 'executor',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      inputTokens: 100000,
      outputTokens: 1000,
      costPer1kInput: 0.003,
      costPer1kOutput: 0.015,
    })
    const sub = new SubAgent(createSubAgentConfig({ costTracker, maxSessionCost: 0.01 }) as never)
    const result = await sub.run({
      id: 'over-budget',
      description: '应被熔断的任务',
      tools: [],
      maxIterations: 3,
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain('成本')
    expect(generateTextCallCount).toBe(0)
  })
})

describe('SubAgent 自动审查闭环（coder→reviewer）', () => {
  beforeEach(() => {
    script = []
    generateTextCallCount = 0
  })

  it('autoReview 引擎有文件变更时触发审查，高危问题回传修复一轮', async () => {
    const engineRegistry = new AgentEngineRegistry()
    script = [
      // coder：先调用 edit_file，再收尾
      { text: '开始实现', toolCalls: [{ toolName: 'edit_file', input: { path: 'src/a.ts' } }] },
      { text: '实现完成' },
      // reviewer：输出含"高"的审查报告
      { text: '高: 未处理空值边界\n中: 命名可优化' },
      // fix 轮：edit_file 修复后收尾
      { text: '修复中', toolCalls: [{ toolName: 'edit_file', input: { path: 'src/a.ts' } }] },
      { text: '已修复空值边界' },
    ]
    const sub = new SubAgent(createSubAgentConfig({ engineRegistry }) as never)
    const result = await sub.run({
      id: 'coder-task',
      description: '实现功能',
      engine: 'coder',
      writable: true,
      tools: [],
      maxIterations: 5,
    })
    expect(result.success).toBe(true)
    expect(generateTextCallCount).toBe(5) // coder 2 + reviewer 1 + fix 2
    expect(result.reviewReport).toContain('高: 未处理空值边界')
    expect(result.reviewReport).toContain('[自动修复轮]')
  })

  it('无 autoReview 的引擎不触发审查', async () => {
    const engineRegistry = new AgentEngineRegistry()
    script = [
      { text: '探索', toolCalls: [{ toolName: 'edit_file', input: { path: 'src/a.ts' } }] },
      { text: '完成' },
    ]
    const sub = new SubAgent(createSubAgentConfig({ engineRegistry }) as never)
    const result = await sub.run({
      id: 'plain-task',
      description: '任务',
      engine: 'explorer', // explorer 无 autoReview
      writable: true,
      tools: [],
      maxIterations: 5,
    })
    expect(result.success).toBe(true)
    expect(generateTextCallCount).toBe(2) // 无审查轮
    expect(result.reviewReport).toBeUndefined()
  })

  it('noReview 标记的任务跳过审查（防递归）', async () => {
    const engineRegistry = new AgentEngineRegistry()
    script = [
      { text: '改', toolCalls: [{ toolName: 'edit_file', input: { path: 'src/a.ts' } }] },
      { text: '完成' },
    ]
    const sub = new SubAgent(createSubAgentConfig({ engineRegistry }) as never)
    const result = await sub.run({
      id: 'fix-task',
      description: '修复',
      engine: 'coder',
      writable: true,
      tools: [],
      maxIterations: 5,
      noReview: true,
    })
    expect(generateTextCallCount).toBe(2)
    expect(result.reviewReport).toBeUndefined()
  })
})

// ─── SubAgent worktree 隔离执行 ──────────────────────────────────────────────

describe('SubAgent worktree 隔离执行', () => {
  beforeEach(() => {
    script = []
    generateTextCallCount = 0
  })

  it('isolation: worktree 时变更写入 worktree 且主工作区不受影响', async () => {
    const repo = await makeGitRepo()
    const worktreeManager = new WorktreeManager(repo)
    // edit_file 在子 Agent 的执行目录（worktree）中真实写文件
    const toolRegistry = createMockToolRegistry({
      onEdit: async (path, projectRoot) => {
        await writeFile(join(projectRoot, path), 'worktree change\n')
      },
    })
    script = [
      { text: '写入', toolCalls: [{ toolName: 'edit_file', input: { path: 'feature.txt' } }] },
      { text: '完成' },
    ]
    const sub = new SubAgent(
      createSubAgentConfig({
        toolRegistry,
        toolContext: {
          projectRoot: repo,
          callId: '',
          maxReadLines: 2000,
          maxOutputBytes: 102400,
          bashTimeout: 30,
          todos: [],
        },
        worktreeManager,
      }) as never,
    )
    const result = await sub.run({
      id: 'iso-task',
      description: '隔离写任务',
      writable: true,
      isolation: 'worktree',
      tools: [],
      maxIterations: 5,
    })
    expect(result.success).toBe(true)
    expect(result.worktreeBranch).toBe('nexus-agent/iso-task')
    expect(result.diffSummary).toContain('feature.txt')
    // 主工作区无该文件（隔离生效）
    const mainHas = await Bun.file(join(repo, 'feature.txt'))
      .exists()
    expect(mainHas).toBe(false)
    // worktree 内有该文件且已提交
    const wtHas = await Bun.file(join(repo, '.nexus', 'worktrees', 'iso-task', 'feature.txt')).exists()
    expect(wtHas).toBe(true)
    await worktreeManager.remove('iso-task')
    await rm(repo, { recursive: true, force: true })
  })

  it('非 git 仓库回退主工作区执行（不阻塞）', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'nexus-isofallback-'))
    const worktreeManager = new WorktreeManager(plain)
    script = [{ text: '完成' }]
    const sub = new SubAgent(
      createSubAgentConfig({
        worktreeManager,
        toolContext: {
          projectRoot: plain,
          callId: '',
          maxReadLines: 2000,
          maxOutputBytes: 102400,
          bashTimeout: 30,
          todos: [],
        },
      }) as never,
    )
    const result = await sub.run({
      id: 'fallback-task',
      description: '回退任务',
      writable: true,
      isolation: 'worktree',
      tools: [],
      maxIterations: 3,
    })
    expect(result.success).toBe(true)
    expect(result.worktreeBranch).toBeUndefined()
    await rm(plain, { recursive: true, force: true })
  })
})

// ─── dispatch_subagents worktree 合并审批 ────────────────────────────────────

describe('dispatch_subagents worktree 并行写与合并审批', () => {
  it('隔离写任务完成后经审批合并进主仓库', async () => {
    const repo = await makeGitRepo()
    const wm = new WorktreeManager(repo)
    // 预建 worktree 并产生已提交变更（模拟子 Agent 完成）
    await wm.create('wt-1')
    const info = wm.listActive()[0]
    await writeFile(join(info.path, 'parallel.txt'), 'parallel write\n')
    await wm.commitChanges('wt-1', 'sub agent change')

    const registry = createToolRegistry()
    registry.setWorktreeManager(wm)
    let approvalCalled = false
    registry.setMergeApprovalHandler(async (diff) => {
      approvalCalled = true
      expect(diff).toContain('nexus-agent/wt-1')
      return true
    })
    registry.setSubAgentRunner({
      run: async (_task: SubAgentTask): Promise<SubAgentResult> => ({
        id: 'wt-1',
        success: true,
        summary: '子任务完成',
        filesChanged: ['parallel.txt'],
        worktreeBranch: 'nexus-agent/wt-1',
        worktreePath: info.path,
        diffSummary: 'A parallel.txt',
      }),
    })

    const result = await registry.execute(
      'dispatch_subagents',
      { tasks: [{ description: '并行写任务', writable: true, isolation: 'worktree' }] },
      {
        projectRoot: repo,
        callId: 'test-merge',
        maxReadLines: 2000,
        maxOutputBytes: 102400,
        bashTimeout: 30,
        todos: [],
      },
    )
    expect(approvalCalled).toBe(true)
    expect(result.result).toContain('已合并')
    // 合并后主工作区出现文件
    expect(await Bun.file(join(repo, 'parallel.txt')).exists()).toBe(true)
    await rm(repo, { recursive: true, force: true })
  })

  it('审批拒绝时不合并并保留分支', async () => {
    const repo = await makeGitRepo()
    const wm = new WorktreeManager(repo)
    await wm.create('wt-2')
    const info = wm.listActive()[0]
    await writeFile(join(info.path, 'rejected.txt'), 'x\n')
    await wm.commitChanges('wt-2', 'change')

    const registry = createToolRegistry()
    registry.setWorktreeManager(wm)
    registry.setMergeApprovalHandler(async () => false)
    registry.setSubAgentRunner({
      run: async (): Promise<SubAgentResult> => ({
        id: 'wt-2',
        success: true,
        summary: '完成',
        filesChanged: ['rejected.txt'],
        worktreeBranch: 'nexus-agent/wt-2',
        diffSummary: 'A rejected.txt',
      }),
    })

    const result = await registry.execute(
      'dispatch_subagents',
      { tasks: [{ description: '任务', writable: true, isolation: 'worktree' }] },
      {
        projectRoot: repo,
        callId: 'test-reject',
        maxReadLines: 2000,
        maxOutputBytes: 102400,
        bashTimeout: 30,
        todos: [],
      },
    )
    expect(result.result).toContain('拒绝合并')
    expect(await Bun.file(join(repo, 'rejected.txt')).exists()).toBe(false)
    await wm.remove('wt-2')
    await rm(repo, { recursive: true, force: true })
  })
})

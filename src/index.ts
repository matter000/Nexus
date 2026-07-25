#!/usr/bin/env bun
/**
 * Nexus 入口文件
 * 解析参数 → 加载配置 → 启动 TUI 或非交互模式
 */

import React from 'react'
import { render } from 'ink'
import { parseArgs, getHelpText } from './cli/args'
import { loadConfig } from './config'
import { loadSecrets, saveSecrets, hasAnyApiKey } from './config-secrets'
import { Orchestrator } from './agent/Orchestrator'
import { App } from './tui/App'
import { eventBus } from './core/eventBus'
import type { CommandContext } from './cli/commands'
import type { NexusConfig, NexusEvent } from './agent/types'
import { exportSession } from './utils/export'

const VERSION = '0.1.0'

/** 当前待处理的审批 resolve 函数，由 requestApproval 设置，App 通过 globalThis 获取 */
let approvalResolver: ((approved: boolean) => void) | null = null

/** 审批队列：callId → resolve，防止快速连续审批时互相覆盖 */
const approvalResolverMap = new Map<string, (approved: boolean) => void>()

export function setApprovalResolve(resolve: ((approved: boolean) => void) | null): void {
  approvalResolver = resolve
  ;(globalThis as Record<string, unknown>).__nexusApprovalResolve = resolve
}

export function getApprovalResolve(): ((approved: boolean) => void) | null {
  return approvalResolver
}

/** 计划审批 resolve 函数：返回 'approve' | 'reject' | 反馈文本 */
type PlanApprovalResult = 'approve' | 'reject' | string
let planApprovalResolver: ((result: PlanApprovalResult) => void) | null = null

/** 计划审批队列：callId → resolve */
const planApprovalResolverMap = new Map<string, (result: PlanApprovalResult) => void>()

export function setPlanApprovalResolve(resolve: ((result: PlanApprovalResult) => void) | null): void {
  planApprovalResolver = resolve
  ;(globalThis as Record<string, unknown>).__nexusPlanApprovalResolve = resolve
}

export function getPlanApprovalResolve(): ((result: PlanApprovalResult) => void) | null {
  return planApprovalResolver
}

/** 生成唯一 callId */
let approvalCounter = 0
function nextApprovalCallId(): string {
  return `approval-${Date.now()}-${++approvalCounter}`
}

/** 通过 callId 获取并移除 tool 审批 resolver */
export function getApprovalResolveByCallId(callId: string): ((approved: boolean) => void) | null {
  const r = approvalResolverMap.get(callId) ?? null
  if (r) approvalResolverMap.delete(callId)
  return r
}

/** 通过 callId 获取并移除 plan 审批 resolver */
export function getPlanApprovalResolveByCallId(callId: string): ((result: PlanApprovalResult) => void) | null {
  const r = planApprovalResolverMap.get(callId) ?? null
  if (r) planApprovalResolverMap.delete(callId)
  return r
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  // 调试日志位置提示
  process.stderr.write(`[Nexus] 调试日志: ${process.cwd()}/.nexus/debug.jsonl\n`)

  // 版本和帮助
  if (args.version) {
    console.log(`Nexus v${VERSION}`)
    process.exit(0)
  }
  if (args.help) {
    console.log(getHelpText())
    process.exit(0)
  }

  // 加载配置
  const config = await loadConfig(args.cwd)

  // 读取 secrets 以恢复上次使用的模型
  const secrets = await loadSecrets(args.cwd)
  if (secrets.lastModel && !args.model) {
    // 仅当用户未通过 CLI 参数指定模型时，才恢复上次使用的模型
    config.models.executor = secrets.lastModel
    config.models.planner = secrets.lastModel
  }

  // 覆盖 CLI 参数
  if (args.permissionMode) {
    config.permissions.mode = args.permissionMode
  }
  if (args.maxIterations) {
    config.limits.maxIterations = args.maxIterations
  }
  if (args.model) {
    config.models.executor = args.model
    config.models.planner = args.model
  }
  if (args.provider) {
    // 将 CLI 指定的 provider 作为所有角色的首选
    // 通过设置 models.providers 中对应 provider 的优先级来实现
    // ModelRouter 的 auto 模式会按 provider 优先级选择模型
    const providerName = args.provider
    if (config.models.providers[providerName]) {
      // 确保该 provider 在配置中存在
      // 将 executor/planner 模型设置为该 provider 的默认模型（如果未通过 --model 指定）
      if (!args.model) {
        const providerDefaultModel = config.models.providers[providerName].defaultModel
        if (providerDefaultModel) {
          config.models.executor = providerDefaultModel
          config.models.planner = providerDefaultModel
        }
      }
    }
  }

  // ─── Eval 子命令 ──────────────────────────────────────────────────────────
  if (args.evalDir) {
    const { HarnessEngine } = await import('./harness/Engine')
    const { printReport, exportJSON } = await import('./harness/Reporter')
    const { writeFile } = await import('fs/promises')

    const engine = new HarnessEngine({
      tasksDir: args.evalDir,
      mode: args.evalMock ? 'mock' : 'real',
      runner: async (task, workDir) => {
        if (args.evalMock) return { output: '', cost: 0 }
        try {
          const orch = new Orchestrator({
            projectRoot: workDir, config,
            permissionMode: 'yolo', skipPlan: true,
            maxIterations: Math.min(config.limits.maxIterations, 20),
            onEvent: () => {},
            requestApproval: async () => true,
            requestPlanApproval: async () => 'approve' as const,
          })
          await orch.init()
          const output = await orch.submit(task.userRequest)
          const cost = orch.getCostSummary().total
          await orch.shutdown()
          return { output, cost }
        } catch (err) {
          return { output: `执行失败: ${err instanceof Error ? err.message : String(err)}`, cost: 0 }
        }
      },
    })

    let report
    if (args.evalTask) {
      const { loadTasks } = await import('./harness/TaskLoader')
      const tasks = await loadTasks(args.evalDir)
      const task = tasks.find(t => t.id === args.evalTask)
      if (!task) { console.error(`未找到任务: ${args.evalTask}`); process.exit(1) }
      report = { mode: args.evalMock ? 'mock' as const : 'real' as const, tasksTotal: 1, tasksPassed: 0, tasksFailed: 0, totalCost: 0, totalDurationMs: 0, results: [await engine.runOne(task)], timestamp: Date.now() }
      report.tasksPassed = report.results[0].pass ? 1 : 0
      report.tasksFailed = report.results[0].pass ? 0 : 1
      report.totalCost = report.results[0].cost
      report.totalDurationMs = report.results[0].durationMs
    } else {
      report = await engine.runAll()
    }

    if (args.evalJson) {
      await writeFile(args.evalJson, exportJSON(report), 'utf-8')
      console.log(`报告已导出到: ${args.evalJson}`)
    }
    printReport(report)
    process.exit(report.tasksFailed > 0 ? 1 : 0)
  }

  // 创建 Orchestrator
  const orchestrator = new Orchestrator({
    projectRoot: args.cwd,
    config,
    permissionMode: config.permissions.mode,
    skipPlan: args.skipPlan,
    maxIterations: config.limits.maxIterations,
    onEvent: (event: NexusEvent) => {
      eventBus.emit(event)
    },
    requestApproval: async (tool, params, diff) => {
      // 非交互模式下默认批准
      if (args.nonInteractive) return true
      const callId = nextApprovalCallId()
      return new Promise<boolean>((resolve) => {
        // 存入队列 Map，支持并发审批
        approvalResolverMap.set(callId, resolve)
        // 兼容旧的单槽 globalThis（TUI 的自动批准路径仍用此）
        approvalResolver = resolve
        ;(globalThis as Record<string, unknown>).__nexusApprovalResolve = resolve
        ;(globalThis as Record<string, unknown>).__nexusApprovalCallId = callId
        eventBus.emit({ type: 'tool_approval_request', callId, tool, params, diff })
      })
    },
    requestPlanApproval: async (plan) => {
      // 非交互模式下默认批准
      if (args.nonInteractive) return 'approve'
      const callId = nextApprovalCallId()
      return new Promise<'approve' | 'reject' | string>((resolve) => {
        planApprovalResolverMap.set(callId, resolve)
        planApprovalResolver = resolve
        ;(globalThis as Record<string, unknown>).__nexusPlanApprovalResolve = resolve
        ;(globalThis as Record<string, unknown>).__nexusPlanApprovalCallId = callId
        eventBus.emit({ type: 'plan_approval_request', plan })
      })
    },
  })

  await orchestrator.init()

  // 检查是否有可用 provider
  const hasProvider = orchestrator.getAvailableModels().length > 0

  if (!hasProvider) {
    // 非交互模式: 输出引导信息后正常退出
    if (args.nonInteractive) {
      console.error([
        '❌ 未检测到任何可用的 AI 模型 API Key。',
        '',
        '请至少配置一个 provider:',
        '  • Anthropic:  export ANTHROPIC_API_KEY=sk-...',
        '  • OpenAI:     export OPENAI_API_KEY=sk-...',
        '  • DeepSeek:   export DEEPSEEK_API_KEY=sk-...',
        '',
        '或运行交互模式进行配置: nexus（不带 --non-interactive）',
      ].join('\n'))
      await orchestrator.shutdown()
      process.exit(1)
    }
    // TUI 模式: 继续启动，ApiConfigPanel 会自动弹出引导用户配置
  }

  // 监听 config_updated 事件：用户在 TUI 中保存 API Key 后重新初始化 providers
  eventBus.on(async (event) => {
    if (event.type === 'config_updated') {
      await orchestrator.reinitProviders()
    }
  })

  // SIGINT 处理:Ctrl+C 时合并 checkpoint 并清理
  const handleExit = async () => {
    // 持久化当前使用的模型，下次启动时恢复为上次退出前使用的模型
    try {
      const currentModel = orchestrator.getCurrentModel()
      if (currentModel && currentModel !== 'not-initialized' && !currentModel.includes('未配置')) {
        const exitSecrets = await loadSecrets(args.cwd)
        exitSecrets.lastModel = currentModel
        await saveSecrets(args.cwd, exitSecrets)
      }
    } catch { /* 静默忽略：模型持久化失败不应阻塞退出 */ }
    await orchestrator.shutdown()
  }
  process.on('SIGINT', async () => {
    await handleExit()
    process.exit(0)
  })
  process.on('SIGTERM', async () => {
    await handleExit()
    process.exit(0)
  })

  // 命令上下文(斜杠命令用)
  const commandContext: CommandContext = {
    getModel: () => orchestrator.getCurrentModel(),
    setModel: (model) => orchestrator.setModel(model),
    reinitAndSelectModel: async (model) => {
      await orchestrator.reinitProviders()
      orchestrator.setModel(model)
      // 同时持久化最后使用的模型
      const currentSecrets = await loadSecrets(args.cwd)
      currentSecrets.lastModel = model
      await saveSecrets(args.cwd, currentSecrets)
    },
    reinitProviders: async () => {
      await orchestrator.reinitProviders()
    },
    getAvailableModels: () => orchestrator.getAvailableModels(),
    getAllKnownModels: () => orchestrator.getAllKnownModels(),
    isProviderConfigured: (providerName) => orchestrator.isProviderConfigured(providerName),
    getCost: () => orchestrator.getCostSummary(),
    clearContext: () => orchestrator.clearContext(),
    undo: () => orchestrator.undo(),
    compact: async () => {
      return orchestrator.compactHistory()
    },
    getHistory: () => orchestrator.getHistory(),
    setSkipPlan: (skip) => orchestrator.setSkipPlan(skip),
    getSkipPlan: () => orchestrator.getSkipPlan(),
    saveLastModel: async (model) => {
      const currentSecrets = await loadSecrets(args.cwd)
      currentSecrets.lastModel = model
      await saveSecrets(args.cwd, currentSecrets)
    },
    restoreSession: async (sessionId?) => {
      return orchestrator.restoreSession(sessionId)
    },
    listRecentSessions: (limit?) => {
      return orchestrator.listRecentSessions(limit)
    },
    exportSession: async (outputPath?) => {
      return exportSession({
        history: orchestrator.getFullHistory(),
        todos: orchestrator.getTodos(),
        cost: orchestrator.getCostSummary(),
        projectRoot: args.cwd,
      }, outputPath)
    },
    getStatus: () => {
      return orchestrator.getStatus()
    },
  }

  // 非交互模式
  if (args.nonInteractive && args.prompt) {
    // 非交互模式需要同步完成后台初始化（CodeGraph / DB / MCP），才能正确执行 submit
    await orchestrator.startBackgroundInit()

    // 非交互模式下支持 --resume
    if (args.resume) {
      const sessionId = typeof args.resume === 'string' ? args.resume : undefined
      const result = await orchestrator.restoreSession(sessionId)
      if (result.restored) {
        console.log(result.message)
      }
    }

    const result = await orchestrator.submit(args.prompt)
    console.log(result)
    const cost = orchestrator.getCostSummary()
    console.log(`\n--- 花费: $${cost.total.toFixed(4)} ---`)
    await handleExit()
    process.exit(0)
  }

  // TUI 模式

  // 检查 stdin 是否为 TTY（Ink 需要 raw mode 终端）
  if (!process.stdin.isTTY) {
    console.error('错误: Nexus 需要在交互式终端中运行。')
    console.error('请确保在 Windows Terminal / PowerShell / CMD 中直接运行，')
    console.error('而非通过管道、重定向或非交互式环境调用。')
    await orchestrator.shutdown()
    process.exit(1)
  }

  let waitUntilExit: () => Promise<void>
  try {
    const instance = render(
      React.createElement(App, {
        onSubmit: (text: string) => {
          orchestrator.submit(text).catch((err) => {
            eventBus.emit({ type: 'error', message: String(err), recoverable: true })
          })
        },
        onApproval: () => { /* resolve handled via module-level approvalResolver */ },
        commandContext,
        projectRoot: args.cwd,
      }),
      { exitOnCtrlC: false },
    )
    waitUntilExit = instance.waitUntilExit
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException
    if (err.code === 'EINVAL' || (err.message && err.message.includes('EINVAL'))) {
      console.error('终端不兼容: Ink 无法在当前终端启用 raw mode (EINVAL)。')
      console.error('建议使用 Windows Terminal 或 ConEmu 运行 Nexus。')
      console.error('如使用 VS Code 内置终端，请尝试升级到最新版本。')
    } else {
      console.error('TUI 启动失败:', err.message || err)
    }
    await orchestrator.shutdown()
    process.exit(1)
  }

  // TUI 已渲染，后台异步完成剩余初始化（CodeGraph / DB / MCP），不阻塞用户交互
  orchestrator.startBackgroundInit().then(async () => {
    // 初始化完成后处理 --resume 标志
    if (args.resume) {
      const sessionId = typeof args.resume === 'string' ? args.resume : undefined
      await orchestrator.restoreSession(sessionId)
    }
  }).catch((err) => {
    eventBus.emit({ type: 'error', message: `后台初始化失败: ${err}`, recoverable: true })
  })

  // 如果有初始 prompt,自动提交
  if (args.prompt) {
    setTimeout(() => {
      orchestrator.submit(args.prompt!).catch((err) => {
        eventBus.emit({ type: 'error', message: String(err), recoverable: true })
      })
    }, 100)
  }

  await waitUntilExit()
  await handleExit()
}

main().catch((err) => {
  console.error('Nexus 启动失败:', err)
  process.exit(1)
})

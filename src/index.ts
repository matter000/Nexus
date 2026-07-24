#!/usr/bin/env bun
/**
 * Nexus 入口文件
 * 解析参数 → 加载配置 → 启动 TUI 或非交互模式
 */

import React from 'react'
import { render } from 'ink'
import { parseArgs, getHelpText } from './cli/args'
import { loadConfig } from './config'
import { Orchestrator } from './agent/Orchestrator'
import { App, emitToUI } from './tui/App'
import type { CommandContext } from './cli/commands'
import type { NexusConfig, NexusEvent } from './agent/types'

const VERSION = '0.1.0'

async function main() {
  const args = parseArgs(process.argv.slice(2))

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

  // 覆盖 CLI 参数
  if (args.permissionMode) {
    config.permissions.mode = args.permissionMode
  }
  if (args.maxIterations) {
    config.limits.maxIterations = args.maxIterations
  }

  // 创建 Orchestrator
  let approvalResolver: ((approved: boolean) => void) | null = null

  const orchestrator = new Orchestrator({
    projectRoot: args.cwd,
    config,
    permissionMode: config.permissions.mode,
    skipPlan: args.skipPlan,
    maxIterations: config.limits.maxIterations,
    onEvent: (event: NexusEvent) => {
      emitToUI(event)
    },
    requestApproval: async (_tool, _params, _diff) => {
      // 在 TUI 模式下,通过事件系统请求审批
      // 非交互模式下默认批准
      if (args.nonInteractive) return true
      return new Promise<boolean>((resolve) => {
        approvalResolver = resolve
        // TUI 组件会调用 resolve
      })
    },
  })

  await orchestrator.init()

  // 命令上下文(斜杠命令用)
  const commandContext: CommandContext = {
    getModel: () => orchestrator.getCurrentModel(),
    setModel: (model) => orchestrator.setModel(model),
    getCost: () => orchestrator.getCostSummary(),
    clearContext: () => orchestrator.clearContext(),
    undo: () => orchestrator.undo(),
    getHistory: () => orchestrator.getHistory(),
  }

  // 非交互模式
  if (args.nonInteractive && args.prompt) {
    const result = await orchestrator.submit(args.prompt)
    console.log(result)
    const cost = orchestrator.getCostSummary()
    console.log(`\n--- 花费: $${cost.total.toFixed(4)} ---`)
    process.exit(0)
  }

  // TUI 模式
  const { waitUntilExit } = render(
    React.createElement(App, {
      onSubmit: (text: string) => {
        orchestrator.submit(text).catch((err) => {
          emitToUI({ type: 'error', message: String(err), recoverable: true })
        })
      },
      onApproval: (resolve) => { approvalResolver = resolve },
      commandContext,
      model: orchestrator.getCurrentModel(),
      cost: `$${orchestrator.getCostSummary().total.toFixed(4)}`,
    })
  )

  // 如果有初始 prompt,自动提交
  if (args.prompt) {
    setTimeout(() => {
      orchestrator.submit(args.prompt!).catch((err) => {
        emitToUI({ type: 'error', message: String(err), recoverable: true })
      })
    }, 100)
  }

  await waitUntilExit()
}

main().catch((err) => {
  console.error('Nexus 启动失败:', err)
  process.exit(1)
})

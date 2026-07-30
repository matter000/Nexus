/**
 * Nexus TUI 根组件
 * 整合消息列表、工具卡片、审批、进度条、输入框
 * 布局风格参考 Claude Code CLI
 */

import { Box, Text, useApp, useInput } from 'ink'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentPhase, NexusEvent, Plan, Todo } from '../agent/types'
import { type CommandContext, handleSlashCommand, isSlashCommand } from '../cli/commands'
import { hasAnyApiKey, loadSecrets, type SecretsConfig, saveSecrets } from '../config-secrets'
import { eventBus } from '../core/eventBus'
import { requiresForcedApproval } from '../sandbox/CommandGuard'
import { ApiConfigPanel } from './components/ApiConfigPanel'
import { ApprovalPrompt } from './components/ApprovalPrompt'
import { InputBox } from './components/InputBox'
import { LogoBanner } from './components/LogoBanner'
import { type Message, MessageList } from './components/MessageList'
import { ModelSelector } from './components/ModelSelector'
import { PlanApprovalPanel } from './components/PlanApprovalPanel'
import { TodoProgress } from './components/TodoProgress'
import { ToolCard, type ToolStatus } from './components/ToolCard'
import { theme } from './theme'

interface ToolCallDisplay {
  callId: string
  tool: string
  params: Record<string, unknown>
  status: ToolStatus
  result?: string
  error?: string
}

interface ApprovalState {
  callId: string
  tool: string
  params: Record<string, unknown>
  diff?: string
  resolve: (approved: boolean) => void
}

interface AppProps {
  onSubmit: (text: string) => void
  onApproval: (resolve: (approved: boolean) => void) => void
  commandContext: CommandContext
  projectRoot: string
}

export function App({ onSubmit, onApproval, commandContext, projectRoot }: AppProps) {
  const { exit } = useApp()
  const [messages, setMessages] = useState<Message[]>([])
  const [toolCalls, setToolCalls] = useState<ToolCallDisplay[]>([])
  const [todos, setTodos] = useState<Todo[]>([])
  const [phase, setPhase] = useState<AgentPhase>('idle')
  const [streamingText, setStreamingText] = useState('')
  const [approval, setApproval] = useState<ApprovalState | null>(null)
  const [planApproval, setPlanApproval] = useState<{
    plan: Plan
    resolve: (result: 'approve' | 'reject' | string) => void
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [showConfig, setShowConfig] = useState(false)
  const [showModelSelector, setShowModelSelector] = useState(false)
  const [isFirstRun, setIsFirstRun] = useState(false)
  const [secrets, setSecrets] = useState<SecretsConfig>({ providers: {} })
  const [renderTick, setRenderTick] = useState(0)
  const [autoApproveTools, setAutoApproveTools] = useState<Set<string>>(new Set())
  const [todoExpanded, setTodoExpanded] = useState(false)
  const [forceExpandTools, setForceExpandTools] = useState(false)
  const autoApproveRef = useRef<Set<string>>(new Set())
  const msgIdRef = useRef(0)
  // 面板回调 refs（由 App 的 useInput 统一调度，避免多组件 useInput 冲突）
  const approvalRef = useRef<ApprovalState | null>(null)
  const planApprovalRef = useRef<{
    plan: Plan
    resolve: (result: 'approve' | 'reject' | string) => void
  } | null>(null)

  // 同步 state 到 refs
  useEffect(() => {
    approvalRef.current = approval
  }, [approval])
  useEffect(() => {
    planApprovalRef.current = planApproval
  }, [planApproval])

  // 将 autoApproveTools 同步到 ref，避免 handleEvent 闭包陈旧
  useEffect(() => {
    autoApproveRef.current = autoApproveTools
  }, [autoApproveTools])

  // 首次启动检测: 无任何 API Key 时自动进入配置向导
  useEffect(() => {
    loadSecrets(projectRoot).then((loaded) => {
      setSecrets(loaded)
      if (!hasAnyApiKey(loaded)) {
        setIsFirstRun(true)
        setShowConfig(true)
      }
    })
  }, [projectRoot])

  // 统一输入处理：所有交互式面板的输入均由 App 的 useInput 调度
  // 避免多个组件各自 useInput 导致的 Ink 输入冲突
  useInput((input, key) => {
    // Ctrl+C 退出
    if (key.ctrl && input === 'c') {
      exit()
      return
    }

    // 工具审批面板（ApprovalPrompt）
    const aprv = approvalRef.current
    if (aprv) {
      if (input === 'y' || key.return) {
        aprv.resolve(true)
        setApproval(null)
        delete (globalThis as Record<string, unknown>).__nexusApprovalResolve
        onApproval?.(aprv.resolve)
        return
      }
      if (input === 'n' || key.escape) {
        aprv.resolve(false)
        setApproval(null)
        delete (globalThis as Record<string, unknown>).__nexusApprovalResolve
        onApproval?.(aprv.resolve)
        return
      }
      if (input === 'a') {
        setAutoApproveTools((prev) => new Set([...prev, aprv.tool]))
        aprv.resolve(true)
        setApproval(null)
        delete (globalThis as Record<string, unknown>).__nexusApprovalResolve
        onApproval?.(aprv.resolve)
        return
      }
      return // 审批面板激活时，不处理其他按键
    }

    // 计划审批面板（PlanApprovalPanel）
    const pAprv = planApprovalRef.current
    if (pAprv) {
      if (key.return) {
        pAprv.resolve('approve')
        setPlanApproval(null)
        delete (globalThis as Record<string, unknown>).__nexusPlanApprovalResolve
        return
      }
      if (input === 'n' || input === 'N' || key.escape) {
        pAprv.resolve('reject')
        setPlanApproval(null)
        delete (globalThis as Record<string, unknown>).__nexusPlanApprovalResolve
        return
      }
      return // 计划审批激活时，不处理其他按键
    }

    // Todo 折叠切换（Shift+P）
    if ((input === 'P' || input === 'p') && key.shift) {
      setTodoExpanded((prev) => !prev)
      return
    }
    // 工具卡片全局展开/折叠（T 键）
    if (input === 'T' || input === 't') {
      setForceExpandTools((prev) => !prev)
      return
    }
  })

  const handleSubmit = useCallback(
    async (text: string) => {
      // 斜杠命令处理
      if (isSlashCommand(text)) {
        // /config 或 /api 打开配置面板
        if (text === '/config' || text === '/api') {
          setShowConfig(true)
          setIsFirstRun(false)
          return
        }
        // /model 或 /m（无参数）打开交互式模型选择器；带参数的 /model <name> 走原直接切换逻辑
        if (text === '/model' || text === '/m') {
          setShowModelSelector(true)
          return
        }
        const result = await handleSlashCommand(text, commandContext)
        if (result) {
          setMessages((prev) => [
            ...prev,
            { id: `sys-${msgIdRef.current++}`, role: 'system', content: result },
          ])
        }
        // 斜杠命令可能改变模型等状态，强制重渲染以更新状态栏
        setRenderTick((n) => n + 1)
        return
      }

      // 添加用户消息
      setMessages((prev) => [
        ...prev,
        { id: `user-${msgIdRef.current++}`, role: 'user', content: text },
      ])
      setBusy(true)
      setStreamingText('')
      onSubmit(text)
    },
    [onSubmit, commandContext],
  )

  /** 处理来自 Orchestrator 的事件 */
  const handleEvent = useCallback((event: NexusEvent) => {
    switch (event.type) {
      case 'llm_start':
        setPhase(event.phase === 'plan' ? 'planning' : 'executing')
        break

      case 'llm_chunk':
        setStreamingText((prev) => prev + event.text)
        break

      case 'llm_done':
        if (event.text) {
          setMessages((prev) => [
            ...prev,
            { id: `assistant-${msgIdRef.current++}`, role: 'assistant', content: event.text },
          ])
        }
        setStreamingText('')
        break

      case 'tool_call':
        setToolCalls((prev) => [
          ...prev,
          { callId: event.callId, tool: event.tool, params: event.params, status: 'running' },
        ])
        break

      case 'tool_approval_request': {
        // 优先用事件的 callId 从队列查找 resolve；回退到单槽 globalThis
        const callId = event.callId || `approval-${Date.now()}`
        const resolve = (globalThis as Record<string, unknown>).__nexusApprovalResolve as
          | ((approved: boolean) => void)
          | null
        if (resolve) {
          // 检查是否在自动批准白名单中（危险命令除外）
          const isDangerous =
            event.tool === 'bash' &&
            typeof event.params.command === 'string' &&
            requiresForcedApproval(event.params.command)
          if (autoApproveRef.current.has(event.tool) && !isDangerous) {
            resolve(true)
            delete (globalThis as Record<string, unknown>).__nexusApprovalResolve
            break
          }
          setApproval({
            callId,
            tool: event.tool,
            params: event.params,
            diff: event.diff,
            resolve,
          })
          setPhase('awaiting_approval')
        }
        break
      }

      case 'plan_approval_request': {
        const planResolve = (globalThis as Record<string, unknown>).__nexusPlanApprovalResolve as
          | ((result: 'approve' | 'reject' | string) => void)
          | null
        if (planResolve) {
          setPlanApproval({ plan: event.plan, resolve: planResolve })
          setPhase('awaiting_approval')
        }
        break
      }

      case 'tool_result':
        setToolCalls((prev) =>
          prev.map((tc) =>
            tc.callId === event.callId
              ? {
                  ...tc,
                  status: event.error ? 'error' : 'done',
                  result: event.result,
                  error: event.error,
                }
              : tc,
          ),
        )
        break

      case 'todo_update':
        setTodos(event.todos)
        break

      case 'phase_change':
        setPhase(event.phase)
        break

      case 'done':
        setBusy(false)
        setPhase('done')
        setStreamingText('') // 清除流式残留，防止重复显示
        if (event.summary) {
          setMessages((prev) => [
            ...prev,
            { id: `assistant-${msgIdRef.current++}`, role: 'assistant', content: event.summary },
          ])
        }
        break

      case 'error':
        setMessages((prev) => [
          ...prev,
          { id: `error-${msgIdRef.current++}`, role: 'system', content: `⚠️ ${event.message}` },
        ])
        if (!event.recoverable) setBusy(false)
        break

      case 'system_info':
        setMessages((prev) => [
          ...prev,
          { id: `info-${msgIdRef.current++}`, role: 'system', content: event.message },
        ])
        break
    }
  }, []) // autoApproveTools 通过 ref 访问，不需要作为依赖

  // 通过 eventBus 订阅来自 Orchestrator 的事件
  React.useEffect(() => {
    eventBus.on(handleEvent)
    return () => {
      eventBus.off(handleEvent)
    }
  }, [handleEvent])

  const phaseLabel = {
    idle: '就绪',
    planning: '规划中...',
    awaiting_approval: '等待审批',
    executing: '执行中...',
    verifying: '验证中...',
    done: '完成',
    error: '错误',
  }[phase]

  const hasUserMessages = messages.some((m) => m.role === 'user' || m.role === 'assistant')

  return (
    <Box flexDirection="column">
      {/* 顶部状态栏：模型名 · 模式 · 阶段 */}
      <Box paddingX={1}>
        <Text bold color={theme.colors.primary}>
          {commandContext.getModel()}
        </Text>
        <Text
          color={commandContext.getSkipPlan() ? theme.colors.accent : theme.colors.success}
          bold
        >
          {' '}
          [{commandContext.getSkipPlan() ? 'Auto' : 'Plan'}]
        </Text>
        <Text color={theme.colors.muted}> · {phaseLabel}</Text>
      </Box>

      {/* API 配置面板 */}
      {showConfig && (
        <Box paddingX={1}>
          <ApiConfigPanel
            secrets={secrets}
            isFirstRun={isFirstRun}
            onSave={async (newSecrets) => {
              await saveSecrets(projectRoot, newSecrets)
              setSecrets(newSecrets)
              // 通知 Orchestrator 重新初始化 providers
              eventBus.emit({ type: 'config_updated' })
            }}
            onClose={() => {
              setShowConfig(false)
              setIsFirstRun(false)
            }}
          />
        </Box>
      )}

      {/* 交互式模型选择器 */}
      {showModelSelector && (
        <Box paddingX={1}>
          <ModelSelector
            secrets={secrets}
            currentModel={commandContext.getModel()}
            onSelectModel={async (modelName) => {
              commandContext.setModel(modelName)
              await commandContext.saveLastModel(modelName)
              setRenderTick((n) => n + 1)
              setShowModelSelector(false)
            }}
            onSaveSecrets={async (newSecrets, selectModel) => {
              await saveSecrets(projectRoot, newSecrets)
              setSecrets(newSecrets)
              // 通知 Orchestrator 重新初始化 providers
              eventBus.emit({ type: 'config_updated' })
              // 等待 reinit 完成后再切换，避免被 applyConfigModels 覆盖
              await commandContext.reinitAndSelectModel(selectModel)
              setRenderTick((n) => n + 1)
            }}
            onDeleteSecrets={async (newSecrets) => {
              await saveSecrets(projectRoot, newSecrets)
              setSecrets(newSecrets)
              // 通知 Orchestrator 重新初始化 providers（删除当前模型时自动回退 auto）
              eventBus.emit({ type: 'config_updated' })
              await commandContext.reinitProviders()
              setRenderTick((n) => n + 1)
            }}
            onClose={() => {
              setShowModelSelector(false)
            }}
          />
        </Box>
      )}

      {/* 欢迎面板（无用户消息时） */}
      {!hasUserMessages && !streamingText && !showConfig && !showModelSelector && (
        <LogoBanner version="0.1.0" model={commandContext.getModel()} projectRoot={projectRoot} />
      )}

      {/* 主内容区 */}
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        <MessageList messages={messages} />

        {/* 流式输出 */}
        {streamingText && (
          <Box flexDirection="column" marginTop={messages.length > 0 ? 1 : 0}>
            <Text color={theme.colors.assistant} bold>
              {theme.symbols.assistant} Nexus
            </Text>
            <Box paddingLeft={2}>
              <Text>{streamingText}</Text>
            </Box>
          </Box>
        )}

        {/* 工具调用卡片 - 显示所有（含完成） */}
        {toolCalls.map((tc) => (
          <ToolCard
            key={tc.callId}
            tool={tc.tool}
            params={tc.params}
            status={tc.status}
            result={tc.result}
            error={tc.error}
            forceExpand={forceExpandTools}
          />
        ))}

        {/* Todo 进度 */}
        <TodoProgress todos={todos} expanded={todoExpanded} />

        {/* 审批提示 — 输入由 App useInput 统一处理 */}
        {approval && (
          <ApprovalPrompt
            tool={approval.tool}
            description={JSON.stringify(approval.params).slice(0, 100)}
            diff={approval.diff}
          />
        )}

        {/* 计划审批面板 — 输入由 App useInput 统一处理 */}
        {planApproval && <PlanApprovalPanel plan={planApproval.plan} />}
      </Box>

      {/* 底部分隔线 */}
      <Box paddingX={1}>
        <Text color={theme.colors.muted} dimColor>
          {'─'.repeat(60)}
        </Text>
      </Box>

      {/* 底部固定区域 */}
      <Box flexDirection="column" paddingX={1}>
        {/* 输入行 */}
        <InputBox
          onSubmit={handleSubmit}
          disabled={busy || !!approval || !!planApproval || showConfig || showModelSelector}
        />
        {/* 快捷键提示行 */}
        <Box>
          <Text color={theme.colors.muted} dimColor>
            [Ctrl+C 中断] [/ 命令] [Tab 补全]
          </Text>
        </Box>
      </Box>
    </Box>
  )
}

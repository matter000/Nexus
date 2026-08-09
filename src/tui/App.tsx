/**
 * Nexus TUI 根组件
 * 整合消息列表、工具卡片、审批、进度条、输入框
 * 布局风格参考 Claude Code CLI
 */

import { Box, Static, Text, useApp, useInput } from 'ink'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentPhase, NexusEvent, Plan, Todo } from '../agent/types'
import { type CommandContext, handleSlashCommand, isSlashCommand } from '../cli/commands'
import { hasAnyApiKey, loadSecrets, type SecretsConfig, saveSecrets } from '../config-secrets'
import { takePlanApprovalResolve, takeToolApprovalResolve } from '../core/approvalRegistry'
import { eventBus } from '../core/eventBus'
import { requiresForcedApproval } from '../sandbox/CommandGuard'
import { type AgentRun, AgentRunList } from './components/AgentRunList'
import { ApiConfigPanel } from './components/ApiConfigPanel'
import { ApprovalPrompt, formatApprovalParams } from './components/ApprovalPrompt'
import { InputBox } from './components/InputBox'
import { LoadingSpinner } from './components/LoadingSpinner'
import { LogoBanner } from './components/LogoBanner'
import { Markdown } from './components/Markdown'
import { type Message, MessageItem } from './components/MessageList'
import { ModelSelector } from './components/ModelSelector'
import { PlanApprovalPanel } from './components/PlanApprovalPanel'
import { TaskTimeline } from './components/TaskTimeline'
import type { ToolStatus } from './components/ToolCard'
import { theme } from './theme'

/** token 数紧凑格式化（状态栏上下文占用展示） */
function formatTokenCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n)
}

interface ToolCallDisplay {
  callId: string
  tool: string
  params: Record<string, unknown>
  status: ToolStatus
  result?: string
  error?: string
  /** 发起该调用的任务归属（按任务分组展示） */
  todoId?: string
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
  /** 子智能体执行状态（agent_start/agent_done 事件驱动，多智能体可见性） */
  const [agentRuns, setAgentRuns] = useState<AgentRun[]>([])
  /** 成本仪表盘渲染触发器：cost_update 时 +1，驱动状态栏命令式重读 getCost() */
  const [costTick, setCostTick] = useState(0)
  /** system_info 降噪：最新一条作为可变状态行展示，不逐条追加消息 */
  const [statusLine, setStatusLine] = useState<string | null>(null)
  /** 最近一次 LLM 调用的上下文占用（prompt token / 窗口），状态栏展示利用率 */
  const [ctxUsage, setCtxUsage] = useState<{ prompt: number; window: number } | null>(null)
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
  const [forceExpandTools, setForceExpandTools] = useState(false)
  const autoApproveRef = useRef<Set<string>>(new Set())
  const msgIdRef = useRef(0)
  /** 流式节流缓冲：llm_chunk 先入队，定时器批量 flush（防每 chunk 一次 setState 的高频重渲染） */
  const streamBufferRef = useRef('')
  const streamTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  /** Ctrl+C 中断状态：执行中首次按 Ctrl+C 中断操作，再按一次才退出 */
  const interruptRequestedRef = useRef(false)
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

  /** 流式 flush：把缓冲区内容追加到 streamingText 状态 */
  const flushStream = useCallback(() => {
    if (streamBufferRef.current) {
      const buf = streamBufferRef.current
      streamBufferRef.current = ''
      setStreamingText((prev) => prev + buf)
    }
  }, [])

  const stopStreamTimer = useCallback(() => {
    if (streamTimerRef.current) {
      clearInterval(streamTimerRef.current)
      streamTimerRef.current = null
    }
  }, [])

  // 组件卸载时清理流式定时器
  useEffect(() => stopStreamTimer, [stopStreamTimer])

  // 将 autoApproveTools 同步到 ref，避免 handleEvent 闭包陈旧
  useEffect(() => {
    autoApproveRef.current = autoApproveTools
  }, [autoApproveTools])

  // busy 解除时重置中断标记，下一轮任务重新支持单次 Ctrl+C 中断
  useEffect(() => {
    if (!busy) interruptRequestedRef.current = false
  }, [busy])

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
    // Ctrl+C：执行中先中断当前操作，再按一次才退出（避免挂起时无法自救）
    if (key.ctrl && input === 'c') {
      if (busy) {
        if (interruptRequestedRef.current) {
          exit()
          return
        }
        interruptRequestedRef.current = true
        commandContext.interrupt()
        setMessages((prev) => [
          ...prev,
          {
            id: `sys-${msgIdRef.current++}`,
            role: 'system',
            content: '⏹ 正在中断当前操作...（再次按 Ctrl+C 直接退出）',
          },
        ])
        return
      }
      exit()
      return
    }

    // 工具审批面板（ApprovalPrompt）
    const aprv = approvalRef.current
    if (aprv) {
      if (input === 'y' || key.return) {
        aprv.resolve(true)
        setApproval(null)
        onApproval?.(aprv.resolve)
        return
      }
      if (input === 'n' || key.escape) {
        aprv.resolve(false)
        setApproval(null)
        onApproval?.(aprv.resolve)
        return
      }
      if (input === 'a') {
        setAutoApproveTools((prev) => new Set([...prev, aprv.tool]))
        aprv.resolve(true)
        setApproval(null)
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
        return
      }
      if (input === 'n' || input === 'N' || key.escape) {
        pAprv.resolve('reject')
        setPlanApproval(null)
        return
      }
      return // 计划审批激活时，不处理其他按键
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
      // 新一轮任务开始：重置任务时间线、子智能体卡片与状态行
      setToolCalls([])
      setTodos([])
      setAgentRuns([])
      setStatusLine(null)
      onSubmit(text)
    },
    [onSubmit, commandContext],
  )

  /** 处理来自 Orchestrator 的事件 */
  const handleEvent = useCallback(
    (event: NexusEvent) => {
      switch (event.type) {
        case 'llm_start':
          setPhase(event.phase === 'plan' ? 'planning' : 'executing')
          // 每次 LLM 调用重置流式显示：避免跨阶段累积成巨型帧
          // （帧高超过终端时 Ink 会在滚动区重打整帧，表现为“输出多遍”）
          flushStream()
          stopStreamTimer()
          streamBufferRef.current = ''
          setStreamingText('')
          break

        case 'llm_chunk':
          // 流式节流：chunk 入缓冲，80ms 定时批量 flush（防每 chunk 一次 setState 的高频重渲染）
          streamBufferRef.current += event.text
          if (!streamTimerRef.current) {
            streamTimerRef.current = setInterval(() => {
              flushStream()
            }, 80)
          }
          break

        case 'llm_done':
          flushStream()
          stopStreamTimer()
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
            {
              callId: event.callId,
              tool: event.tool,
              params: event.params,
              status: 'running',
              todoId: event.todoId,
            },
          ])
          break

        case 'tool_approval_request': {
          // 通过 callId 从审批注册表取回 resolver
          const callId = event.callId
          const resolve = takeToolApprovalResolve(callId)
          if (resolve) {
            // 检查是否在自动批准白名单中（危险命令除外）
            const isDangerous =
              event.tool === 'bash' &&
              typeof event.params.command === 'string' &&
              requiresForcedApproval(event.params.command)
            if (autoApproveRef.current.has(event.tool) && !isDangerous) {
              resolve(true)
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
          const planResolve = takePlanApprovalResolve(event.callId)
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
                    todoId: tc.todoId ?? event.todoId,
                  }
                : tc,
            ),
          )
          break

        case 'todo_update':
          setTodos(event.todos)
          break

        case 'agent_start':
          // 多智能体可见性：子 Agent 引擎开始执行
          setAgentRuns((prev) => {
            const others = prev.filter((r) => r.taskId !== event.taskId)
            return [...others, { engine: event.engine, taskId: event.taskId, status: 'running' }]
          })
          break

        case 'agent_done':
          // 按 taskId 更新状态与摘要（含审查闭环的 -review/-fix 衍生任务）
          setAgentRuns((prev) =>
            prev.map((r) =>
              r.taskId === event.taskId
                ? {
                    ...r,
                    status: event.success ? 'done' : 'failed',
                    summary: event.summary,
                  }
                : r,
            ),
          )
          break

        case 'phase_change':
          setPhase(event.phase)
          break

        case 'cost_update':
          // 上下文利用率观测：记录最近一次调用的窗口占用
          if (event.promptTokens && event.windowTokens) {
            setCtxUsage({ prompt: event.promptTokens, window: event.windowTokens })
          }
          // 成本仪表盘：触发状态栏重读 getCost()（累计值命令式读取，需渲染触发器）
          setCostTick((n) => n + 1)
          break

        case 'done':
          flushStream()
          stopStreamTimer()
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
          flushStream()
          stopStreamTimer()
          setMessages((prev) => [
            ...prev,
            { id: `error-${msgIdRef.current++}`, role: 'system', content: `⚠️ ${event.message}` },
          ])
          // 错误即表示本次操作已终止（含超时/中断），必须解除 busy 锁，
          // 否则输入框会永久卡在“执行中，无法输入”状态
          setBusy(false)
          setStreamingText('')
          break

        case 'system_info':
          // 降噪：过程性信息（压实/重试/检查点等）收敛为单行可变状态行，
          // 最新一条覆盖展示，不再逐条追加消息刷屏；错误仍由 error 事件留痕
          setStatusLine(event.message)
          break
      }
    },
    [flushStream, stopStreamTimer],
  )

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

  const phaseColor = {
    idle: theme.colors.success,
    planning: theme.colors.primary,
    awaiting_approval: theme.colors.warning,
    executing: theme.colors.primary,
    verifying: theme.colors.primary,
    done: theme.colors.success,
    error: theme.colors.error,
  }[phase]

  const hasUserMessages = messages.some((m) => m.role === 'user' || m.role === 'assistant')

  // 成本仪表盘：会话累计成本/token/缓存命中率（costTick 驱动重读；数据源 CostTracker，展示层零成本）
  const cost = commandContext.getCost()
  const costStr = cost.total > 0 && cost.total < 0.001 ? '<$0.001' : `$${cost.total.toFixed(3)}`
  const cacheRate = cost.cacheHitRate
  const cacheColor =
    cacheRate === undefined
      ? theme.colors.muted
      : cacheRate >= 0.5
        ? theme.colors.success
        : cacheRate >= 0.2
          ? theme.colors.warning
          : theme.colors.muted
  const todosDone = todos.filter((t) => t.status === 'complete').length

  // 欢迎态：无对话内容且无面板覆盖时，展示居中欢迎屏
  const showWelcome = !hasUserMessages && !streamingText && !showConfig && !showModelSelector

  return (
    <Box flexDirection="column">
      {/* 顶部状态栏：模型名 · 模式 · 阶段 · 上下文占用 · 成本仪表盘 */}
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
        <Text color={phaseColor}> ● {phaseLabel}</Text>
        {ctxUsage && (
          <Text
            color={
              ctxUsage.prompt / ctxUsage.window >= 0.8
                ? theme.colors.error
                : ctxUsage.prompt / ctxUsage.window >= 0.6
                  ? theme.colors.warning
                  : theme.colors.success
            }
          >
            {` · ctx ${formatTokenCount(ctxUsage.prompt)}/${formatTokenCount(ctxUsage.window)} (${Math.round((ctxUsage.prompt / ctxUsage.window) * 100)}%)`}
          </Text>
        )}
        {/* 成本仪表盘：会话累计费用 / token / 缓存命中率（前缀缓存收益可见） */}
        {cost.total > 0 && (
          <Text
            color={theme.colors.muted}
          >{` · ${costStr} · in ${formatTokenCount(cost.inputTokens)}/out ${formatTokenCount(cost.outputTokens)}`}</Text>
        )}
        {cacheRate !== undefined && cost.total > 0 && (
          <Text color={cacheColor}>{` · cache ${Math.round(cacheRate * 100)}%`}</Text>
        )}
        {todos.length > 0 && (
          <Text color={theme.colors.muted}>{` · todo ${todosDone}/${todos.length}`}</Text>
        )}
      </Box>

      {/* API 配置面板 */}
      {showConfig && (
        <Box paddingX={1}>
          <ApiConfigPanel
            secrets={secrets}
            isFirstRun={isFirstRun}
            onSave={async (newSecrets) => {
              await saveSecrets(newSecrets)
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
              await saveSecrets(newSecrets)
              setSecrets(newSecrets)
              // 通知 Orchestrator 重新初始化 providers
              eventBus.emit({ type: 'config_updated' })
              // 等待 reinit 完成后再切换，避免被 applyConfigModels 覆盖
              await commandContext.reinitAndSelectModel(selectModel)
              setRenderTick((n) => n + 1)
            }}
            onDeleteSecrets={async (newSecrets) => {
              await saveSecrets(newSecrets)
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
      {showWelcome && (
        <LogoBanner version="0.1.0" model={commandContext.getModel()} projectRoot={projectRoot} />
      )}

      {/* 已定稿消息：Ink <Static> 沉降区——渲染一次后进入终端滚动历史，
          不再参与动态帧重布局（长会话防闪烁/防全量重排的核心手段） */}
      <Static items={messages}>
        {(msg, i) => (
          <Box key={msg.id} flexDirection="column" marginTop={i > 0 ? 1 : 0} paddingX={1}>
            <MessageItem message={msg} />
          </Box>
        )}
      </Static>

      {/* 动态区：任务时间线 + 子智能体卡片 + 流式输出 + 审批（帧高有界，避免整屏重绘） */}
      <Box
        flexDirection="column"
        flexGrow={1}
        paddingX={1}
        alignItems={showWelcome ? 'center' : 'flex-start'}
      >
        {/* 任务分组时间线：每个任务下列出它的工具调用与产出文件 */}
        <TaskTimeline todos={todos} toolCalls={toolCalls} forceExpandTools={forceExpandTools} />

        {/* 子智能体执行卡片（多智能体协作可见性） */}
        <AgentRunList runs={agentRuns} />

        {/* 流式输出（Markdown 渲染，与定稿消息一致；已 80ms 节流批渲染） */}
        {streamingText && (
          <Box flexDirection="column" marginTop={messages.length > 0 ? 1 : 0}>
            <Text color={theme.colors.assistant} bold>
              {theme.symbols.assistant} Nexus
            </Text>
            <Box paddingLeft={2}>
              <Markdown content={streamingText} />
            </Box>
          </Box>
        )}

        {/* LLM 加载动画: 无流式输出且处于活跃阶段时显示 */}
        {(phase === 'planning' || phase === 'executing' || phase === 'verifying') &&
          !streamingText && <LoadingSpinner phase={phase} />}

        {/* system_info 状态行：过程性信息（压实/重试/检查点等）收敛为单行可变展示，不逐条刷屏 */}
        {statusLine && (
          <Box>
            <Text color={theme.colors.muted} dimColor>
              ⚙ {statusLine}
            </Text>
          </Box>
        )}

        {/* 审批提示 — 输入由 App useInput 统一处理 */}
        {approval && (
          <ApprovalPrompt
            tool={approval.tool}
            description={formatApprovalParams(approval.tool, approval.params)}
            diff={approval.diff}
          />
        )}

        {/* 计划审批面板 — 输入由 App useInput 统一处理 */}
        {planApproval && <PlanApprovalPanel plan={planApproval.plan} />}
      </Box>

      {/* 底部分隔线（欢迎态居中） */}
      <Box paddingX={1} alignItems={showWelcome ? 'center' : 'flex-start'}>
        <Text color={theme.colors.muted} dimColor>
          {'─'.repeat(60)}
        </Text>
      </Box>

      {/* 底部固定区域（欢迎态居中，对话态左对齐） */}
      <Box flexDirection="column" paddingX={1} alignItems={showWelcome ? 'center' : 'flex-start'}>
        {/* 输入行 */}
        <InputBox
          onSubmit={handleSubmit}
          disabled={busy || !!approval || !!planApproval || showConfig || showModelSelector}
        />
        {/* 快捷键提示行 */}
        <Box>
          <Text color={theme.colors.muted} dimColor>
            [Ctrl+C 中断] [/ 命令] [Tab 补全] [↑ 历史] [T 工具展开] [Alt+Enter 换行]
          </Text>
        </Box>
      </Box>
    </Box>
  )
}

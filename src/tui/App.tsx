/**
 * Nexus TUI 根组件
 * 整合消息列表、工具卡片、审批、进度条、输入框
 */

import React, { useState, useCallback, useRef, useEffect } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import { MessageList, type Message } from './components/MessageList'
import { ToolCard, type ToolStatus } from './components/ToolCard'
import { ApprovalPrompt } from './components/ApprovalPrompt'
import { TodoProgress } from './components/TodoProgress'
import { InputBox } from './components/InputBox'
import { ApiConfigPanel } from './components/ApiConfigPanel'
import { theme } from './theme'
import type { NexusEvent, Todo, AgentPhase } from '../agent/types'
import { isSlashCommand, handleSlashCommand, type CommandContext } from '../cli/commands'
import { loadSecrets, saveSecrets, hasAnyApiKey, type SecretsConfig } from '../config-secrets'

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
  model: string
  cost: string
  projectRoot: string
}

export function App({ onSubmit, commandContext, model, cost, projectRoot }: AppProps) {
  const { exit } = useApp()
  const [messages, setMessages] = useState<Message[]>([])
  const [toolCalls, setToolCalls] = useState<ToolCallDisplay[]>([])
  const [todos, setTodos] = useState<Todo[]>([])
  const [phase, setPhase] = useState<AgentPhase>('idle')
  const [streamingText, setStreamingText] = useState('')
  const [approval, setApproval] = useState<ApprovalState | null>(null)
  const [busy, setBusy] = useState(false)
  const [showConfig, setShowConfig] = useState(false)
  const [isFirstRun, setIsFirstRun] = useState(false)
  const [secrets, setSecrets] = useState<SecretsConfig>({ providers: {} })
  const msgIdRef = useRef(0)

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

  // Ctrl+C 退出
  useInput((_input, key) => {
    if (key.ctrl && _input === 'c') {
      exit()
    }
  })

  const handleSubmit = useCallback(async (text: string) => {
    // 斜杠命令处理
    if (isSlashCommand(text)) {
      // /config 或 /api 打开配置面板
      if (text === '/config' || text === '/api') {
        setShowConfig(true)
        setIsFirstRun(false)
        return
      }
      const result = await handleSlashCommand(text, commandContext)
      if (result) {
        setMessages((prev) => [
          ...prev,
          { id: `sys-${msgIdRef.current++}`, role: 'system', content: result },
        ])
      }
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
  }, [onSubmit, commandContext])

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

      case 'tool_approval_request':
        // 由外部处理
        break

      case 'tool_result':
        setToolCalls((prev) =>
          prev.map((tc) =>
            tc.callId === event.callId
              ? { ...tc, status: event.error ? 'error' : 'done', result: event.result, error: event.error }
              : tc
          )
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
    }
  }, [])

  // 将 handleEvent 暴露给外部(通过 ref 或 context)
  // 这里简化:通过全局事件总线
  React.useEffect(() => {
    ;(globalThis as Record<string, unknown>).__nexusEventHandler = handleEvent
    return () => { delete (globalThis as Record<string, unknown>).__nexusEventHandler }
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

  return (
    <Box flexDirection="column" padding={1}>
      {/* 顶栏 */}
      <Box justifyContent="space-between" borderBottom>
        <Text bold color={theme.colors.primary}>─ Nexus ─</Text>
        <Text color={theme.colors.muted}>{model} · {cost}</Text>
      </Box>

      {/* API 配置面板 */}
      {showConfig && (
        <Box marginTop={1}>
          <ApiConfigPanel
            secrets={secrets}
            isFirstRun={isFirstRun}
            onSave={async (newSecrets) => {
              await saveSecrets(projectRoot, newSecrets)
              setSecrets(newSecrets)
            }}
            onClose={() => {
              setShowConfig(false)
              setIsFirstRun(false)
            }}
          />
        </Box>
      )}

      {/* 消息区域 */}
      <Box flexDirection="column" marginTop={1} flexGrow={1}>
        <MessageList messages={messages} />

        {/* 流式输出 */}
        {streamingText && (
          <Box flexDirection="column">
            <Text color={theme.colors.assistant} bold>
              {theme.symbols.assistant} Nexus (思考中...)
            </Text>
            <Text>{streamingText}</Text>
          </Box>
        )}

        {/* 工具调用卡片 */}
        {toolCalls.filter((tc) => tc.status !== 'done').map((tc) => (
          <ToolCard
            key={tc.callId}
            tool={tc.tool}
            params={tc.params}
            status={tc.status}
            result={tc.result}
            error={tc.error}
          />
        ))}

        {/* Todo 进度 */}
        <TodoProgress todos={todos} />

        {/* 审批提示 */}
        {approval && (
          <ApprovalPrompt
            tool={approval.tool}
            description={JSON.stringify(approval.params).slice(0, 100)}
            diff={approval.diff}
            onApprove={() => { approval.resolve(true); setApproval(null) }}
            onReject={() => { approval.resolve(false); setApproval(null) }}
          />
        )}
      </Box>

      {/* 状态栏 + 输入框 */}
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.colors.muted} dimColor>
          状态: {phaseLabel}
        </Text>
        <InputBox onSubmit={handleSubmit} disabled={busy || !!approval} />
      </Box>
    </Box>
  )
}

/** 全局事件分发(简化版,生产环境应使用 EventEmitter) */
export function emitToUI(event: NexusEvent): void {
  const handler = (globalThis as Record<string, unknown>).__nexusEventHandler as
    ((event: NexusEvent) => void) | undefined
  handler?.(event)
}

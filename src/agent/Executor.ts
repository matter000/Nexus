/**
 * Execute 阶段
 * ReAct Loop 核心:逐步执行计划,每步可回滚
 */

import type { LanguageModel } from 'ai'
import { generateText, stepCountIs } from 'ai'
import { spawn } from 'child_process'
import type { Dirent } from 'fs'
import { readdir, readFile } from 'fs/promises'
import { basename, join, resolve } from 'path'
import {
  compactionLevel,
  emergencyCompactMessages,
  microCompactMessages,
} from '../context/Compactor'
import type { CostTracker } from '../router/CostTracker'
import { withDeepSeekThinking } from '../router/providers/deepseekFetch'
import type { CheckpointManager } from '../sandbox/Checkpoint'
import { requiresForcedApproval } from '../sandbox/CommandGuard'
import { generateDiff } from '../tools/editFile'
import type { ToolContext, ToolRegistry } from '../tools/registry'
import { resolveToolParameters } from '../tools/schemas'
import { callWithRetry } from '../utils'
import {
  type EvidenceConfig,
  EvidenceGate,
  type EvidenceSet,
  formatEvidenceSummary,
} from './EvidenceGate'
import {
  callLLMWithRetry,
  type LLMCallConfig,
  normalizeMessagesForSDK,
  splitModelParameters,
} from './ReActLoop'
import type {
  ChatMessage,
  ExecMessage,
  LoopTraceRound,
  ModelRole,
  NexusEvent,
  PermissionMode,
  Plan,
  Todo,
} from './types'

const EXECUTE_SYSTEM_SUFFIX = `
## 当前阶段: Execute (执行)

你正在执行阶段。按照批准的计划逐步执行:
1. 每次只做一个步骤
2. 使用 edit_file 精准修改(确保 old_string 唯一匹配)
3. 修改后用 bash 运行测试验证
4. 完成所有步骤后输出总结

## 重要规则
- edit_file 的 old_string 必须包含足够上下文确保唯一匹配
- 如果 edit 失败(未找到/不唯一),先 read_file 获取最新内容再重试
- 每完成一个步骤,必须调用 update_todo(action="complete", id="...") 标记该步骤完成
- 遇到无法解决的问题,诚实说明而不是强行修改
- bash 命令的运行目录是项目根目录，不要 cd 到别处；优先使用项目自身约定的测试/构建命令（如 rules 中声明的）
- 总结中不要输出“产出文件/变更文件/修改的文件”等聚合文件清单：界面已把每个文件产物展示在对应任务下方，重复罗列只会干扰阅读

## Auto 模式（无预设 todo 时）
- 如无预设 todo,请先用 update_todo(action="add", content="...") 拆解任务为 2-5 个步骤,再逐步执行
- 每完成一个步骤后调用 update_todo(action="complete") 标记完成

## 任务笔记（长任务必用）
- 预计超过 10 步的任务：每完成一个里程碑就用 update_notes(action="append") 记录关键决策、已改文件与下一步计划
- 当你感觉上下文被压缩、丢失了之前的细节时，先 update_notes(action="read") 回读笔记再继续`

/** 工具审批结果：boolean 兼容（true/false），或带拒绝原因的决策对象 */
export type ToolApprovalDecision = boolean | { approved: boolean; reason?: string }

/** 将审批结果归一化为决策对象 */
export function normalizeApprovalDecision(d: ToolApprovalDecision): {
  approved: boolean
  reason?: string
} {
  return typeof d === 'boolean' ? { approved: d } : d
}

export interface ExecutorConfig {
  model: LanguageModel
  toolRegistry: ToolRegistry
  toolContext: ToolContext
  checkpoint: CheckpointManager
  maxIterations: number
  permissionMode: PermissionMode
  onEvent: (event: NexusEvent) => void
  /** 审批回调:返回 true=批准, false=拒绝；可返回带 reason 的决策对象 */
  requestApproval: (
    tool: string,
    params: Record<string, unknown>,
    diff?: string,
  ) => Promise<ToolApprovalDecision>
  /** 成本追踪器 */
  costTracker: CostTracker
  /** 验证阶段模型（verifier 角色）；未提供时回退主模型 */
  verifyModel?: LanguageModel
  /** 验证阶段的 provider 模型参数（与主 modelParameters 同结构） */
  verifyModelParameters?: Record<string, unknown>
  /** 验证阶段成本记录参数（verifier 定价）；未提供时沿用主模型参数 */
  verifyCost?: {
    providerName: string
    modelName: string
    costPer1kInput: number
    costPer1kOutput: number
    costPer1kInputCached?: number
  }
  /** 当前模型角色（用于成本记录） */
  modelRole: ModelRole
  /** 当前 provider 名称（用于成本记录，内置为 ProviderName，自定义为任意键名） */
  providerName: string
  /** 当前模型名称（用于成本记录） */
  modelName: string
  /** 输入 token 单价（每 1k） */
  costPer1kInput: number
  /** 输出 token 单价（每 1k） */
  costPer1kOutput: number
  /** 缓存命中输入单价（每 1k），DeepSeek 分级计费用 */
  costPer1kInputCached?: number
  /** 会话成本上限 */
  maxSessionCost: number
  /** 获取降级模型（主模型全部重试失败后使用） */
  getFallbackModel?: () => LanguageModel | null
  /** 降级模型名称（用于事件通知） */
  fallbackModelName?: string
  /** 中断信号（Orchestrator.abort() 时触发） */
  abortSignal?: AbortSignal
  /**
   * Provider 特定的模型参数
   * 由 ProviderAdapter.getModelParameters() 生成，用于优化 DeepSeek 等模型的调用参数
   */
  modelParameters?: Record<string, unknown>
  /** executor 模型的上下文窗口大小（token），用于自适应压实水位计算 */
  contextWindow?: number
  /** 压实策略（未配置时不做循环内压实） */
  compaction?: {
    compactionThreshold: number
    emergencyThreshold: number
    keepRecentResultsFull: number
  }
  /** 紧急压实用的摘要模型（summarizer 角色）；未提供时高水位降级为微压实 */
  compactModel?: LanguageModel
  /**
   * 步级测试驱动闭环：edit 后自动跑受影响测试，失败喂回 LLM。
   * 仅当项目 testCommand 形如 bun test 时由 Orchestrator 注入，其他框架保守跳过。
   */
  autoTest?: { runner: 'bun'; baseCommand: string }
  /**
   * Loop Engineering 证据门禁：完成时运行确定性检查（lint/typecheck/test），
   * 结果注入验证提示词与修复循环（手册铁律：基于证据循环，非置信度）。
   * 未提供时跳过全部门禁（退化现有行为）。
   */
  evidence?: EvidenceConfig
}

/**
 * 简单的 Promise 信号量，限制并发数
 */
class Semaphore {
  private queue: Array<() => void> = []
  private active = 0
  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++
      return
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active++
        resolve()
      })
    })
  }

  release(): void {
    this.active--
    const next = this.queue.shift()
    if (next) next()
  }
}

/** 验证失败项（todoId + 缺失说明 + 关联确定性证据） */
export interface VerifyFailure {
  todoId: string
  detail: string
  /** 关联的证据门禁失败（如 "test: exit 1"）；确定性失败由门禁直通，无需 verifier 复述 */
  evidence?: string
}

/** 验证阶段的结构化结论 */
export interface VerifyOutcome {
  pass: boolean
  failures: VerifyFailure[]
}

/**
 * 解析验证输出末尾的 ```json 结论块。
 * 解析失败返回 null（由调用方保守按通过处理，避免模糊信号误触发修复循环）。
 */
function parseVerifyVerdict(text: string): VerifyOutcome | null {
  const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)\n```/g)]
  // 从最后一个 JSON 块向前找，结论块约定在输出末尾
  for (let i = blocks.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(blocks[i][1]) as {
        pass?: boolean
        failures?: Array<{ todoId?: string; detail?: string }>
      }
      if (typeof parsed.pass === 'boolean') {
        if (parsed.pass) return { pass: true, failures: [] }
        const failures = Array.isArray(parsed.failures)
          ? parsed.failures
              .filter(
                (f): f is { todoId?: string; detail: string; evidence?: string } =>
                  !!f && typeof f.detail === 'string',
              )
              .map((f) => ({
                todoId: f.todoId ?? '',
                detail: f.detail,
                evidence: typeof f.evidence === 'string' ? f.evidence : undefined,
              }))
          : []
        return { pass: false, failures }
      }
    } catch {
      // 非结论块（如计划 JSON），继续向前找
    }
  }
  return null
}

/**
 * 剥离总结文本中聚合式的“产出文件”区块（从匹配标题到下一个同级/更高级标题或文末）。
 * 文件产物已由 TUI 按任务归属展示，模型在末尾重复罗列只会把产物堆在底部。
 * 提示词已约束模型不输出此类区块，此处为兜底（不匹配的文本原样保留）。
 */
export function stripArtifactSection(text: string): string {
  const ARTIFACT_HEADING = /^#{1,6}\s+.*(产出文件|变更文件|修改的文件|生成的文件|文件清单)/
  const lines = text.split('\n')
  const result: string[] = []
  let skipping = false
  let skipLevel = 0
  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s/)
    if (skipping) {
      // 遇到同级或更高级标题时结束剥离（该标题本身保留）
      if (headingMatch && headingMatch[1].length <= skipLevel) {
        skipping = false
      } else {
        continue
      }
    }
    if (ARTIFACT_HEADING.test(line)) {
      skipping = true
      skipLevel = (line.match(/^(#{1,6})\s/) as RegExpMatchArray)[1].length
      continue
    }
    result.push(line)
  }
  return result.join('\n').replace(/\s+$/, '')
}

export class Executor {
  private config: ExecutorConfig
  private todos: Todo[] = []
  private iterations = 0
  /** bash 并发信号量，上限 3 */
  private bashSemaphore = new Semaphore(3)
  /** 必须串行执行的工具 */
  private static readonly SERIAL_TOOLS = new Set(['edit_file', 'update_tool'])
  /** 同一文件的 edit_file 连续失败计数（key: 文件路径, value: 连续失败次数） */
  private consecutiveEditFailures = new Map<string, number>()
  /** 自上次 todo 状态变更以来的工具调用数（检测 agent 是否陷入循环） */
  private stepsSinceProgress = 0
  /** 已发出的 stuck 警告次数（最多 2 次，避免刷屏） */
  private stuckWarnings = 0
  /** 是否执行过 edit_file（仅在有代码变更时运行验证） */
  private hasCodeChanges = false
  private lastError: string | null = null
  /** 验证阶段的结构化结论（未运行验证时为 null） */
  private verifyOutcome: VerifyOutcome | null = null
  /** 证据门禁结果（未运行/无证据配置时为 null） */
  private evidenceResult: EvidenceSet | null = null
  /** 步级自动测试：本次 execute 已跑过测试的文件（同文件去重，防反复触发） */
  private autoTestedFiles = new Set<string>()
  /** 步级自动测试累计次数（上限护栏，防修复循环烧钱） */
  private autoTestCount = 0
  /** 自动测试超限提示只发一次 */
  private autoTestLimitNotified = false

  constructor(config: ExecutorConfig) {
    this.config = config
  }

  /** 执行计划 */
  async execute(plan: Plan, contextMessages: ChatMessage[]): Promise<string> {
    const { model, toolRegistry, toolContext, maxIterations, onEvent } = this.config

    this.todos = [...plan.todos]
    this.iterations = 0
    this.hasCodeChanges = false
    this.verifyOutcome = null
    this.evidenceResult = null
    this.consecutiveEditFailures.clear()
    this.stuckWarnings = 0
    this.stepsSinceProgress = 0
    // 步级自动测试状态重置（每次 execute 独立计数）
    this.autoTestedFiles.clear()
    this.autoTestCount = 0
    this.autoTestLimitNotified = false

    onEvent({ type: 'llm_start', phase: 'execute' })
    onEvent({ type: 'todo_update', todos: this.todos })

    // Execute 阶段用全部工具
    const execTools = toolRegistry.getForPhase('execute')
    const toolsForAI: Record<string, { description: string; parameters: unknown }> = {}
    for (const tool of execTools) {
      toolsForAI[tool.definition.name] = {
        description: tool.definition.description,
        parameters: resolveToolParameters(tool.definition.name, tool.definition.inputSchema),
      }
    }

    // 构建初始消息
    const planSummary = `## 已批准的计划\n${plan.summary}\n\n步骤:\n${plan.todos.map((t, i) => `${i + 1}. ${t.content}`).join('\n')}`

    const messages: ExecMessage[] = [
      ...contextMessages.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      { role: 'user', content: planSummary },
    ]

    let finalText = ''
    let executionError = false

    // ReAct Loop
    while (this.iterations < maxIterations) {
      // 检查中断信号
      if (this.config.abortSignal?.aborted) {
        finalText = '执行已被中断。'
        executionError = true
        break
      }
      this.iterations++

      // 使用共享的 LLM 调用工具（统一 streamText + 重试 + 成本记录），支持降级模型
      // DeepSeek 思考模式返回 reasoning（思维链），需在后续轮次中回传（有工具调用时）
      let callResult: {
        streamedText: string
        usage?: { promptTokens: number; completionTokens: number }
        toolCalls: Array<{ toolName: string; args: Record<string, unknown> }>
        reasoning?: string
        cacheHitTokens?: number
        cacheMissTokens?: number
        reasoningTokens?: number
      }
      try {
        callResult = await callLLMWithRetry(
          {
            model,
            system: EXECUTE_SYSTEM_SUFFIX,
            messages,
            tools: toolsForAI,
            maxSteps: 1,
            abortSignal: this.config.abortSignal,
            modelParameters: this.config.modelParameters,
          },
          {
            onEvent,
            costConfig: {
              costTracker: this.config.costTracker,
              modelRole: this.config.modelRole,
              providerName: this.config.providerName,
              modelName: this.config.modelName,
              costPer1kInput: this.config.costPer1kInput,
              costPer1kOutput: this.config.costPer1kOutput,
              costPer1kInputCached: this.config.costPer1kInputCached,
              contextWindow: this.config.contextWindow,
            },
          },
          this.config.getFallbackModel?.() ?? undefined,
        )
      } catch (err) {
        const msg = (err as Error).message
        // 主模型 + 备用模型均不可用
        if (msg.includes('主模型和备用模型均不可用')) {
          finalText = `LLM 调用失败：${msg}`
          onEvent({ type: 'error', message: '所有模型均不可用', recoverable: false })
          break
        }
        finalText = `LLM 调用失败且无可用降级模型: ${msg}`
        onEvent({ type: 'error', message: 'LLM 调用失败', recoverable: false })
        executionError = true
        break
      }

      const { streamedText, toolCalls, reasoning } = callResult

      // 检查成本上限
      if (this.config.costTracker.isOverBudget(this.config.maxSessionCost)) {
        finalText = `会话成本已超过上限 ($${this.config.maxSessionCost})。当前花费: ${this.config.costTracker.getSummary()}`
        onEvent({ type: 'error', message: '成本超限', recoverable: false })
        executionError = true
        break
      }

      // 无工具调用 → 执行完成
      if (!toolCalls || toolCalls.length === 0) {
        finalText = streamedText
        break
      }

      // 有工具调用（文本已在流式过程中通过 llm_chunk 发送）
      // 保存 LLM 的叙述文本，防止达到迭代上限时 finalText 为空
      finalText = streamedText || finalText

      // 自适应压实：下一轮 LLM 调用前，按当前窗口占用分档压实
      // （窗口充裕时全量保留，最大化上下文利用率）
      if (callResult.usage && this.config.contextWindow && this.config.compaction) {
        await this.applyCompaction(messages, callResult.usage.promptTokens)
      }

      // 构建 assistant 消息（包含工具调用信息，让 LLM 知道“我调用了哪些工具”）
      const assistantMsg: ExecMessage = {
        role: 'assistant',
        content: streamedText || '',
        reasoning, // 包含 reasoning_content，有工具调用时必须在后续轮次回传
        toolCalls: toolCalls.map((tc, idx) => ({
          toolCallId: `exec-${this.iterations}-${tc.toolName}-${idx}`,
          toolName: tc.toolName,
          args: tc.args,
        })),
      }
      messages.push(assistantMsg)

      // 分离串行和并行工具调用
      const serialCalls = toolCalls.filter((tc) => Executor.SERIAL_TOOLS.has(tc.toolName))
      const parallelCalls = toolCalls.filter((tc) => !Executor.SERIAL_TOOLS.has(tc.toolName))

      // 收集所有工具结果，最后统一推入 tool 消息
      const toolResults: Array<{ toolCallId: string; toolName: string; result: string }> = []

      // 并行执行只读/非串行工具
      if (parallelCalls.length > 0) {
        const parallelSettled = await Promise.allSettled(
          parallelCalls.map((tc, idx) =>
            this.executeSingleToolCall(tc, messages, toolResults, idx),
          ),
        )
        for (let i = 0; i < parallelSettled.length; i++) {
          const r = parallelSettled[i]
          if (r.status === 'rejected') {
            onEvent({
              type: 'error',
              message: `并行工具 ${parallelCalls[i].toolName} 执行异常: ${r.reason}`,
              recoverable: true,
            })
          }
        }
      }

      // 串行执行写工具（edit_file / update_todo）
      for (let idx = 0; idx < serialCalls.length; idx++) {
        await this.executeSingleToolCall(
          serialCalls[idx],
          messages,
          toolResults,
          parallelCalls.length + idx,
        )
      }

      // 将所有工具结果作为一条 tool 消息推入（AI SDK 原生格式）
      if (toolResults.length > 0) {
        messages.push({
          role: 'tool',
          content: toolResults.map((tr) => ({
            type: 'tool-result' as const,
            toolCallId: tr.toolCallId,
            toolName: tr.toolName,
            result: tr.result,
          })),
        })
      }

      // 检测 agent 是否陷入循环：连续 8 步无 progress 时提示（最多 2 次）
      if (this.stepsSinceProgress >= 8 && this.stuckWarnings < 2) {
        this.stuckWarnings++
        onEvent({
          type: 'system_info',
          message: `已执行 ${this.stepsSinceProgress} 步但无 todo 进展，agent 可能在循环中。如果看起来卡住了，可以按 Ctrl+C 中断。`,
        })
        // 纠偏 nudge 注入 LLM 消息流：只提示 UI 时模型无感知，会继续重复相同操作。
        // 以 user 消息喂回当前 todo 状态与改道指令，让模型自行纠偏（Claude Code nudge 模式）
        messages.push({
          role: 'user',
          content: `[系统提示·循环检测] 你已连续 ${this.stepsSinceProgress} 步工具调用但 todo 无任何进展，很可能在重复相同的无效操作。请立即停止当前做法：\n1. 回顾当前 todo 状态：\n${this.formatTodos()}\n2. 换一种方法（如重新 read_file 确认现状、缩小改动范围、或拆解步骤）\n3. 若确实无法推进，诚实说明阻塞原因并结束，不要继续空转`,
        })
        this.stepsSinceProgress = 0
      }
    }

    // 达到迭代上限
    if (this.iterations >= maxIterations) {
      finalText = `已达到最大迭代次数 (${maxIterations})。当前进度:\n${this.formatTodos()}`
      onEvent({ type: 'error', message: '达到迭代上限', recoverable: true })
      executionError = true
    }

    // 不强制把未完成 todo 标记为 complete：todo 状态是学习系统 outcome 判定的信号源，
    // 篡改状态会让 determineOutcome 永远返回 success（LLM 忘调 update_todo 与任务真完成无法区分）。
    // 纯查询任务无预设 todo 的情况由 Orchestrator.determineOutcome 单独识别。
    if (executionError) {
      this.lastError = finalText || '执行过程中出现未知错误'
    }

    onEvent({ type: 'todo_update', todos: this.todos })

    // ─── 证据门禁 + 验证阶段 ───
    // 仅在正常完成且有代码修改时运行（纯查询/对话跳过）
    if (!executionError && this.hasCodeChanges) {
      onEvent({ type: 'phase_change', phase: 'verifying' })
      // Loop Engineering 证据门禁：确定性检查（lint/typecheck/test）先行，
      // 结果作为 verifier 与修复循环的证据（手册铁律：不基于置信度循环，基于证据循环）
      const evidence = await this.runEvidenceGate()
      this.evidenceResult = evidence
      const verify = await this.runVerification(plan, finalText, messages, toolsForAI, evidence)
      this.verifyOutcome = verify.outcome
      if (verify.report) {
        finalText = finalText
          ? `${finalText}\n\n## 验证\n${verify.report}`
          : `## 验证\n${verify.report}`
      }
      if (!verify.outcome.pass) {
        onEvent({
          type: 'system_info',
          message: `验证发现 ${verify.outcome.failures.length} 项未真正完成，交由编排层决定是否自动修复`,
        })
      }
    }

    return stripArtifactSection(finalText)
  }

  /**
   * 执行后验证：mini ReAct loop，每步可执行工具（read_file/grep/bash）
   * 最多 5 步，每步的工具调用对用户可见。
   * 返回结构化结论（pass/failures）+ 人类可读报告；验证 LLM 调用按 verifier 角色计费。
   * @param evidence 证据门禁结果（确定性检查先行）；未配置时为空集合
   */
  private async runVerification(
    plan: Plan,
    executionResult: string,
    messages: Array<
      | { role: 'user' | 'assistant'; content: string }
      | {
          role: 'assistant'
          content: string
          toolCalls: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>
        }
      | {
          role: 'tool'
          content: Array<{
            type: 'tool-result'
            toolCallId: string
            toolName: string
            result: string
          }>
        }
    >,
    _toolsForAI: Record<string, { description: string; parameters: unknown }>,
    evidence: EvidenceSet,
  ): Promise<{ outcome: VerifyOutcome; report: string }> {
    const { toolRegistry, toolContext, onEvent } = this.config
    // 验证阶段优先用 verifier 角色模型（未配置时回退主模型）
    const verifyModel = this.config.verifyModel ?? this.config.model
    const MAX_VERIFY_STEPS = 5

    // 验证阶段允许只读工具 + bash（跑测试），不允许 edit_file
    const verifyTools = toolRegistry.getForPhase('plan')
    const bashHandler = toolRegistry.get('bash')
    if (bashHandler) verifyTools.push(bashHandler)
    const verifyToolsForAI: Record<string, { description: string; parameters: unknown }> = {}
    for (const tool of verifyTools) {
      verifyToolsForAI[tool.definition.name] = {
        description: tool.definition.description,
        parameters: resolveToolParameters(tool.definition.name, tool.definition.inputSchema),
      }
    }

    const todoStatus = this.formatTodos()
    const evidenceText = this.formatEvidenceForPrompt(evidence)
    const verifyPrompt = `## 验证任务

执行已完成。请逐项检查每个 todo 是否真正完成：

计划: ${plan.summary}

当前 todo 状态:
${todoStatus}

执行结果:
${executionResult || '(无文本输出)'}

## 确定性证据（门禁结果）
${evidenceText}

## 判定规则
- 证据失败项已列明命令与输出，按确定性失败处理，无需重复确认
- 证据全部通过或跳过时，再对每个 todo 做语义检查（read_file 验证预期修改）
- 失败项 detail 用 [缺失] 或 [行为不符] 开头说明、[建议] 结尾给修复方向；
  若该失败项有对应确定性证据失败，附 evidence 字段（如 "test: exit 1"）

## 验证步骤
1. 对每个状态为 "complete" 的 todo，用 read_file 验证目标文件是否包含预期修改
2. 对每个状态为 "pending" 或 "in_progress" 的 todo，说明缺失了什么
3. 如果有测试，用 bash 运行测试验证
4. 先列出结论（✅/❌ 各多少项），再对每个失败项给出具体修复建议
5. 最后必须输出 JSON 结论块（严格 JSON，不加多余字段）：
   全部通过:
   \`\`\`json
   {"pass": true, "failures": []}
   \`\`\`
   存在失败:
   \`\`\`json
   {"pass": false, "failures": [{"todoId": "1", "detail": "[缺失] ...；[建议] ...", "evidence": "test: exit 1"}]}
   \`\`\`

注意：验证阶段不允许修改文件（无 edit_file 工具）。`

    // 构建验证专用的消息列表（不污染主 messages）。
    // 主执行消息必须先规范化为 SDK 输入格式（tool-call 位于 content 部件数组）：
    // 内部形状的顶层 toolCalls 不会被 SDK 序列化，DeepSeek 会以 400 拒绝
    // role:'tool' 消息（“must be a response to a preceding message with 'tool_calls'”）。
    // Anthropic 验证模型同样附带缓存断点（首条 system 消息为 stable 段，跨步命中）
    const verifyProvider = this.config.verifyCost?.providerName ?? this.config.providerName
    const verifyMessages: unknown[] = [
      ...normalizeMessagesForSDK(messages as LLMCallConfig['messages'], {
        anthropicCacheBreakpoint: verifyProvider === 'anthropic',
      }),
      { role: 'user', content: verifyPrompt },
    ]

    let finalVerifyText = ''

    try {
      for (let step = 0; step < MAX_VERIFY_STEPS; step++) {
        // 检查中断
        if (this.config.abortSignal?.aborted) break

        // 拆分 provider 参数：验证循环同为多轮工具调用，需注入 thinking: disabled 等避免 422
        const {
          topLevel: verifyTopLevel,
          providerOptions: verifyProviderOptions,
          thinking: verifyThinking,
        } = splitModelParameters(this.config.verifyModelParameters ?? this.config.modelParameters)
        const genResult = await callWithRetry(
          async () => {
            // v6: 工具字段 parameters → inputSchema；maxSteps → stopWhen
            const verifyToolsSDK: Record<string, unknown> = {}
            for (const [name, t] of Object.entries(verifyToolsForAI)) {
              verifyToolsSDK[name] = { description: t.description, inputSchema: t.parameters }
            }
            return await withDeepSeekThinking(verifyThinking, () =>
              generateText({
                model: verifyModel,
                system:
                  '你是验证助手。只读检查执行结果（可用 read_file + grep + bash），不修改文件。每步先说明你要检查什么，然后调用工具。',
                messages: verifyMessages as never,
                tools: verifyToolsSDK,
                stopWhen: stepCountIs(1),
                abortSignal: this.config.abortSignal,
                // system 消息位于 messages（缓存断点附着），显式声明压制 v6 安全警告（同 ReActLoop）
                allowSystemInMessages: true,
                ...(verifyTopLevel as Record<string, never>),
                ...(verifyProviderOptions ? { providerOptions: verifyProviderOptions } : {}),
              } as never),
            )
          },
          {
            maxRetries: 1,
            onRetry: ({ attempt, delay, error }) => {
              // 用 system_info 而非 error：重试时验证仍在进行，
              // error 事件会被 TUI 当作终态展示，与最终报告重复
              onEvent({
                type: 'system_info',
                message: `验证请求重试 #${attempt}（${delay}ms 后）: ${error.message}`,
              })
            },
          },
        )

        // 验证阶段的 LLM 调用也计入成本（按 verifier 定价，未配置时沿用主模型参数；v6 usage 字段 inputTokens/outputTokens）
        if (genResult.usage) {
          const vc = this.config.verifyCost
          this.config.costTracker.record({
            role: 'verifier',
            provider: vc?.providerName ?? this.config.providerName,
            model: vc?.modelName ?? this.config.modelName,
            inputTokens: genResult.usage.inputTokens ?? 0,
            outputTokens: genResult.usage.outputTokens ?? 0,
            costPer1kInput: vc?.costPer1kInput ?? this.config.costPer1kInput,
            costPer1kOutput: vc?.costPer1kOutput ?? this.config.costPer1kOutput,
            costPer1kInputCached: vc?.costPer1kInputCached ?? this.config.costPer1kInputCached,
          })
          onEvent({
            type: 'cost_update',
            inputTokens: genResult.usage.inputTokens ?? 0,
            outputTokens: genResult.usage.outputTokens ?? 0,
            cost: this.config.costTracker.getTotalCost(),
          })
        }

        const text = genResult.text ?? ''
        const toolCalls = genResult.toolCalls ?? []

        // 无工具调用 → 验证完成，输出结论
        if (toolCalls.length === 0) {
          finalVerifyText = text
          break
        }

        // 有工具调用：推入 assistant 消息（v6 部件形状：tool-call 用 input）
        // + 执行工具 + 推入 tool 结果（tool-result 用 output）
        finalVerifyText = text || finalVerifyText
        verifyMessages.push({
          role: 'assistant',
          content: [
            ...(text ? [{ type: 'text', text }] : []),
            ...toolCalls.map((tc, idx) => ({
              type: 'tool-call',
              toolCallId: `verify-${step}-${tc.toolName}-${idx}`,
              toolName: tc.toolName,
              input: (tc.input ?? {}) as Record<string, unknown>,
            })),
          ],
        })

        // 执行工具并收集结果（v6: tool-result 的 output 为判别联合 {type:'text', value}）
        const toolResults: Array<{
          type: 'tool-result'
          toolCallId: string
          toolName: string
          output: { type: 'text'; value: string }
        }> = []
        for (let idx = 0; idx < toolCalls.length; idx++) {
          const tc = toolCalls[idx]
          const callId = `verify-${step}-${tc.toolName}-${idx}`
          const args = (tc.input ?? {}) as Record<string, unknown>

          onEvent({ type: 'tool_call', tool: tc.toolName, params: args, callId })

          const result = await toolRegistry.execute(tc.toolName, args, { ...toolContext, callId })
          const resultText = result.error ? `[错误] ${result.error}` : result.result

          onEvent({
            type: 'tool_result',
            callId,
            tool: tc.toolName,
            result: result.result,
            error: result.error,
          })
          toolResults.push({
            type: 'tool-result',
            toolCallId: callId,
            toolName: tc.toolName,
            output: { type: 'text', value: resultText },
          })
        }

        verifyMessages.push({ role: 'tool', content: toolResults })
      }

      onEvent({ type: 'system_info', message: '验证完成' })
      const report = finalVerifyText || '验证完成（无输出）'
      // 解析结构化结论；解析失败保守按通过处理（模糊信号不应触发修复循环）
      const outcome = parseVerifyVerdict(report) ?? { pass: true, failures: [] }
      return { outcome, report }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // 验证自身失败不等于任务失败，保守按通过处理，仅报告错误。
      // 不额外发 error 事件：报告会随 ## 验证 区块展示一次，避免 TUI 重复显示
      return { outcome: { pass: true, failures: [] }, report: `验证失败: ${msg}` }
    }
  }

  /**
   * 执行单个工具调用（权限检查 → 执行 → checkpoint → 结果收集）
   * 结果推入 toolResults 数组，由调用方统一组装为 tool 消息
   */
  private async executeSingleToolCall(
    toolCall: { toolName: string; args: Record<string, unknown> },
    messages: Array<
      | { role: 'user' | 'assistant'; content: string }
      | {
          role: 'assistant'
          content: string
          toolCalls: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>
        }
      | {
          role: 'tool'
          content: Array<{
            type: 'tool-result'
            toolCallId: string
            toolName: string
            result: string
          }>
        }
    >,
    toolResults: Array<{ toolCallId: string; toolName: string; result: string }>,
    callIndex: number,
  ): Promise<void> {
    const { toolRegistry, toolContext, onEvent } = this.config
    const callId = `exec-${this.iterations}-${toolCall.toolName}-${callIndex}`
    const args = toolCall.args as Record<string, unknown>
    // 任务归属：取调用发起时刻的 in_progress todo（TUI 按任务分组展示）
    const todoId = this.getCurrentTodoId()

    onEvent({ type: 'tool_call', tool: toolCall.toolName, params: args, callId, todoId })

    // 权限检查
    const decision = normalizeApprovalDecision(await this.checkPermission(toolCall.toolName, args))
    if (!decision.approved) {
      const rejectMsg = decision.reason
        ? `用户拒绝了此操作：${decision.reason}。请根据反馈调整方式。`
        : '用户拒绝了此操作。请换一种方式完成任务,或解释为什么需要这个操作。'
      // 审批拒绝用 user role（表达“用户不允许”的语义）
      messages.push({ role: 'user', content: `[工具被拒绝 ${toolCall.toolName}]: ${rejectMsg}` })
      toolResults.push({
        toolCallId: callId,
        toolName: toolCall.toolName,
        result: `[拒绝] ${rejectMsg}`,
      })
      onEvent({
        type: 'tool_result',
        callId,
        tool: toolCall.toolName,
        result: '',
        error: rejectMsg,
        todoId,
      })
      return
    }

    // bash 工具受信号量并发限制
    let toolResult: { result: string; error?: string }
    if (toolCall.toolName === 'bash') {
      await this.bashSemaphore.acquire()
      try {
        toolResult = await toolRegistry.execute(toolCall.toolName, args, { ...toolContext, callId })
      } finally {
        this.bashSemaphore.release()
      }
    } else {
      toolResult = await toolRegistry.execute(toolCall.toolName, args, { ...toolContext, callId })
    }

    onEvent({
      type: 'tool_result',
      callId,
      tool: toolCall.toolName,
      result: toolResult.result,
      error: toolResult.error,
      todoId,
    })

    // edit_file 成功后创建 checkpoint
    if (toolCall.toolName === 'edit_file' && !toolResult.error) {
      const checkpoint = await this.config.checkpoint.create(
        `edit: ${args.path}`,
        this.getCurrentTodoId(),
      )
      if (checkpoint) {
        onEvent({ type: 'checkpoint', step: checkpoint.step, message: checkpoint.message })
      }
    }

    // 步级测试驱动闭环：edit_file/create_file 成功后自动跑受影响测试，失败喂回 LLM
    if (
      (toolCall.toolName === 'edit_file' || toolCall.toolName === 'create_file') &&
      !toolResult.error &&
      typeof args.path === 'string'
    ) {
      await this.runAffectedTests(args.path, messages)
    }

    // 构建结果文本（包含错误提示）
    let resultText: string
    if (toolResult.error && toolCall.toolName === 'edit_file') {
      const path = (args.path as string) || '(未知文件)'
      const count = (this.consecutiveEditFailures.get(path) || 0) + 1
      this.consecutiveEditFailures.set(path, count)

      let hint = ''
      if (count >= 3) {
        // 连续 3 次失败：自动回滚文件到上一个良好状态
        const rollbackResult = await this.config.checkpoint.rollbackFile(path)
        this.consecutiveEditFailures.set(path, 0)
        if (rollbackResult.success) {
          hint = `\n\n⚠️ 连续 ${count} 次编辑失败，${rollbackResult.message}。\n请重新 read_file 查看文件当前内容，然后制定新的编辑策略。`
          onEvent({ type: 'system_info', message: `自动回滚: ${rollbackResult.message}` })
        } else {
          hint = `\n\n⚠️ 连续 ${count} 次编辑失败。${rollbackResult.message}\n请停下来重新思考策略：\n1. 先用 read_file 查看文件当前内容\n2. 确保 old_string 精准匹配`
        }
      } else if (toolResult.error.includes('未找到匹配') || toolResult.error.includes('不唯一')) {
        hint = `\n💡 提示: 用 read_file 查看 ${path} 当前内容，确保 old_string 唯一且精准匹配（包括空格和缩进）`
      }
      resultText = `[错误] ${toolResult.error}${hint}`
    } else if (toolResult.error) {
      resultText = `[错误] ${toolResult.error}`
    } else {
      resultText = toolResult.result
    }

    // 推入结果收集数组
    toolResults.push({ toolCallId: callId, toolName: toolCall.toolName, result: resultText })

    // edit_file / create_file 成功时重置失败计数并上报文件产物
    // （file_artifact 携带当前 todo 归属，TUI 展示在对应任务下方而非底部聚合）
    if (
      (toolCall.toolName === 'edit_file' || toolCall.toolName === 'create_file') &&
      !toolResult.error
    ) {
      const path = (args.path as string) || ''
      if (toolCall.toolName === 'edit_file') {
        this.consecutiveEditFailures.set(path, 0)
      }
      this.hasCodeChanges = true
      if (path) {
        onEvent({
          type: 'file_artifact',
          path,
          tool: toolCall.toolName,
          todoId: this.getCurrentTodoId(),
        })
      }
    }

    // 更新 todo 状态
    this.updateTodoProgress(toolCall.toolName, args)
  }

  /**
   * 自适应压实：按 prompt token 占窗口比例分档。
   * micro：零成本压缩早期工具结果；emergency：summarizer 摘要前期迭代。
   * 只替换内容或按完整轮次边界裁剪，不拆 tool-call/tool-result 配对。
   */
  private async applyCompaction(messages: ExecMessage[], promptTokens: number): Promise<void> {
    const compaction = this.config.compaction
    const contextWindow = this.config.contextWindow
    if (!compaction || !contextWindow) return

    const level = compactionLevel(promptTokens, {
      contextWindow,
      compactionThreshold: compaction.compactionThreshold,
      emergencyThreshold: compaction.emergencyThreshold,
      keepRecentResultsFull: compaction.keepRecentResultsFull,
    })
    if (level === 'none') return

    const pct = Math.round((promptTokens / contextWindow) * 100)

    if (level === 'emergency' && this.config.compactModel) {
      try {
        const result = await emergencyCompactMessages(
          messages,
          this.config.compactModel,
          compaction.keepRecentResultsFull,
        )
        if (result.changed) {
          messages.length = 0
          messages.push(...result.messages)
          // 压实后细节单向丢失：提示模型可回读任务笔记找回状态（结构化笔记外置模式）
          messages.push({
            role: 'user',
            content:
              '[系统提示·上下文压实] 前期执行历史已被摘要，具体细节可能丢失。继续前请先 update_notes(action="read") 检查任务笔记；若笔记为空且后续任务较长，建议把当前进度与关键决策用 update_notes(action="append") 记录下来。',
          })
          this.config.onEvent({
            type: 'system_info',
            message: `上下文紧急压实（水位 ${pct}%）：前期迭代已摘要，最近 ${compaction.keepRecentResultsFull} 条工具结果完整保留`,
          })
          return
        }
      } catch (err) {
        // 紧急压实异常：降级微压实，不阻塞执行
        this.config.onEvent({
          type: 'system_info',
          message: `紧急压实异常，降级为微压实: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
    }

    const result = microCompactMessages(messages, compaction.keepRecentResultsFull)
    if (result.changed) {
      messages.length = 0
      messages.push(...result.messages)
      this.config.onEvent({
        type: 'system_info',
        message: `上下文微压实（水位 ${pct}%）：早期工具结果已压缩，最近 ${compaction.keepRecentResultsFull} 条完整保留`,
      })
    }
  }

  /**
   * 步级测试驱动闭环（2026 长任务稳定共识架构：每步测试反馈喂回）：
   * 按路径约定映射候选测试（src/x/y.ts → tests/**⁄y.test.ts(x)），
   * 命中则以 bun test 运行；失败结果注入 messages，LLM 下轮自然看到并修复。
   * 护栏：同文件每轮 execute 只跑一次；累计上限 10 次（防修复循环烧钱）。
   */
  private async runAffectedTests(editedPath: string, messages: unknown[]): Promise<void> {
    const autoTest = this.config.autoTest
    if (!autoTest) return
    if (this.autoTestedFiles.has(editedPath)) return
    if (this.autoTestCount >= 10) {
      if (!this.autoTestLimitNotified) {
        this.autoTestLimitNotified = true
        this.config.onEvent({
          type: 'system_info',
          message: '步级自动测试已达上限（10 次），后续编辑不再自动跑测试，请自行用 bash 验证',
        })
      }
      return
    }

    const candidates = await this.findCandidateTests(editedPath)
    if (candidates.length === 0) return

    this.autoTestedFiles.add(editedPath)
    this.autoTestCount++

    const projectRoot = this.config.toolContext.projectRoot
    const timeoutMs = this.config.toolContext.bashTimeout * 2 * 1000
    const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>(
      (resolvePromise) => {
        const child = spawn(autoTest.runner, ['test', ...candidates], {
          cwd: projectRoot,
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: timeoutMs,
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
        child.on('close', (code) => resolvePromise({ stdout, stderr, exitCode: code ?? 1 }))
        child.on('error', (err) => resolvePromise({ stdout: '', stderr: err.message, exitCode: 1 }))
      },
    )

    if (result.exitCode === 0) {
      // 通过：零 token 开销，仅状态行
      this.config.onEvent({
        type: 'system_info',
        message: `步级自动测试通过: ${candidates.join(', ')}`,
      })
      return
    }

    // 失败：截断输出（保留尾部，失败信息在尾部）后注入下轮上下文
    const raw = `${result.stdout}\n${result.stderr}`.trim()
    const output = raw.length > 1500 ? `...（已截断）\n${raw.slice(-1500)}` : raw
    ;(messages as Array<{ role: string; content: string }>).push({
      role: 'user',
      content: `[自动测试反馈] 修改 ${editedPath} 后相关测试未通过（${candidates.join(', ')}），请先修复以下失败再继续:\n${output}`,
    })
    this.config.onEvent({
      type: 'system_info',
      message: `步级自动测试失败，已喂回 LLM: ${candidates.join(', ')}`,
    })
  }

  /** 按路径约定映射候选测试文件：src/**⁄name.ts(x) → tests 下任意深度的 name.test.ts(x) */
  private async findCandidateTests(editedPath: string): Promise<string[]> {
    const name = basename(editedPath).replace(/\.(ts|tsx|js|jsx)$/, '')
    const wanted = new Set([`${name}.test.ts`, `${name}.test.tsx`])
    const testsRoot = join(this.config.toolContext.projectRoot, 'tests')
    const results: string[] = []

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 5) return
      let entries: Dirent[]
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(full, depth + 1)
        } else if (wanted.has(entry.name)) {
          results.push(full)
        }
      }
    }
    await walk(testsRoot, 0)
    return results
  }

  /** 权限检查（edit_file 审批前生成 diff 预览）；返回决策（可含拒绝原因） */
  private async checkPermission(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ToolApprovalDecision> {
    const { permissionMode, requestApproval } = this.config
    const handler = this.config.toolRegistry.get(toolName)

    // 不需要审批的工具直接通过
    if (!handler?.definition.requiresApproval) return true

    // 危险命令无论什么模式都强制审批
    if (toolName === 'bash') {
      const command = args.command as string
      if (requiresForcedApproval(command)) {
        return requestApproval(toolName, args)
      }
    }

    // 按权限模式判断
    let needsApproval = false
    switch (permissionMode) {
      case 'yolo':
        return true
      case 'auto-all':
        return true
      case 'auto-edit':
        if (toolName === 'edit_file') return true
        needsApproval = true
        break
      case 'ask':
      default:
        needsApproval = true
        break
    }

    if (!needsApproval) return true

    // edit_file 审批前生成 diff 预览
    if (toolName === 'edit_file') {
      const diff = await this.previewEditDiff(args)
      return requestApproval(toolName, args, diff ?? undefined)
    }

    return requestApproval(toolName, args)
  }

  /** 为 edit_file 生成审批用的 diff 预览 */
  private async previewEditDiff(args: Record<string, unknown>): Promise<string | null> {
    try {
      const filePath = args.path as string
      const oldString = args.old_string as string
      const newString = args.new_string as string
      if (!filePath || oldString === undefined || newString === undefined) return null

      const fullPath = resolve(this.config.toolContext.projectRoot, filePath)
      const content = await readFile(fullPath, 'utf-8')

      // 检查是否能匹配
      if (oldString !== '' && !content.includes(oldString)) return null

      const newContent = oldString === '' ? newString : content.replace(oldString, newString)
      return generateDiff(filePath, content, newContent)
    } catch {
      return null
    }
  }

  /** 更新 todo 进度（仅自动标记 in_progress；完成由 LLM 通过 update_todo 工具控制） */
  private updateTodoProgress(toolName: string, _args: Record<string, unknown>): void {
    // edit_file 时自动将第一个 pending todo 标记为 in_progress
    const pending = this.todos.find((t) => t.status === 'pending')
    if (pending && toolName === 'edit_file') {
      pending.status = 'in_progress'
      this.stepsSinceProgress = 0
      this.config.onEvent({ type: 'todo_update', todos: this.todos })
      return
    }
    this.stepsSinceProgress++
  }

  private getCurrentTodoId(): string | undefined {
    return this.todos.find((t) => t.status === 'in_progress')?.id
  }

  private formatTodos(): string {
    return this.todos
      .map((t) => {
        const icon = t.status === 'complete' ? '✓' : t.status === 'in_progress' ? '▶' : '○'
        return `${icon} ${t.content}`
      })
      .join('\n')
  }

  getTodos(): Todo[] {
    return this.todos
  }

  /** 获取最后一次执行错误（用于自动修复模式） */
  getLastError(): string | null {
    return this.lastError
  }

  /** 证据结果的人类可读文本（喂给 verifier 的 verifyPrompt 证据段） */
  private formatEvidenceForPrompt(set: EvidenceSet): string {
    if (set.results.every((r) => r.skipped)) {
      return '（未配置确定性检查，全部跳过）'
    }
    return set.results
      .map((r) => {
        if (r.skipped) return `- ${r.gate}: 跳过（未配置命令）`
        const head = `- ${r.gate}: ${r.passed ? '通过' : '失败'} (${r.command})`
        return r.passed || !r.output ? head : `${head}\n${r.output}`
      })
      .join('\n')
  }

  /**
   * Loop Engineering 证据门禁：完成时运行确定性检查（lint/typecheck/test）。
   * 全部 skipped（未配置命令）时静默通过；有实际检查时 emit 摘要供观测。
   */
  private async runEvidenceGate(): Promise<EvidenceSet> {
    const gate = new EvidenceGate(
      this.config.evidence,
      this.config.toolContext.projectRoot,
      // gate 级进度可视化：每完成一个门禁发 system_info（TUI 状态行覆盖展示 lint ✓ / typecheck ⟳ / test ⏳）
      (gateName, result) => {
        if (result.skipped) return
        this.config.onEvent({
          type: 'system_info',
          message: `门禁 ${gateName} ${result.passed ? '✓' : '✗'} · ${result.command}`,
        })
      },
    )
    const result = await gate.runAll()
    const ran = result.results.filter((r) => !r.skipped)
    if (ran.length > 0) {
      const failed = ran.filter((r) => !r.passed)
      this.config.onEvent({
        type: 'system_info',
        message: `证据门禁: ${formatEvidenceSummary(result)}${
          failed.length > 0 ? '（确定性失败，将进入修复判定）' : ''
        }`,
      })
    }
    return result
  }

  /** 获取验证结论（未运行验证时为 null） */
  getVerifyOutcome(): VerifyOutcome | null {
    return this.verifyOutcome
  }

  /** 获取证据门禁结果（未运行/无证据配置时为 null） */
  getEvidenceResult(): EvidenceSet | null {
    return this.evidenceResult
  }

  /** 获取本轮执行的循环 trace（Loop Engineering 观测；round 由编排层重写） */
  getLoopTrace(): LoopTraceRound {
    const failures = this.verifyOutcome?.pass ? 0 : (this.verifyOutcome?.failures.length ?? 0)
    return {
      round: 0,
      iterations: this.iterations,
      evidencePassed: this.evidenceResult?.passed ?? true,
      evidence: this.evidenceResult?.results ?? [],
      verifyPass: this.verifyOutcome?.pass ?? null,
      verifyFailures: failures,
    }
  }

  /** 本次执行是否产生过代码变更 */
  getHasCodeChanges(): boolean {
    return this.hasCodeChanges
  }
}

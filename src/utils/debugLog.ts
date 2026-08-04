/**
 * 调试日志 — JSON 格式，一行一条记录，默认开启
 * 写入 .nexus/debug.jsonl（追加模式，保留跨会话历史）
 * 设置 NEXUS_DEBUG=0 可关闭
 *
 * 每条记录包含 sessionId（进程级）和 callId（条目级），
 * 用于与 errorReport 进行关联追踪。
 */

import { randomUUID } from 'crypto'
import { appendFile, mkdir } from 'fs/promises'
import { join } from 'path'

const DEBUG_ENABLED = process.env.NEXUS_DEBUG !== '0'

/** 进程级会话 ID，启动时生成，用于跨日志关联 */
export const sessionId = randomUUID()

/** 生成唯一的 callId */
export function newCallId(): string {
  return randomUUID()
}

let logPath = ''
let initPromise: Promise<void> | null = null

async function ensureInitialized(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const cwd = process.cwd()
      logPath = join(cwd, '.nexus', 'debug.jsonl')
      try {
        await mkdir(join(cwd, '.nexus'), { recursive: true })
      } catch {}
    })()
  }
  await initPromise
}

async function write(entry: Record<string, unknown>): Promise<void> {
  if (!DEBUG_ENABLED) return
  await ensureInitialized()
  const line = JSON.stringify({ sessionId, callId: newCallId(), ...entry }) + '\n'
  await appendFile(logPath, line, 'utf-8')
}

export function isDebugEnabled(): boolean {
  return DEBUG_ENABLED
}

export async function logLLMRequest(
  model: unknown,
  system: string,
  messages: Array<{ role: string; content: unknown }>,
  tools: Record<string, { description: string; parameters: unknown }>,
): Promise<void> {
  if (!DEBUG_ENABLED) return
  await write({
    type: 'request',
    time: new Date().toISOString(),
    model,
    system: system.slice(0, 2000), // 截断超长 system prompt
    messages: messages.map((m) => ({
      role: m.role,
      content:
        typeof m.content === 'string'
          ? m.content.slice(0, 500)
          : JSON.stringify(m.content).slice(0, 500),
    })),
    tools: Object.keys(tools),
  })
}

export async function logLLMResponse(
  streamedText: string,
  toolCalls: Array<{ toolName: string; args: Record<string, unknown> }>,
  usage?: { promptTokens: number; completionTokens: number },
): Promise<void> {
  if (!DEBUG_ENABLED) return
  await write({
    type: 'response',
    time: new Date().toISOString(),
    text: streamedText.slice(0, 1000),
    toolCalls: toolCalls.map((tc) => ({
      tool: tc.toolName,
      args: JSON.stringify(tc.args).slice(0, 200),
    })),
    usage: usage ?? null,
  })
}

export async function logError(context: string, error: unknown): Promise<void> {
  if (!DEBUG_ENABLED) return
  await write({
    type: 'error',
    time: new Date().toISOString(),
    context,
    message: error instanceof Error ? error.message : String(error),
  })
}

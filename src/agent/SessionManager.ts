/**
 * SessionManager - 会话持久化管理
 * 封装 NexusDB 的会话/消息/todo 操作。所有 DB 失败静默容忍（仅告警），
 * 持久化是旁路能力，绝不阻塞 Agent 主流程。
 */

import { NexusDB } from '../storage/db'
import type { Todo } from './types'

export interface SessionRecord {
  id: string
  start_time: number
  message_count: number
  total_cost: number
}

export interface SessionMessage {
  role: string
  content: string
}

/** loadSession 的判别联合结果 */
export type LoadSessionResult =
  | { ok: true; sessionId: string; startTime: number; messages: SessionMessage[]; todos: Todo[] }
  | { ok: false; message: string }

export class SessionManager {
  private db: NexusDB | null = null
  private currentSessionId: string | null = null

  constructor(private projectRoot: string) {}

  /** 初始化数据库；失败时会话持久化不可用（静默降级） */
  init(): void {
    try {
      this.db = new NexusDB(this.projectRoot)
    } catch (err) {
      console.warn('[NexusDB] 数据库初始化失败，会话将不会持久化:', err)
      this.db = null
    }
  }

  /** 数据库是否可用 */
  get available(): boolean {
    return this.db !== null
  }

  /** 当前会话 ID */
  get sessionId(): string | null {
    return this.currentSessionId
  }

  /** 设置当前会话 ID（会话恢复时继续在原会话下追加消息） */
  set sessionId(id: string | null) {
    this.currentSessionId = id
  }

  /** 确保当前会话已创建（懒创建，失败静默） */
  ensureSession(): void {
    if (!this.db || this.currentSessionId) return
    try {
      this.currentSessionId = crypto.randomUUID()
      this.db.createSession(this.currentSessionId, this.projectRoot)
    } catch (err) {
      console.warn('[NexusDB] 创建会话失败:', err)
      this.currentSessionId = null
    }
  }

  /** 持久化一条消息（user/assistant/轨迹摘要），失败静默 */
  addMessage(role: string, content: string): void {
    if (!this.db || !this.currentSessionId) return
    try {
      this.db.addMessage(this.currentSessionId, role, content)
    } catch (err) {
      console.warn('[NexusDB] 持久化消息失败:', err)
    }
  }

  /** 持久化 todos 快照（会话恢复用），失败静默 */
  saveTodos(todos: Todo[]): void {
    if (!this.db || !this.currentSessionId || todos.length === 0) return
    try {
      this.db.saveTodos(this.currentSessionId, todos)
    } catch (err) {
      console.warn('[NexusDB] 持久化 todos 失败:', err)
    }
  }

  /** 结束当前会话（写入成本统计），并清空会话 ID */
  endSession(cost: number, inputTokens: number, outputTokens: number, historyLength: number): void {
    if (this.db && this.currentSessionId) {
      try {
        this.db.endSession(this.currentSessionId, cost, inputTokens, outputTokens, historyLength)
      } catch (err) {
        console.warn('[NexusDB] 结束会话失败:', err)
      }
      this.currentSessionId = null
    }
  }

  /**
   * 加载会话数据（消息 + todos）。
   * sessionId 缺省时取最近会话；会话不存在/无消息时返回 ok:false 与原因。
   */
  loadSession(sessionId?: string): LoadSessionResult {
    if (!this.db) {
      // 惰性初始化（restore/list/search 可能在 startBackgroundInit 之前被调用）
      this.init()
      if (!this.db) return { ok: false, message: '数据库不可用，无法恢复会话' }
    }

    const session = sessionId
      ? this.db.getSession(sessionId)
      : this.db.getLatestSession(this.projectRoot)

    if (!session) {
      return {
        ok: false,
        message: sessionId ? `未找到会话: ${sessionId}` : '没有可恢复的历史会话',
      }
    }

    const messages = this.db.getMessages(session.id)
    if (messages.length === 0) {
      return { ok: false, message: '该会话没有消息记录' }
    }

    return {
      ok: true,
      sessionId: session.id,
      startTime: session.start_time,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      todos: this.db.loadTodos(session.id),
    }
  }

  /** 列出最近会话（数据库不可用时返回空列表） */
  listRecentSessions(limit = 5): SessionRecord[] {
    if (!this.db) {
      this.init()
      if (!this.db) return []
    }
    return this.db.listRecentSessions(limit, this.projectRoot)
  }

  /** 全文搜索会话消息（数据库不可用时返回空列表） */
  searchMessages(query: string): Array<{
    sessionId: string
    startTime: number
    messageCount: number
    matchCount: number
    matches: Array<{ role: string; snippet: string; timestamp: number }>
  }> {
    if (!this.db) {
      this.init()
      if (!this.db) return []
    }
    return this.db.searchMessages(query)
  }

  /** 关闭数据库连接 */
  close(): void {
    this.db?.close()
    this.db = null
    this.currentSessionId = null
  }
}

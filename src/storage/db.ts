/**
 * SQLite 存储层
 * 单文件、无服务,存储会话历史、索引、embedding
 */

import { Database } from 'bun:sqlite'
import { mkdirSync } from 'fs'
import { join } from 'path'
import type { Todo } from '../agent/types'
import { runMigrations } from './migrations'

export interface SessionRecord {
  id: string
  project_root: string
  start_time: number
  end_time: number | null
  total_cost: number
  total_input_tokens: number
  total_output_tokens: number
  message_count: number
}

export interface MessageRecord {
  id: number
  session_id: string
  role: string
  content: string
  tool_name: string | null
  timestamp: number
}

export class NexusDB {
  private db: Database
  private dbPath: string

  constructor(projectRoot: string) {
    const nexusDir = join(projectRoot, '.nexus')
    mkdirSync(nexusDir, { recursive: true })
    this.dbPath = join(nexusDir, 'nexus.db')
    this.db = new Database(this.dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    runMigrations(this.db)
  }

  /** 创建新会话 */
  createSession(id: string, projectRoot: string): void {
    this.db
      .prepare(`
      INSERT INTO sessions (id, project_root, start_time)
      VALUES (?, ?, ?)
    `)
      .run(id, projectRoot, Date.now())
  }

  /** 结束会话 */
  endSession(
    id: string,
    cost: number,
    inputTokens: number,
    outputTokens: number,
    messageCount: number,
  ): void {
    this.db
      .prepare(`
      UPDATE sessions
      SET end_time = ?, total_cost = ?, total_input_tokens = ?, total_output_tokens = ?, message_count = ?
      WHERE id = ?
    `)
      .run(Date.now(), cost, inputTokens, outputTokens, messageCount, id)
  }

  /** 添加消息 */
  addMessage(sessionId: string, role: string, content: string, toolName?: string): void {
    this.db
      .prepare(`
      INSERT INTO messages (session_id, role, content, tool_name, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `)
      .run(sessionId, role, content, toolName ?? null, Date.now())
  }

  /** 获取会话消息 */
  getMessages(sessionId: string): MessageRecord[] {
    return this.db
      .prepare(`
      SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC
    `)
      .all(sessionId) as MessageRecord[]
  }

  /** 获取最近一次会话（按 start_time 降序） */
  getLatestSession(projectRoot?: string): SessionRecord | null {
    if (projectRoot) {
      const row = this.db
        .prepare(`
        SELECT * FROM sessions WHERE project_root = ? ORDER BY start_time DESC LIMIT 1
      `)
        .get(projectRoot) as SessionRecord | undefined
      return row ?? null
    }
    const row = this.db
      .prepare(`
      SELECT * FROM sessions ORDER BY start_time DESC LIMIT 1
    `)
      .get() as SessionRecord | undefined
    return row ?? null
  }

  /** 按 ID 获取会话 */
  getSession(sessionId: string): SessionRecord | null {
    const row = this.db
      .prepare(`
      SELECT * FROM sessions WHERE id = ?
    `)
      .get(sessionId) as SessionRecord | undefined
    return row ?? null
  }

  /** 列出最近的会话（用于 /resume 展示） */
  listRecentSessions(limit = 10, projectRoot?: string): SessionRecord[] {
    if (projectRoot) {
      return this.db
        .prepare(`
        SELECT * FROM sessions WHERE project_root = ? ORDER BY start_time DESC LIMIT ?
      `)
        .all(projectRoot, limit) as SessionRecord[]
    }
    return this.db
      .prepare(`
      SELECT * FROM sessions ORDER BY start_time DESC LIMIT ?
    `)
      .all(limit) as SessionRecord[]
  }

  /** 保存 todos 快照（覆盖式：先删后插） */
  saveTodos(sessionId: string, todos: Todo[]): void {
    this.db.prepare('DELETE FROM todos WHERE session_id = ?').run(sessionId)
    const insert = this.db.prepare(`
      INSERT INTO todos (session_id, todo_id, content, status, position, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    const now = Date.now()
    for (let i = 0; i < todos.length; i++) {
      insert.run(sessionId, todos[i].id, todos[i].content, todos[i].status, i, now)
    }
  }

  /** 加载会话的 todos */
  loadTodos(sessionId: string): Todo[] {
    const rows = this.db
      .prepare(`
      SELECT todo_id, content, status FROM todos WHERE session_id = ? ORDER BY position ASC
    `)
      .all(sessionId) as Array<{ todo_id: string; content: string; status: string }>
    return rows.map((r) => ({
      id: r.todo_id,
      content: r.content,
      status: r.status as Todo['status'],
    }))
  }

  /** 关闭数据库 */
  close(): void {
    this.db.close()
  }

  getDbPath(): string {
    return this.dbPath
  }
}

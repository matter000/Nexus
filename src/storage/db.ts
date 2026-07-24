/**
 * SQLite 存储层
 * 单文件、无服务,存储会话历史、索引、embedding
 */

import Database from 'better-sqlite3'
import { join } from 'path'
import { mkdirSync } from 'fs'

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
  private db: Database.Database
  private dbPath: string

  constructor(projectRoot: string) {
    const nexusDir = join(projectRoot, '.nexus')
    mkdirSync(nexusDir, { recursive: true })
    this.dbPath = join(nexusDir, 'nexus.db')
    this.db = new Database(this.dbPath)
    this.db.pragma('journal_mode = WAL')
    this.migrate()
  }

  /** 运行迁移 */
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project_root TEXT NOT NULL,
        start_time INTEGER NOT NULL,
        end_time INTEGER,
        total_cost REAL DEFAULT 0,
        total_input_tokens INTEGER DEFAULT 0,
        total_output_tokens INTEGER DEFAULT 0,
        message_count INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_name TEXT,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      CREATE TABLE IF NOT EXISTS checkpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        step INTEGER NOT NULL,
        commit_hash TEXT NOT NULL,
        message TEXT NOT NULL,
        todo_id TEXT,
        timestamp INTEGER NOT NULL,
        files_changed TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON checkpoints(session_id);
    `)
  }

  /** 创建新会话 */
  createSession(id: string, projectRoot: string): void {
    this.db.prepare(`
      INSERT INTO sessions (id, project_root, start_time)
      VALUES (?, ?, ?)
    `).run(id, projectRoot, Date.now())
  }

  /** 结束会话 */
  endSession(id: string, cost: number, inputTokens: number, outputTokens: number, messageCount: number): void {
    this.db.prepare(`
      UPDATE sessions
      SET end_time = ?, total_cost = ?, total_input_tokens = ?, total_output_tokens = ?, message_count = ?
      WHERE id = ?
    `).run(Date.now(), cost, inputTokens, outputTokens, messageCount, id)
  }

  /** 添加消息 */
  addMessage(sessionId: string, role: string, content: string, toolName?: string): void {
    this.db.prepare(`
      INSERT INTO messages (session_id, role, content, tool_name, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `).run(sessionId, role, content, toolName ?? null, Date.now())
  }

  /** 获取会话消息 */
  getMessages(sessionId: string): MessageRecord[] {
    return this.db.prepare(`
      SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC
    `).all(sessionId) as MessageRecord[]
  }

  /** 获取最近会话列表 */
  getRecentSessions(limit = 10): SessionRecord[] {
    return this.db.prepare(`
      SELECT * FROM sessions ORDER BY start_time DESC LIMIT ?
    `).all(limit) as SessionRecord[]
  }

  /** 添加检查点 */
  addCheckpoint(
    sessionId: string,
    step: number,
    commitHash: string,
    message: string,
    todoId?: string,
    filesChanged?: string[]
  ): void {
    this.db.prepare(`
      INSERT INTO checkpoints (session_id, step, commit_hash, message, todo_id, timestamp, files_changed)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, step, commitHash, message, todoId ?? null, Date.now(), JSON.stringify(filesChanged ?? []))
  }

  /** 关闭数据库 */
  close(): void {
    this.db.close()
  }

  getDbPath(): string {
    return this.dbPath
  }
}

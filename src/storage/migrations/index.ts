/**
 * 数据库迁移管理
 * 版本化 schema 变更,确保向前兼容
 */

import type { Database } from 'bun:sqlite'

export interface Migration {
  version: number
  name: string
  up: string
  down?: string
}

/** 迁移列表(按版本排序) */
export const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    up: `
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
    `,
    down: `
      DROP TABLE IF EXISTS checkpoints;
      DROP TABLE IF EXISTS messages;
      DROP TABLE IF EXISTS sessions;
    `,
  },
  {
    version: 2,
    name: 'add_embeddings_table',
    up: `
      CREATE TABLE IF NOT EXISTS embeddings (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        content TEXT NOT NULL,
        embedding BLOB,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_embeddings_file ON embeddings(file_path);
    `,
    down: `
      DROP TABLE IF EXISTS embeddings;
    `,
  },
]

/** 获取当前 schema 版本 */
export function getCurrentVersion(db: Database): number {
  try {
    const row = db.prepare('SELECT MAX(version) as version FROM _migrations').get() as { version: number } | undefined
    return row?.version ?? 0
  } catch {
    return 0
  }
}

/** 运行待执行的迁移 */
export function runMigrations(db: Database): void {
  // 创建迁移记录表
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `)

  const currentVersion = getCurrentVersion(db)

  for (const migration of migrations) {
    if (migration.version > currentVersion) {
      db.exec(migration.up)
      db.prepare('INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        Date.now()
      )
    }
  }
}

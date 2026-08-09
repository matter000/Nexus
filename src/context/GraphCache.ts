/**
 * CodeGraph 磁盘缓存
 * 以「文件内容哈希」为失效依据的 FileSkeleton 缓存（SQLite 存储），
 * 避免每次会话启动都对全库做 AST 重解析（大仓库启动优化）。
 * 所有失败静默降级为全量解析，缓存是纯优化项，不影响正确性。
 */

import { Database } from 'bun:sqlite'
import { createHash } from 'crypto'
import { mkdirSync } from 'fs'
import { join } from 'path'
import type { FileSkeleton } from './CodeGraph'

export class GraphCache {
  private db: Database

  constructor(projectRoot: string) {
    const dir = join(projectRoot, '.nexus')
    mkdirSync(dir, { recursive: true })
    this.db = new Database(join(dir, 'graph-cache.db'), { create: true })
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skeletons (
        path TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        skeleton_json TEXT NOT NULL
      )
    `)
  }

  /** 按路径 + 内容哈希取缓存；哈希不匹配（文件已变）或损坏时返回 null */
  get(path: string, contentHash: string): FileSkeleton | null {
    try {
      const row = this.db
        .query('SELECT hash, skeleton_json FROM skeletons WHERE path = ?')
        .get(path) as { hash: string; skeleton_json: string } | null
      if (!row || row.hash !== contentHash) return null
      return JSON.parse(row.skeleton_json) as FileSkeleton
    } catch {
      return null
    }
  }

  /** 写入/覆盖缓存条目（失败静默） */
  set(path: string, contentHash: string, skeleton: FileSkeleton): void {
    try {
      this.db
        .query('INSERT OR REPLACE INTO skeletons (path, hash, skeleton_json) VALUES (?, ?, ?)')
        .run(path, contentHash, JSON.stringify(skeleton))
    } catch {
      // 缓存写入失败不影响图谱构建
    }
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      // 忽略关闭失败
    }
  }
}

/** 计算文件内容哈希（缓存失效依据） */
export function hashContent(content: string): string {
  return createHash('sha1').update(content).digest('hex')
}

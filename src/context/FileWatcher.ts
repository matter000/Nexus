/**
 * 文件监听器
 * 基于 Bun 原生 fs.watch（recursive: true）监听项目文件变更
 * debounce 后触发 CodeGraph 和 SemanticSearch 的增量更新
 */

import { type FSWatcher, watch } from 'fs'
import { relative } from 'path'

export interface FileWatcherConfig {
  projectRoot: string
  /** debounce 延迟（毫秒） */
  debounceMs?: number
  /** 文件变更回调 */
  onChange: (changedFiles: string[]) => void
}

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.nexus',
  '.qoder',
  'dist',
  'build',
  'coverage',
  '__pycache__',
  '.cache',
  '.next',
  '.output',
])

const WATCHED_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mts',
  '.cts',
  '.py',
  '.go',
  '.rs',
  '.java',
])

export class FileWatcher {
  private config: Required<FileWatcherConfig>
  private watcher: FSWatcher | null = null
  private pendingChanges = new Set<string>()
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private running = false

  constructor(config: FileWatcherConfig) {
    this.config = {
      projectRoot: config.projectRoot,
      debounceMs: config.debounceMs ?? 2000,
      onChange: config.onChange,
    }
  }

  /** 启动监听 */
  start(): void {
    if (this.running) return
    this.running = true

    try {
      this.watcher = watch(this.config.projectRoot, { recursive: true }, (eventType, filename) => {
        if (!filename) return
        this.handleFileChange(filename)
      })

      this.watcher.on('error', () => {
        // 监听错误时静默降级（不影响主流程）
        this.stop()
      })
    } catch {
      // fs.watch 不可用时静默降级
      this.running = false
    }
  }

  /** 停止监听 */
  stop(): void {
    this.running = false
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    this.pendingChanges.clear()
  }

  /** 是否正在运行 */
  isRunning(): boolean {
    return this.running
  }

  /** 处理文件变更事件 */
  private handleFileChange(filename: string): void {
    // 规范化路径
    const normalized = filename.replace(/\\/g, '/')

    // 检查是否在忽略目录中
    const parts = normalized.split('/')
    for (const part of parts) {
      if (IGNORED_DIRS.has(part)) return
    }

    // 检查扩展名
    const ext = normalized.substring(normalized.lastIndexOf('.'))
    if (!WATCHED_EXTENSIONS.has(ext)) return

    // 加入待处理集合
    this.pendingChanges.add(normalized)

    // debounce: 等待一段时间无新变更后批量处理
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
    }
    this.debounceTimer = setTimeout(() => {
      this.flush()
    }, this.config.debounceMs)
  }

  /** 批量处理积累的变更 */
  private flush(): void {
    if (this.pendingChanges.size === 0) return

    const files = Array.from(this.pendingChanges)
    this.pendingChanges.clear()
    this.debounceTimer = null

    try {
      this.config.onChange(files)
    } catch {
      // 回调失败不影响监听
    }
  }
}

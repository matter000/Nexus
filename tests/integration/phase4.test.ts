/**
 * Phase 4 测试补全
 * editFile 边界用例 + 多语言 parser + FileWatcher + export + DB 会话恢复
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { editFileTool } from '../../src/tools/editFile'
import { createFileTool } from '../../src/tools/createFile'
import type { ToolContext } from '../../src/tools/registry'
import { getParserForFile, getSupportedExtensions } from '../../src/context/parsers/index'
import { FileWatcher } from '../../src/context/FileWatcher'
import { exportSession } from '../../src/utils/export'
import { NexusDB } from '../../src/storage/db'
import { CheckpointManager } from '../../src/sandbox/Checkpoint'

// ─── editFile 边界用例 ──────────────────────────────────────────────────────────

describe('editFile 边界用例', () => {
  let tempDir: string
  let context: ToolContext

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'nexus-editfile-test-'))
    context = {
      projectRoot: tempDir,
      callId: 'test-edit',
      maxReadLines: 2000,
      maxOutputBytes: 102400,
      bashTimeout: 10,
      todos: [],
    }
  })

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('处理 CRLF 行尾文件', async () => {
    await writeFile(join(tempDir, 'crlf.ts'), 'const a = 1\r\nconst b = 2\r\n')
    const result = await editFileTool.execute({
      path: 'crlf.ts',
      old_string: 'const a = 1',
      new_string: 'const a = 100',
    }, context)
    expect(result.error).toBeUndefined()
    const content = await readFile(join(tempDir, 'crlf.ts'), 'utf-8')
    expect(content).toContain('\r\n')
    expect(content).toContain('const a = 100')
  })

  it('处理 BOM 文件', async () => {
    const bom = '\uFEFF'
    await writeFile(join(tempDir, 'bom.ts'), bom + 'export const x = 1\n')
    const result = await editFileTool.execute({
      path: 'bom.ts',
      old_string: 'export const x = 1',
      new_string: 'export const x = 42',
    }, context)
    expect(result.error).toBeUndefined()
    const content = await readFile(join(tempDir, 'bom.ts'), 'utf-8')
    expect(content.charCodeAt(0)).toBe(0xFEFF)
    expect(content).toContain('export const x = 42')
  })

  it('创建新文件（old_string 为空）', async () => {
    const result = await editFileTool.execute({
      path: 'new-file.ts',
      old_string: '',
      new_string: 'export const created = true\n',
    }, context)
    expect(result.error).toBeUndefined()
    expect(result.result).toContain('已创建新文件')
  })

  it('匹配不唯一时报错', async () => {
    await writeFile(join(tempDir, 'dup.ts'), 'const x = 1\nconst x = 1\n')
    const result = await editFileTool.execute({
      path: 'dup.ts',
      old_string: 'const x = 1',
      new_string: 'const x = 2',
    }, context)
    expect(result.error).toContain('不唯一')
  })

  it('路径越界被拒绝', async () => {
    const result = await editFileTool.execute({
      path: '../../outside.ts',
      old_string: 'a',
      new_string: 'b',
    }, context)
    expect(result.error).toContain('路径越界')
  })
})

// ─── createFile 工具测试 ──────────────────────────────────────────────────────────

describe('createFile 工具', () => {
  let tempDir: string
  let context: ToolContext

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'nexus-create-test-'))
    context = {
      projectRoot: tempDir,
      callId: 'test-create',
      maxReadLines: 2000,
      maxOutputBytes: 102400,
      bashTimeout: 10,
      todos: [],
    }
  })

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('创建新文件', async () => {
    const result = await createFileTool.execute({
      path: 'src/utils.ts',
      content: 'export function add(a: number, b: number) { return a + b }\n',
    }, context)
    expect(result.error).toBeUndefined()
    expect(result.result).toContain('已创建文件')
  })

  it('文件已存在时报错', async () => {
    await writeFile(join(tempDir, 'existing.ts'), 'const x = 1\n')
    const result = await createFileTool.execute({
      path: 'existing.ts',
      content: 'overwrite attempt',
    }, context)
    expect(result.error).toContain('已存在')
  })
})

// ─── 多语言 Parser 测试 ──────────────────────────────────────────────────────────

describe('多语言 Parser', () => {
  it('支持 Python/Go/Rust/Java 扩展名', () => {
    const exts = getSupportedExtensions()
    expect(exts.has('.py')).toBe(true)
    expect(exts.has('.go')).toBe(true)
    expect(exts.has('.rs')).toBe(true)
    expect(exts.has('.java')).toBe(true)
  })

  it('Python: 提取函数和类', () => {
    const parser = getParserForFile('main.py')!
    const { symbols, imports } = parser.parse(
      'import os\nfrom pathlib import Path\n\ndef hello(name):\n    print(name)\n\nclass MyClass:\n    def method(self):\n        pass\n',
      'main.py'
    )
    expect(imports.length).toBeGreaterThanOrEqual(1)
    const funcNames = symbols.filter(s => s.kind === 'function').map(s => s.name)
    expect(funcNames).toContain('hello')
    const classNames = symbols.filter(s => s.kind === 'class').map(s => s.name)
    expect(classNames).toContain('MyClass')
  })

  it('Go: 提取函数和结构体', () => {
    const parser = getParserForFile('main.go')!
    const { symbols } = parser.parse(
      'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hi")\n}\n\ntype Server struct {\n\tPort int\n}\n',
      'main.go'
    )
    const names = symbols.map(s => s.name)
    expect(names).toContain('main')
    expect(names).toContain('Server')
  })

  it('Rust: 提取函数和 struct', () => {
    const parser = getParserForFile('lib.rs')!
    const { symbols } = parser.parse(
      'use std::io;\n\npub fn process() {\n    println!("hi");\n}\n\npub struct Config {\n    pub name: String,\n}\n',
      'lib.rs'
    )
    const names = symbols.map(s => s.name)
    expect(names).toContain('process')
    expect(names).toContain('Config')
    // pub 函数应该标记为 exports
    const processFunc = symbols.find(s => s.name === 'process')
    expect(processFunc?.exports).toBe(true)
  })

  it('Java: 提取类和方法', () => {
    const parser = getParserForFile('App.java')!
    const { symbols } = parser.parse(
      'import java.util.List;\n\npublic class App {\n    public void run() {\n        System.out.println("hi");\n    }\n}\n',
      'App.java'
    )
    const names = symbols.map(s => s.name)
    expect(names).toContain('App')
    expect(names).toContain('run')
  })

  it('不支持的文件返回 null', () => {
    expect(getParserForFile('file.txt')).toBeNull()
    expect(getParserForFile('file.ts')).toBeNull() // TS 用 AST，不用正则 parser
  })
})

// ─── FileWatcher 测试 ──────────────────────────────────────────────────────────

describe('FileWatcher', () => {
  let tempDir: string

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'nexus-watch-test-'))
  })

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('启动和停止不报错', () => {
    const watcher = new FileWatcher({
      projectRoot: tempDir,
      onChange: () => {},
    })
    watcher.start()
    expect(watcher.isRunning()).toBe(true)
    watcher.stop()
    expect(watcher.isRunning()).toBe(false)
  })

  it('忽略 node_modules 和 .git 目录', async () => {
    const changes: string[][] = []
    const watcher = new FileWatcher({
      projectRoot: tempDir,
      debounceMs: 100,
      onChange: (files) => changes.push(files),
    })
    watcher.start()

    // 创建被忽略目录中的文件
    await mkdir(join(tempDir, 'node_modules'), { recursive: true })
    await writeFile(join(tempDir, 'node_modules', 'test.ts'), 'const x = 1')

    // 等待 debounce
    await new Promise(r => setTimeout(r, 300))
    watcher.stop()

    // node_modules 中的变更不应触发回调
    const allChanges = changes.flat()
    expect(allChanges.filter(f => f.includes('node_modules')).length).toBe(0)
  })
})

// ─── Export 测试 ──────────────────────────────────────────────────────────────────

describe('exportSession', () => {
  let tempDir: string

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'nexus-export-test-'))
  })

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('导出为 Markdown 文件', async () => {
    const outputPath = join(tempDir, 'export.md')
    const result = await exportSession({
      history: [
        { role: 'user', content: '修复 bug' },
        { role: 'assistant', content: '已修复 src/app.ts 中的空指针问题' },
      ],
      todos: [
        { id: '1', content: '修复空指针', status: 'complete' },
        { id: '2', content: '添加测试', status: 'pending' },
      ],
      cost: { total: 0.0123, inputTokens: 1000, outputTokens: 500 },
      projectRoot: tempDir,
    }, outputPath)

    expect(result).toBe(outputPath)
    const content = await readFile(outputPath, 'utf-8')
    expect(content).toContain('# Nexus 会话记录')
    expect(content).toContain('修复 bug')
    expect(content).toContain('✅ 修复空指针')
    expect(content).toContain('⬜ 添加测试')
    expect(content).toContain('$0.0123')
  })
})

// ─── DB 会话恢复测试 ──────────────────────────────────────────────────────────────

describe('NexusDB 会话恢复', () => {
  let tempDir: string
  let db: NexusDB

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'nexus-db-test-'))
    await mkdir(join(tempDir, '.nexus'), { recursive: true })
    db = new NexusDB(tempDir)
  })

  afterAll(async () => {
    db.close()
    // Windows 上 SQLite 文件可能短暂锁定，延迟清理
    await new Promise(r => setTimeout(r, 100))
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  })

  it('创建和恢复会话', () => {
    const sessionId = 'test-session-1'
    db.createSession(sessionId, tempDir)
    db.addMessage(sessionId, 'user', '你好')
    db.addMessage(sessionId, 'assistant', '你好！有什么可以帮你的？')

    const session = db.getLatestSession(tempDir)
    expect(session).not.toBeNull()
    expect(session!.id).toBe(sessionId)

    const messages = db.getMessages(sessionId)
    expect(messages.length).toBe(2)
    expect(messages[0].role).toBe('user')
    expect(messages[1].content).toContain('有什么可以帮你的')
  })

  it('保存和加载 todos', () => {
    const sessionId = 'test-session-2'
    db.createSession(sessionId, tempDir)

    db.saveTodos(sessionId, [
      { id: 't1', content: '任务一', status: 'complete' },
      { id: 't2', content: '任务二', status: 'pending' },
    ])

    const todos = db.loadTodos(sessionId)
    expect(todos.length).toBe(2)
    expect(todos[0].id).toBe('t1')
    expect(todos[0].status).toBe('complete')
    expect(todos[1].content).toBe('任务二')
  })

  it('列出最近会话', () => {
    const sessions = db.listRecentSessions(5, tempDir)
    expect(sessions.length).toBeGreaterThanOrEqual(2)
  })

  it('endSession 记录成本和消息数', () => {
    const sessionId = 'test-session-cost'
    db.createSession(sessionId, tempDir)
    db.addMessage(sessionId, 'user', '消息1')
    db.addMessage(sessionId, 'assistant', '消息2')
    db.addMessage(sessionId, 'user', '消息3')
    db.endSession(sessionId, 0.5, 1000, 500, 3)
    const session = db.getSession(sessionId)
    expect(session).not.toBeNull()
    expect(session!.total_cost).toBe(0.5)
    expect(session!.message_count).toBe(3)
  })

  it('getSession 返回指定会话', () => {
    const s1 = 'session-get-1'
    const s2 = 'session-get-2'
    db.createSession(s1, tempDir)
    db.createSession(s2, tempDir)
    const found = db.getSession(s1)
    expect(found).not.toBeNull()
    expect(found!.id).toBe(s1)
    const notFound = db.getSession('non-existent')
    expect(notFound).toBeNull()
  })
})

// ─── CheckpointManager 边界 ─────────────────────────────────────────────────────

describe('CheckpointManager 边界', () => {
  let tmpDir: string

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'nexus-cp-boundary-'))
  })

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  it('setEnabled/isEnabled 控制检查点开关', async () => {
    const cm = new CheckpointManager(tmpDir)
    await cm.init()

    expect(cm.isEnabled()).toBe(true)
    cm.setEnabled(false)
    expect(cm.isEnabled()).toBe(false)
    cm.setEnabled(true)
    expect(cm.isEnabled()).toBe(true)
  })

  it('多次 undo 到空后返回提示', async () => {
    const cm = new CheckpointManager(tmpDir)
    await cm.init()

    await writeFile(join(tmpDir, 'f.txt'), 'data', 'utf-8')
    await cm.create('唯一步骤')

    const r1 = await cm.undo()
    expect(r1).toContain('已回滚')

    const r2 = await cm.undo()
    expect(r2).toBe('没有可回滚的检查点')
  })

  it('在已初始化的 git 仓库中 init 不报错', async () => {
    const cm = new CheckpointManager(tmpDir)
    await cm.init()
    await cm.init() // 第二次 init 应幂等
    expect(cm.getCurrentStep()).toBe(0)
  })
})

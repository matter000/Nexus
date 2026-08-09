/**
 * 集成测试: list_directory, search_symbol, fetch_url 工具
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtemp, writeFile, mkdir, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { createToolRegistry, type ToolContext } from '../../src/tools/registry'

describe('list_directory tool', () => {
  let tempDir: string
  let registry: ReturnType<typeof createToolRegistry>
  let context: ToolContext

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'nexus-listdir-'))
    registry = createToolRegistry()
    context = {
      projectRoot: tempDir,
      callId: 'test-ld-1',
      maxReadLines: 2000,
      maxOutputBytes: 102400,
      bashTimeout: 10,
      todos: [],
    }

    // 创建测试目录结构
    await mkdir(join(tempDir, 'src'), { recursive: true })
    await mkdir(join(tempDir, 'src', 'utils'), { recursive: true })
    await mkdir(join(tempDir, 'node_modules'), { recursive: true })
    await mkdir(join(tempDir, '.git'), { recursive: true })
    await writeFile(join(tempDir, 'src', 'index.ts'), 'export const x = 1\n')
    await writeFile(join(tempDir, 'src', 'utils', 'helper.ts'), 'export function help() {}\n')
    await writeFile(join(tempDir, 'node_modules', 'fake.ts'), 'module.exports = {}\n')
    await writeFile(join(tempDir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  })

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('列出根目录内容', async () => {
    const result = await registry.execute('list_directory', {}, context)
    expect(result.error).toBeUndefined()
    expect(result.result).toContain('src')
  })

  it('忽略 node_modules 和 .git 目录', async () => {
    const result = await registry.execute('list_directory', {}, context)
    expect(result.result).not.toContain('node_modules')
    expect(result.result).not.toContain('.git')
  })

  it('递归列出子目录', async () => {
    const result = await registry.execute('list_directory', { recursive: true }, context)
    expect(result.error).toBeUndefined()
    expect(result.result).toContain('index.ts')
    expect(result.result).toContain('helper.ts')
  })

  it('按模式过滤文件', async () => {
    const result = await registry.execute('list_directory', { pattern: 'helper' }, context)
    expect(result.error).toBeUndefined()
    expect(result.result).toContain('helper')
  })

  it('路径越界被拒绝', async () => {
    const result = await registry.execute('list_directory', { path: '../../etc' }, context)
    expect(result.error).toContain('越界')
  })

  it('目标不是目录时报错', async () => {
    const result = await registry.execute('list_directory', { path: 'src/index.ts' }, context)
    expect(result.error).toContain('不是一个目录')
  })

  it('schema 校验拒绝无效参数', async () => {
    const result = await registry.execute('list_directory', { recursive: 'yes' }, context)
    expect(result.error).toContain('校验')
  })
})

describe('search_symbol tool', () => {
  let tempDir: string
  let registry: ReturnType<typeof createToolRegistry>
  let context: ToolContext

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'nexus-symsearch-'))
    registry = createToolRegistry()
    context = {
      projectRoot: tempDir,
      callId: 'test-ss-1',
      maxReadLines: 2000,
      maxOutputBytes: 102400,
      bashTimeout: 10,
      todos: [],
    }

    await writeFile(join(tempDir, 'app.ts'), [
      'export interface AppConfig {',
      '  name: string',
      '  port: number',
      '}',
      '',
      'export function createApp(config: AppConfig): void {',
      '  console.log(config.name)',
      '}',
      '',
      'export class AppServer {',
      '  private config: AppConfig',
      '  constructor(config: AppConfig) {',
      '    this.config = config',
      '  }',
      '  start(): void {}',
      '}',
    ].join('\n'))
  })

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('搜索函数符号', async () => {
    const result = await registry.execute('search_symbol', { symbol: 'createApp' }, context)
    expect(result.error).toBeUndefined()
    expect(result.result).toContain('createApp')
    expect(result.result).toContain('function')
  })

  it('搜索类符号', async () => {
    const result = await registry.execute('search_symbol', { symbol: 'AppServer' }, context)
    expect(result.error).toBeUndefined()
    expect(result.result).toContain('AppServer')
    expect(result.result).toContain('class')
  })

  it('搜索接口符号', async () => {
    const result = await registry.execute('search_symbol', { symbol: 'AppConfig' }, context)
    expect(result.error).toBeUndefined()
    expect(result.result).toContain('AppConfig')
    expect(result.result).toContain('interface')
  })

  it('未找到符号时给出提示', async () => {
    const result = await registry.execute('search_symbol', { symbol: 'NonExistentSymbol12345' }, context)
    expect(result.error).toBeUndefined()
    expect(result.result).toContain('未找到')
  })

  it('schema 校验: symbol 必填', async () => {
    const result = await registry.execute('search_symbol', {}, context)
    expect(result.error).toContain('校验')
  })

  it('schema 校验: type 枚举值', async () => {
    const result = await registry.execute('search_symbol', { symbol: 'createApp', type: 'invalid' }, context)
    expect(result.error).toContain('校验')
  })
})

describe('fetch_url tool', () => {
  let registry: ReturnType<typeof createToolRegistry>
  let context: ToolContext

  beforeAll(() => {
    registry = createToolRegistry()
    context = {
      projectRoot: process.cwd(),
      callId: 'test-fu-1',
      maxReadLines: 2000,
      maxOutputBytes: 102400,
      bashTimeout: 10,
      todos: [],
    }
  })

  it('拒绝非 http/https 协议', async () => {
    const result = await registry.execute('fetch_url', { url: 'ftp://example.com' }, context)
    expect(result.error).toContain('无效的 URL 协议')
  })

  it('schema 校验: url 必填', async () => {
    const result = await registry.execute('fetch_url', {}, context)
    expect(result.error).toContain('校验')
  })

  it('fetch_url 需要审批', () => {
    const handler = registry.get('fetch_url')
    expect(handler).toBeDefined()
    expect(handler!.definition.requiresApproval).toBe(true)
  })

  it('fetch_url 在 plan 和 execute 阶段都可用', () => {
    const handler = registry.get('fetch_url')
    expect(handler!.definition.phase).toBe('both')
  })
})

describe('update_notes tool', () => {
  let tempDir: string
  let registry: ReturnType<typeof createToolRegistry>
  let context: ToolContext

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'nexus-notes-'))
    registry = createToolRegistry()
    context = {
      projectRoot: tempDir,
      callId: 'test-notes-1',
      maxReadLines: 2000,
      maxOutputBytes: 102400,
      bashTimeout: 10,
      todos: [],
    }
  })

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('笔记不存在时 read 返回引导文本', async () => {
    const result = await registry.execute('update_notes', { action: 'read' }, context)
    expect(result.error).toBeUndefined()
    expect(result.result).toContain('笔记为空')
  })

  it('append 后 read 能读回内容', async () => {
    const w = await registry.execute(
      'update_notes',
      { action: 'append', content: '- [步骤1] 已修改 src/a.ts' },
      context,
    )
    expect(w.error).toBeUndefined()
    const r = await registry.execute('update_notes', { action: 'read' }, context)
    expect(r.result).toContain('已修改 src/a.ts')
  })

  it('多次 append 追加而非覆盖', async () => {
    await registry.execute('update_notes', { action: 'append', content: '- [步骤2] 测试通过' }, context)
    const r = await registry.execute('update_notes', { action: 'read' }, context)
    expect(r.result).toContain('步骤1')
    expect(r.result).toContain('步骤2')
  })

  it('replace 整体替换笔记', async () => {
    await registry.execute('update_notes', { action: 'replace', content: '精炼版笔记' }, context)
    const r = await registry.execute('update_notes', { action: 'read' }, context)
    expect(r.result).toContain('精炼版笔记')
    expect(r.result).not.toContain('步骤1')
  })

  it('schema 校验: append 缺 content 时报错', async () => {
    const result = await registry.execute('update_notes', { action: 'append' }, context)
    expect(result.error).toContain('content')
  })

  it('schema 校验拒绝未知 action', async () => {
    const result = await registry.execute('update_notes', { action: 'delete' }, context)
    expect(result.error).toBeDefined()
  })
})

describe('ToolRegistry 新工具注册', () => {
  let registry: ReturnType<typeof createToolRegistry>

  beforeAll(() => {
    registry = createToolRegistry()
  })

  it('list_directory 已注册', () => {
    expect(registry.has('list_directory')).toBe(true)
  })

  it('search_symbol 已注册', () => {
    expect(registry.has('search_symbol')).toBe(true)
  })

  it('fetch_url 已注册', () => {
    expect(registry.has('fetch_url')).toBe(true)
  })

  it('update_notes 已注册且双阶段免审批', () => {
    const handler = registry.get('update_notes')
    expect(handler).toBeDefined()
    expect(handler?.definition.phase).toBe('both')
    expect(handler?.definition.requiresApproval).toBe(false)
  })

  it('plan 阶段包含只读工具', () => {
    const names = registry.getForPhase('plan').map((t) => t.definition.name)
    expect(names).toContain('list_directory')
    expect(names).toContain('search_symbol')
    expect(names).toContain('fetch_url')
  })

  it('总共注册 28 个工具', () => {
    const tools = registry.getAll()
    expect(tools.length).toBe(28)
    // 显式列出工具名，新增/删除工具时此断言会失败，强制同步测试
    const names = tools.map((t) => t.definition.name)
    expect(names).toEqual([
      'read_file',
      'edit_file',
      'bash',
      'grep',
      'glob',
      'update_todo',
      'update_notes',
      'submit_plan',
      'list_directory',
      'search_symbol',
      'lsp',
      'fetch_url',
      'create_file',
      'git_status',
      'git_commit',
      'git_push',
      'web_search',
      'semantic_search',
      'load_skill',
      'team_task_list',
      'team_task_claim',
      'send_message',
      'read_messages',
      'dispatch_subagent',
      'dispatch_agent',
      'dispatch_subagents',
      'dispatch_agents',
      'run_pipeline',
    ])
  })
})

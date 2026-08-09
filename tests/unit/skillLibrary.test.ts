/**
 * 单元测试: SkillLibrary（Agent Skills 标准对齐）+ load_skill 工具 + 技能元数据注入
 * 覆盖：目录式/扁平技能解析、active 元数据过滤、正文按需加载（L2）、
 * 插件技能目录合并（项目级优先）、registry load_skill 行为、Assembler 注入。
 */

import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { MemoryStore } from '../../src/memory/MemoryStore'
import { SkillLibrary } from '../../src/agent/SkillLibrary'
import { TokenBudget } from '../../src/context/TokenBudget'
import { ContextAssembler } from '../../src/context/Assembler'
import { createToolRegistry } from '../../src/tools/registry'
import type { ProjectRules } from '../../src/agent/types'

// 注意：本文件依赖真实 Assembler/tools/registry，而 orchestrator.test.ts 的 mock.module
// 会跨文件泄漏（bun 已知限制 oven-sh/bun#7823），因此本文件必须独立进程运行
// （见 package.json test:unit:skillplugin），聚合套件通过测试名前缀 "SkillPlugin" 排除。

const tmpRoot = mkdtempSync(join(tmpdir(), 'nexus-skill-'))
const store = new MemoryStore(tmpRoot)

function writeFlatSkill(root: string, name: string, description: string, status: string): void {
  const dir = join(root, '.nexus', 'skills')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${description}\nstatus: ${status}\n---\n\n# ${name}\n\n步骤正文`,
    'utf-8',
  )
}

function writeDirSkill(
  root: string,
  name: string,
  description: string,
  opts: { resource?: string } = {},
): void {
  const skillDir = join(root, '.nexus', 'skills', name)
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\nstatus: active\n---\n\n# ${name}\n\n目录式技能正文`,
    'utf-8',
  )
  if (opts.resource) {
    writeFileSync(join(skillDir, opts.resource), 'resource content', 'utf-8')
  }
}

const RULES: ProjectRules = {
  project: { name: 't', language: 'ts', testCommand: 'bun test', buildCommand: 'bun run build' },
  style: { indent: 2, quote: 'single', semicolons: false },
  constraints: {},
  context: { alwaysInclude: [] },
}

function safeRm(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    /* Windows WAL 残留无害 */
  }
}

afterAll(() => {
  store.close()
  safeRm(tmpRoot)
})

describe('SkillPlugin: SkillLibrary 技能解析', () => {
  it('扁平技能：解析 front-matter，默认 candidate 不进 active 元数据', () => {
    const root = join(tmpRoot, 'flat-proj')
    writeFlatSkill(root, 'fix-tests', '修复测试失败的标准流程', 'candidate')
    const lib = new SkillLibrary(root, store)

    const files = lib.listSkillFiles()
    expect(files.length).toBe(1)
    expect(files[0].name).toBe('fix-tests')
    expect(files[0].description).toBe('修复测试失败的标准流程')
    expect(files[0].status).toBe('candidate')

    // candidate 不注入上下文（未验证技能不直接生效的安全原则）
    expect(lib.listActiveSkillMeta().length).toBe(0)
  })

  it('目录式技能：SKILL.md 入口 + 资源标记 + active 默认可发现', () => {
    const root = join(tmpRoot, 'dir-proj')
    writeDirSkill(root, 'deploy-flow', '部署流程', { resource: 'checklist.md' })
    const lib = new SkillLibrary(root, store)

    const files = lib.listSkillFiles()
    expect(files.length).toBe(1)
    expect(files[0].name).toBe('deploy-flow')
    expect(files[0].status).toBe('active')
    expect(files[0].hasResources).toBe(true)

    const meta = lib.listActiveSkillMeta()
    expect(meta.length).toBe(1)
    expect(meta[0].name).toBe('deploy-flow')
  })

  it('readSkillBody：去 front-matter 返回正文，目录式附带资源清单（L3 入口）', () => {
    const root = join(tmpRoot, 'body-proj')
    writeDirSkill(root, 'deploy-flow', '部署流程', { resource: 'checklist.md' })
    const lib = new SkillLibrary(root, store)

    const body = lib.readSkillBody('deploy-flow')
    expect(body).not.toBeNull()
    expect(body).toContain('目录式技能正文')
    expect(body).not.toContain('---\nname:')
    expect(body).toContain('checklist.md')
    expect(body).toContain('read_file')

    expect(lib.readSkillBody('not-exist')).toBeNull()
  })

  it('插件技能目录合并：项目级同名技能优先', () => {
    const projRoot = join(tmpRoot, 'merge-proj')
    const pluginSkillsRoot = join(tmpRoot, 'merge-plugin-skills')
    writeFlatSkill(projRoot, 'shared-skill', '项目级版本', 'active')
    // 插件侧用目录式技能模拟（放在裸技能根目录下）
    mkdirSync(join(pluginSkillsRoot, 'shared-skill'), { recursive: true })
    writeFileSync(
      join(pluginSkillsRoot, 'shared-skill', 'SKILL.md'),
      '---\nname: shared-skill\ndescription: 插件级版本\nstatus: active\n---\n\n插件正文',
      'utf-8',
    )
    mkdirSync(join(pluginSkillsRoot, 'plugin-only'), { recursive: true })
    writeFileSync(
      join(pluginSkillsRoot, 'plugin-only', 'SKILL.md'),
      '---\nname: plugin-only\ndescription: 仅插件提供\nstatus: active\n---\n\n插件独有',
      'utf-8',
    )

    const lib = new SkillLibrary(projRoot, store)
    lib.addSkillsDir(pluginSkillsRoot)

    const meta = lib.listActiveSkillMeta()
    const shared = meta.find((s) => s.name === 'shared-skill')
    expect(shared?.description).toBe('项目级版本') // 项目级优先
    expect(meta.some((s) => s.name === 'plugin-only')).toBe(true)

    // 项目级正文生效
    expect(lib.readSkillBody('shared-skill')).toContain('步骤正文')
  })
})

describe('SkillPlugin: load_skill 工具（渐进式披露 L2）', () => {
  it('未注入读取器时报错', async () => {
    const registry = createToolRegistry()
    const result = await registry.execute(
      'load_skill',
      { name: 'x' },
      { projectRoot: tmpRoot, callId: 'c1', maxReadLines: 100, maxOutputBytes: 1024, bashTimeout: 5, todos: [] },
    )
    expect(result.error).toContain('技能库未初始化')
  })

  it('注入读取器后返回技能正文；技能不存在时列出可用技能', async () => {
    const registry = createToolRegistry()
    registry.setSkillReader({
      listActiveSkillMeta: () => [
        { name: 'commit-flow', description: '提交流程', hasResources: false },
      ],
      readSkillBody: (name: string) => (name === 'commit-flow' ? '技能正文ABC' : null),
    })
    const ctx = {
      projectRoot: tmpRoot,
      callId: 'c2',
      maxReadLines: 100,
      maxOutputBytes: 1024,
      bashTimeout: 5,
      todos: [],
    }

    const ok = await registry.execute('load_skill', { name: 'commit-flow' }, ctx)
    expect(ok.error).toBeUndefined()
    expect(ok.result).toContain('技能正文ABC')

    const missing = await registry.execute('load_skill', { name: 'nope' }, ctx)
    expect(missing.error).toContain('不存在或未激活')
    expect(missing.error).toContain('commit-flow')
  })
})

describe('SkillPlugin: Assembler 技能元数据注入（L1 发现层）', () => {
  it('active 技能元数据进入系统提示，candidate 不进入', async () => {
    const assembler = new ContextAssembler({
      projectRoot: tmpdir(),
      rules: RULES,
      tools: [],
      budget: new TokenBudget(100000, 0.8),
      recentTurnsKeep: 5,
    })
    assembler.setSkillProvider({
      listActiveSkillMeta: () => [
        { name: 'deploy-flow', description: '部署时使用', hasResources: true },
      ],
      readSkillBody: () => null,
    })

    const prompt = await assembler.buildSystemPrompt()
    expect(prompt).toContain('可用技能')
    expect(prompt).toContain('deploy-flow')
    expect(prompt).toContain('load_skill')
  })

  it('无技能时不注入区块', async () => {
    const assembler = new ContextAssembler({
      projectRoot: tmpdir(),
      rules: RULES,
      tools: [],
      budget: new TokenBudget(100000, 0.8),
      recentTurnsKeep: 5,
    })
    const prompt = await assembler.buildSystemPrompt()
    expect(prompt).not.toContain('可用技能')
  })
})

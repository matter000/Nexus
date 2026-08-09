/**
 * 单元测试: TokenBudget 和 Compressor
 */

import { describe, it, expect } from 'bun:test'
import { mkdtemp, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { estimateTokens, TokenBudget } from '../../src/context/TokenBudget'
import { compressHistory, compressSingleToolResult } from '../../src/context/Compressor'
import { ContextAssembler } from '../../src/context/Assembler'
import { formatRulesForPrompt, loadRules } from '../../src/context/RulesLoader'
import type { CodeGraph } from '../../src/context/CodeGraph'
import type { ChatMessage, ProjectRules } from '../../src/agent/types'

const MINIMAL_RULES: ProjectRules = {
  project: { name: 't', language: 'ts', testCommand: 'bun test', buildCommand: 'bun run build' },
  style: { indent: 2, quote: 'single', semicolons: false },
  constraints: {},
  context: { alwaysInclude: [] },
}

describe('TokenBudget', () => {
  describe('estimateTokens', () => {
    it('空字符串返回 0', () => {
      expect(estimateTokens('')).toBe(0)
    })

    it('英文文本估算合理', () => {
      const tokens = estimateTokens('Hello, world! This is a test.')
      expect(tokens).toBeGreaterThan(0)
      expect(tokens).toBeLessThan(20)
    })

    it('中文文本估算合理', () => {
      const tokens = estimateTokens('你好世界，这是一个测试。')
      expect(tokens).toBeGreaterThan(0)
      expect(tokens).toBeLessThan(20)
    })

    it('长文本 token 数大于短文本', () => {
      const short = estimateTokens('hi')
      const long = estimateTokens('This is a much longer text that should have more tokens than the short one.')
      expect(long).toBeGreaterThan(short)
    })
  })

  describe('TokenBudget class', () => {
    it('正确计算输入预算', () => {
      const budget = new TokenBudget(200000, 0.8, 4096)
      const inputBudget = budget.getInputBudget()
      // 200000 * 0.8 - 4096 = 155904
      expect(inputBudget).toBe(155904)
    })

    it('正确分配各层预算', () => {
      const budget = new TokenBudget(200000, 0.8, 4096)
      const allocation = budget.allocate()
      expect(allocation.systemPrompt).toBeGreaterThan(0)
      expect(allocation.history).toBeGreaterThan(0)
      expect(allocation.reserved).toBe(4096)
      // 各层之和应接近输入预算(Math.floor 可能导致 1-2 token 误差)
      const sum = allocation.systemPrompt + allocation.history
      expect(Math.abs(sum - budget.getInputBudget())).toBeLessThanOrEqual(2)
    })

    it('正确判断超预算', () => {
      const budget = new TokenBudget(1000, 0.8, 100)
      // 输入预算 = 1000 * 0.8 - 100 = 700
      expect(budget.isOverBudget(600)).toBe(false)
      expect(budget.isOverBudget(800)).toBe(true)
    })

    it('正确计算溢出量', () => {
      const budget = new TokenBudget(1000, 0.8, 100)
      expect(budget.getOverflow(600)).toBe(0)
      expect(budget.getOverflow(800)).toBe(100) // 800 - 700
    })
  })
})

describe('Compressor', () => {
  describe('compressHistory', () => {
    it('短历史不压缩', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      ]
      const result = compressHistory(messages, 5, 10000)
      expect(result.messages.length).toBe(2)
      expect(result.compressedCount).toBe(0)
    })

    it('长历史触发压缩', () => {
      const messages: ChatMessage[] = []
      for (let i = 0; i < 30; i++) {
        messages.push({ role: 'user', content: `Message ${i} with some content to fill space` })
        messages.push({ role: 'assistant', content: `Response ${i} with some content` })
      }
      const result = compressHistory(messages, 3, 500)
      expect(result.messages.length).toBeLessThan(messages.length)
      expect(result.compressedCount).toBeGreaterThan(0)
    })
  })

  describe('compressSingleToolResult', () => {
    it('错误结果完整保留', () => {
      const error = 'File not found: src/missing.ts'
      const result = compressSingleToolResult('read_file', error, true)
      expect(result).toBe(error)
    })

    it('read_file 成功结果压缩', () => {
      const content = 'src/index.ts (100 行)\n1│import express from "express"\n2│const app = express()\n3│app.listen(3000)'
      const result = compressSingleToolResult('read_file', content, false)
      expect(result).toContain('已读取')
      expect(result.length).toBeLessThan(content.length)
    })

    it('bash 成功结果压缩', () => {
      const content = '$ bun test\nExit code: 0\n\nAll tests passed!\nDone in 1.2s'
      const result = compressSingleToolResult('bash', content, false)
      expect(result).toContain('Exit code: 0')
    })
  })
})

describe('Assembler 预算动态化', () => {
  it('system 用不满的部分回流 history：超静态预算的历史不被压缩', () => {
    // 窗口 10000 / ratio 1 / 预留 0 → 输入预算 10000：system 2500，history 静态 7500
    const budget = new TokenBudget(10000, 1, 0)
    const assembler = new ContextAssembler({
      projectRoot: tmpdir(),
      rules: MINIMAL_RULES,
      tools: [],
      budget,
      recentTurnsKeep: 5,
    })

    // 20 轮 × 200 token ≈ 8000 token：超静态 history 预算 7500，
    // 但 system 实际占用远小于 2500，回流后动态预算应容纳全量历史
    const history: ChatMessage[] = []
    for (let i = 0; i < 20; i++) {
      history.push({ role: 'user', content: `U${i} ${'x'.repeat(796)}` })
      history.push({ role: 'assistant', content: `A${i} ${'y'.repeat(796)}` })
    }

    const result = assembler.assembleMessages('sys', history, '新问题')

    // 未触发压缩：无历史摘要标记，全量历史保留（+ system + 当前问题）
    expect(result.some((m) => m.content.includes('[历史摘要'))).toBe(false)
    expect(result.length).toBe(history.length + 2)
  })

  it('历史占用低时代码地图注入预算更大（新会话首轮收益）', () => {
    const budget = new TokenBudget(10000, 1, 0)
    const assembler = new ContextAssembler({
      projectRoot: tmpdir(),
      rules: MINIMAL_RULES,
      tools: [],
      budget,
      recentTurnsKeep: 5,
    })

    // 构造超大代码地图，追使截断逻辑生效，从截断量反推注入预算
    const files = new Map()
    for (let i = 0; i < 300; i++) {
      files.set(`src/mod${i}.ts`, {
        filePath: `src/mod${i}.ts`,
        symbols: [
          {
            name: `func${i}`,
            kind: 'function' as const,
            filePath: `src/mod${i}.ts`,
            startLine: 1,
            endLine: 50,
            signature: `export function func${i}(a: number, b: string): boolean`,
            exports: true,
          },
        ],
        imports: [],
        lineCount: 50,
      })
    }
    const graph: CodeGraph = { files, symbolIndex: new Map(), dependencyGraph: new Map() }
    assembler.setCodeGraph(graph)

    return Promise.all([
      assembler.buildSystemPrompt([], undefined, 0), // 新会话：历史占用 0
      assembler.buildSystemPrompt([], undefined, 7000), // 高历史占用（>50% 预算）
    ]).then(([lowHistoryPrompt, highHistoryPrompt]) => {
      // 低历史占用时地图预算得到补贴，注入的地图内容更多
      expect(estimateTokens(lowHistoryPrompt)).toBeGreaterThan(estimateTokens(highHistoryPrompt))
    })
  })
})

describe('Assembler stable/dynamic 拆分（前缀缓存友好）', () => {
  const budget = new TokenBudget(100000, 1, 0)
  const makeAssembler = () =>
    new ContextAssembler({
      projectRoot: tmpdir(),
      rules: MINIMAL_RULES,
      tools: [],
      budget,
      recentTurnsKeep: 5,
    })

  it('stable 段含基础指令与规则，不含 todos/git 等逐轮变化内容', async () => {
    const assembler = makeAssembler()
    const { stable, dynamic } = await assembler.buildSystemPromptParts(
      [{ id: '1', content: '实现功能 X', status: 'pending' }],
      undefined,
    )
    expect(stable).toContain('Nexus')
    expect(stable).toContain('项目信息')
    // todos 属于逐轮变化内容，必须落在 dynamic 段保护缓存前缀
    expect(stable).not.toContain('实现功能 X')
    expect(dynamic).toContain('实现功能 X')
  })

  it('buildSystemPrompt 与拆分版拼接结果一致（兼容旧调用方）', async () => {
    const assembler = makeAssembler()
    const [full, parts] = await Promise.all([
      assembler.buildSystemPrompt(),
      assembler.buildSystemPromptParts(),
    ])
    expect(full).toBe(parts.dynamic ? `${parts.stable}\n${parts.dynamic}` : parts.stable)
  })

  it('assembleMessagesSplit 输出双 system 消息且 stable 在前', () => {
    const assembler = makeAssembler()
    const messages = assembler.assembleMessagesSplit('STABLE-PART', 'DYNAMIC-PART', [], '问题')
    const systemMsgs = messages.filter((m) => m.role === 'system')
    expect(systemMsgs.length).toBe(2)
    expect(systemMsgs[0].content).toBe('STABLE-PART')
    expect(systemMsgs[1].content).toBe('DYNAMIC-PART')
    expect(messages[messages.length - 1]).toEqual({ role: 'user', content: '问题' })
  })

  it('assembleMessagesSplit dynamic 为空时只输出单 system 消息', () => {
    const assembler = makeAssembler()
    const messages = assembler.assembleMessagesSplit('STABLE', '', [], '问题')
    expect(messages.filter((m) => m.role === 'system').length).toBe(1)
  })
})

describe('RulesLoader AGENTS.md 接入', () => {
  it('项目根存在 AGENTS.md 时注入 prompt 且无 rules.toml 也不报错', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nexus-agentsmd-'))
    await writeFile(join(dir, 'AGENTS.md'), '# 协作指南\n修改前必须跑测试')
    const rules = await loadRules(dir)
    expect(rules.agentsMd).toContain('修改前必须跑测试')
    const prompt = formatRulesForPrompt(rules)
    expect(prompt).toContain('项目协作指南 (AGENTS.md)')
    expect(prompt).toContain('修改前必须跑测试')
  })

  it('无 AGENTS.md 时 agentsMd 为 undefined 且 prompt 无该段落', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nexus-noagents-'))
    const rules = await loadRules(dir)
    expect(rules.agentsMd).toBeUndefined()
    expect(formatRulesForPrompt(rules)).not.toContain('AGENTS.md')
  })

  it('超大 AGENTS.md 被截断到 token 上限（防稀释 L1）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nexus-bigagents-'))
    await writeFile(join(dir, 'AGENTS.md'), 'x'.repeat(20000))
    const rules = await loadRules(dir)
    expect(rules.agentsMd).toBeDefined()
    expect(rules.agentsMd).toContain('已截断')
    // 2000 token × 4 字符/token + 截断标记，不应远超此上限
    expect(rules.agentsMd?.length ?? 0).toBeLessThan(8100)
  })
})

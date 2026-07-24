/**
 * Eval Harness - SWE-bench 风格小任务评估
 * 从 Phase 1 就建,每 phase 都跑
 * 10-20 个小任务:单文件改、多文件改、修 bug、加测试、重构
 *
 * Mock 模式（无 API Key）：验证场景定义完整性 + 框架本身可运行
 * 真实模式（有 API Key）：调用 Orchestrator.submit() 执行完整 eval
 */

import { describe, it, expect } from 'bun:test'
import { mkdtemp, writeFile, readFile, rm, readdir, stat, mkdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

// ─── EvalTask 接口 ─────────────────────────────────────────────────────────────

interface EvalTask {
  id: string
  name: string
  category: 'single-file' | 'multi-file' | 'bug-fix' | 'add-test' | 'refactor'
  difficulty: 'easy' | 'medium' | 'hard'
  description: string
  /** 初始文件状态（相对路径 → 内容） */
  initialFiles: Record<string, string>
  /** 用户请求 */
  userRequest: string
  /** 验证函数：检查执行结果 */
  validate: (dir: string) => Promise<{ pass: boolean; reason?: string }>
}

// ─── 辅助函数 ──────────────────────────────────────────────────────────────────

/** 递归列出目录下所有文件（返回相对路径） */
async function listAllFiles(dir: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      files.push(...(await listAllFiles(join(dir, entry.name), rel)))
    } else {
      files.push(rel)
    }
  }
  return files
}

/** 在目录中查找匹配 glob 模式的文件 */
async function findFiles(dir: string, pattern: RegExp): Promise<string[]> {
  const all = await listAllFiles(dir)
  return all.filter(f => pattern.test(f))
}

/** 安全读取文件内容，不存在则返回 null */
async function safeReadFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8')
  } catch {
    return null
  }
}

/** 写入初始文件到临时目录（自动创建子目录） */
async function writeInitialFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [relPath, content] of Object.entries(files)) {
    const parts = relPath.split('/')
    const fullPath = join(dir, ...parts)
    if (parts.length > 1) {
      await mkdir(join(dir, ...parts.slice(0, -1)), { recursive: true })
    }
    await writeFile(fullPath, content, 'utf-8')
  }
}


// ─── Eval 场景定义 ─────────────────────────────────────────────────────────────

const EVAL_TASKS: EvalTask[] = [
  // ── (a) 单文件修改：重命名函数 ──
  {
    id: 'eval-001',
    name: '重命名函数',
    category: 'single-file',
    difficulty: 'easy',
    description: '将 math.ts 中的 add 函数重命名为 sum，并更新所有调用处',
    initialFiles: {
      'src/math.ts': `export function add(a: number, b: number): number {
  return a + b
}

export function subtract(a: number, b: number): number {
  return a - b
}

export function multiply(a: number, b: number): number {
  return add(a, b) // 内部调用 add
}
`,
      'src/main.ts': `import { add, subtract, multiply } from './math'

console.log(add(1, 2))
console.log(subtract(5, 3))
console.log(multiply(2, 3))
`,
    },
    userRequest: '把 add 函数重命名为 sum，并更新所有引用处',
    validate: async (dir: string) => {
      const mathContent = await safeReadFile(join(dir, 'src', 'math.ts'))
      if (!mathContent) return { pass: false, reason: 'src/math.ts 不存在' }

      if (mathContent.includes('function add(') || mathContent.includes('function add ')) {
        return { pass: false, reason: 'src/math.ts 中仍包含 function add' }
      }
      if (!mathContent.includes('function sum(') && !mathContent.includes('function sum ')) {
        return { pass: false, reason: 'src/math.ts 中未找到 function sum' }
      }

      const mainContent = await safeReadFile(join(dir, 'src', 'main.ts'))
      if (mainContent && mainContent.includes('add(') && !mainContent.includes('sum(')) {
        return { pass: false, reason: 'src/main.ts 中仍有未更新的 add 调用' }
      }

      return { pass: true }
    },
  },

  // ── (b) 多文件修改：添加导出并更新导入 ──
  {
    id: 'eval-002',
    name: '添加导出并更新导入',
    category: 'multi-file',
    difficulty: 'medium',
    description: '在 utils.ts 中添加 formatDate 函数并在 index.ts 中导入使用',
    initialFiles: {
      'src/utils.ts': `export function formatName(name: string): string {
  return name.trim().toLowerCase()
}

export function formatAge(age: number): string {
  return \`\${age} years old\`
}
`,
      'src/index.ts': `import { formatName, formatAge } from './utils'

export function greet(name: string, age: number): string {
  return \`Hello, \${formatName(name)}! You are \${formatAge(age)}.\`
}
`,
    },
    userRequest: '在 utils.ts 中添加一个 formatDate 函数（接受 Date 返回 YYYY-MM-DD 字符串），并在 index.ts 中导入使用它来格式化当前日期',
    validate: async (dir: string) => {
      const utilsContent = await safeReadFile(join(dir, 'src', 'utils.ts'))
      if (!utilsContent) return { pass: false, reason: 'src/utils.ts 不存在' }

      if (!utilsContent.includes('formatDate')) {
        return { pass: false, reason: 'src/utils.ts 中未找到 formatDate 函数' }
      }
      if (!utilsContent.includes('export')) {
        return { pass: false, reason: 'formatDate 未被导出' }
      }

      const indexContent = await safeReadFile(join(dir, 'src', 'index.ts'))
      if (!indexContent) return { pass: false, reason: 'src/index.ts 不存在' }

      if (!indexContent.includes('formatDate')) {
        return { pass: false, reason: 'src/index.ts 中未导入 formatDate' }
      }

      return { pass: true }
    },
  },

  // ── (c) Bug 修复：除零错误 ──
  {
    id: 'eval-003',
    name: '修复除零错误',
    category: 'bug-fix',
    difficulty: 'easy',
    description: '修复 calculator.ts 中 divide 函数未检查除零的 bug',
    initialFiles: {
      'src/calculator.ts': `export function divide(a: number, b: number): number {
  return a / b
}

export function safeDivide(a: number, b: number): number {
  return divide(a, b)
}

export function average(numbers: number[]): number {
  const sum = numbers.reduce((acc, n) => acc + n, 0)
  return divide(sum, numbers.length)
}
`,
    },
    userRequest: '修复 divide 函数的除零错误，当除数为 0 时应抛出错误或返回特殊值',
    validate: async (dir: string) => {
      const content = await safeReadFile(join(dir, 'src', 'calculator.ts'))
      if (!content) return { pass: false, reason: 'src/calculator.ts 不存在' }

      // 检查是否有除零检查逻辑
      const hasZeroCheck =
        content.includes('=== 0') ||
        content.includes('== 0') ||
        content.includes('!== 0') ||
        content.includes('!= 0') ||
        content.includes('ZeroDivision') ||
        content.includes('division by zero') ||
        content.includes('除以零') ||
        content.includes('divisor') ||
        content.includes('b === 0') ||
        content.includes('b == 0')

      if (!hasZeroCheck) {
        return { pass: false, reason: '未找到除零检查逻辑' }
      }

      return { pass: true }
    },
  },

  // ── (d) 测试添加：为已有函数写测试 ──
  {
    id: 'eval-004',
    name: '添加单元测试',
    category: 'add-test',
    difficulty: 'medium',
    description: '为 greet.ts 中的 greet 函数添加单元测试',
    initialFiles: {
      'src/greet.ts': `export function greet(name: string): string {
  return \`Hello, \${name}!\`
}

export function farewell(name: string): string {
  return \`Goodbye, \${name}!\`
}

export function welcome(name: string, time: 'morning' | 'afternoon' | 'evening'): string {
  const greetings: Record<string, string> = {
    morning: 'Good morning',
    afternoon: 'Good afternoon',
    evening: 'Good evening',
  }
  return \`\${greetings[time]}, \${name}!\`
}
`,
    },
    userRequest: '为 greet.ts 中的 greet、farewell、welcome 函数添加单元测试，覆盖正常情况和边界情况',
    validate: async (dir: string) => {
      // 查找测试文件
      const testFiles = await findFiles(dir, /(\.test\.|\.spec\.|\/tests?\/|\/__tests__\/)/)

      if (testFiles.length === 0) {
        return { pass: false, reason: '未找到测试文件（需要 *.test.* 或 tests/ 目录）' }
      }

      // 读取所有测试文件内容，检查是否包含对 greet 的测试
      let hasGreetTest = false
      let hasFarewellTest = false

      for (const tf of testFiles) {
        const content = await safeReadFile(join(dir, ...tf.split('/')))
        if (!content) continue

        if (content.includes('greet')) hasGreetTest = true
        if (content.includes('farewell')) hasFarewellTest = true
      }

      if (!hasGreetTest) {
        return { pass: false, reason: '测试文件中未包含对 greet 函数的测试' }
      }
      if (!hasFarewellTest) {
        return { pass: false, reason: '测试文件中未包含对 farewell 函数的测试' }
      }

      return { pass: true }
    },
  },

  // ── (e) 重构：提取公共逻辑 ──
  {
    id: 'eval-005',
    name: '提取公共验证逻辑',
    category: 'refactor',
    difficulty: 'hard',
    description: '将 handlers.ts 中两段重复的验证逻辑提取为公共函数',
    initialFiles: {
      'src/handlers.ts': `interface User {
  name: string
  email: string
  age: number
}

export function handleCreateUser(data: Record<string, unknown>): User {
  // 验证逻辑（重复 A）
  if (!data.name || typeof data.name !== 'string') {
    throw new Error('Invalid name')
  }
  if (!data.email || typeof data.email !== 'string' || !data.email.includes('@')) {
    throw new Error('Invalid email')
  }
  if (!data.age || typeof data.age !== 'number' || data.age < 0 || data.age > 150) {
    throw new Error('Invalid age')
  }

  return { name: data.name as string, email: data.email as string, age: data.age as number }
}

export function handleUpdateUser(existing: User, data: Record<string, unknown>): User {
  // 验证逻辑（重复 B - 与 A 几乎相同）
  if (!data.name || typeof data.name !== 'string') {
    throw new Error('Invalid name')
  }
  if (!data.email || typeof data.email !== 'string' || !data.email.includes('@')) {
    throw new Error('Invalid email')
  }
  if (!data.age || typeof data.age !== 'number' || data.age < 0 || data.age > 150) {
    throw new Error('Invalid age')
  }

  return { name: data.name as string, email: data.email as string, age: data.age as number }
}
`,
    },
    userRequest: '提取 handlers.ts 中 handleCreateUser 和 handleUpdateUser 重复的验证逻辑为一个公共函数 validateUser，然后在两个 handler 中调用它',
    validate: async (dir: string) => {
      const content = await safeReadFile(join(dir, 'src', 'handlers.ts'))
      if (!content) return { pass: false, reason: 'src/handlers.ts 不存在' }

      // 检查是否提取了公共验证函数
      const hasExtractedFunction =
        content.includes('function validateUser') ||
        content.includes('function validateUserData') ||
        content.includes('const validateUser') ||
        content.includes('export function validate')

      if (!hasExtractedFunction) {
        return { pass: false, reason: '未找到提取出的公共验证函数' }
      }

      // 检查两个 handler 是否调用了公共函数
      const handlerCreateCalls = content.includes('handleCreateUser') &&
        (content.includes('validateUser(') || content.includes('validateUserData(') || content.includes('validate('))
      const handlerUpdateCalls = content.includes('handleUpdateUser') &&
        (content.includes('validateUser(') || content.includes('validateUserData(') || content.includes('validate('))

      if (!handlerCreateCalls || !handlerUpdateCalls) {
        return { pass: false, reason: 'handler 函数未调用提取出的公共验证函数' }
      }

      return { pass: true }
    },
  },
]

// ─── Eval 框架 ─────────────────────────────────────────────────────────────────

interface EvalResult {
  pass: boolean
  reason?: string
  duration?: number
  mode: 'mock' | 'real'
}

/** 验证场景定义的完整性（mock 模式） */
async function validateScenarioDefinition(task: EvalTask, tmpDir: string): Promise<EvalResult> {
  const errors: string[] = []

  // 1. 检查基本字段
  if (!task.id) errors.push('缺少 id')
  if (!task.description || task.description.length === 0) errors.push('description 为空')
  if (!task.userRequest || task.userRequest.length === 0) errors.push('userRequest 为空')

  // 2. 检查初始文件非空
  const fileEntries = Object.entries(task.initialFiles)
  if (fileEntries.length === 0) {
    errors.push('initialFiles 为空')
  }
  for (const [path, content] of fileEntries) {
    if (!path) errors.push('存在空文件路径')
    if (!content || content.trim().length === 0) {
      errors.push(`文件 ${path} 内容为空`)
    }
  }

  // 3. 验证 validate 函数可执行（在临时目录上运行）
  try {
    const result = await task.validate(tmpDir)
    if (typeof result.pass !== 'boolean') {
      errors.push('validate 返回值缺少 pass 字段')
    }
  } catch (err) {
    errors.push(`validate 函数执行异常: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (errors.length > 0) {
    return { pass: false, reason: errors.join('; '), mode: 'mock' }
  }

  return { pass: true, mode: 'mock' }
}

/** 运行单个 eval 任务 */
async function runEval(task: EvalTask): Promise<EvalResult> {
  const startTime = Date.now()
  const tmpDir = await mkdtemp(join(tmpdir(), `nexus-eval-${task.id}-`))

  try {
    // 1. 写入初始文件
    for (const [relPath, content] of Object.entries(task.initialFiles)) {
      const parts = relPath.split('/')
      const fullPath = join(tmpDir, ...parts)

      // 确保父目录存在
      if (parts.length > 1) {
        await mkdir(join(tmpDir, ...parts.slice(0, -1)), { recursive: true })
      }
      await writeFile(fullPath, content, 'utf-8')
    }

    // 2. 判断运行模式
    const hasApiKey = !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY)

    if (hasApiKey) {
      // ── 真实模式：调用 Orchestrator ──
      // 动态导入避免无 Key 时的依赖问题
      const { Orchestrator } = await import('../../src/agent/Orchestrator')
      const { loadConfig } = await import('../../src/config')

      const config = await loadConfig(tmpDir)
      const orchestrator = new Orchestrator({
        projectRoot: tmpDir,
        config,
        permissionMode: 'auto-all',
        skipPlan: true,
        maxIterations: 10,
        onEvent: () => {},
        requestApproval: async () => true,
        requestPlanApproval: async () => 'approve' as const,
      })

      await orchestrator.init()
      await orchestrator.submit(task.userRequest)
      await orchestrator.shutdown()

      // 验证结果
      const result = await task.validate(tmpDir)
      return {
        ...result,
        duration: Date.now() - startTime,
        mode: 'real',
      }
    } else {
      // ── Mock 模式：验证场景定义完整性 ──
      const result = await validateScenarioDefinition(task, tmpDir)
      return {
        ...result,
        duration: Date.now() - startTime,
      }
    }
  } finally {
    // 4. 清理临时目录
    try {
      await rm(tmpDir, { recursive: true, force: true })
    } catch {
      // 清理失败不阻塞测试
    }
  }
}

// ─── 测试套件 ──────────────────────────────────────────────────────────────────

describe('Eval Harness', () => {
  it('eval 任务列表已定义且数量合理', () => {
    expect(EVAL_TASKS.length).toBeGreaterThanOrEqual(5)
  })

  it('所有 eval 任务 id 唯一', () => {
    const ids = EVAL_TASKS.map(t => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('所有 eval 任务类别有效', () => {
    const validCategories = new Set(['single-file', 'multi-file', 'bug-fix', 'add-test', 'refactor'])
    for (const task of EVAL_TASKS) {
      expect(validCategories.has(task.category)).toBe(true)
    }
  })

  for (const task of EVAL_TASKS) {
    it(`[${task.category}] ${task.id}: ${task.name}`, async () => {
      const result = await runEval(task)

      if (!result.pass) {
        const modeLabel = result.mode === 'mock' ? 'mock' : 'real'
        throw new Error(`[${modeLabel}] Eval 失败: ${result.reason ?? '未知原因'}`)
      }

      expect(result.pass).toBe(true)
    })
  }

  // ── 框架自检测试 ──

  it('临时目录创建和清理正常工作', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'nexus-eval-selftest-'))
    const testFile = join(tmpDir, 'test.txt')
    await writeFile(testFile, 'hello', 'utf-8')

    const content = await readFile(testFile, 'utf-8')
    expect(content).toBe('hello')

    await rm(tmpDir, { recursive: true, force: true })

    // 目录应已被删除
    try {
      await stat(tmpDir)
      throw new Error('临时目录未被清理')
    } catch (err: unknown) {
      // ENOENT 表示目录已不存在，符合预期
      const code = (err as NodeJS.ErrnoException).code
      expect(code).toBe('ENOENT')
    }
  })

  it('writeInitialFiles 正确创建嵌套文件', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'nexus-eval-selftest-'))
    try {
      await writeInitialFiles(tmpDir, {
        'src/deep/nested.ts': 'export const x = 1',
        'root.ts': 'export const y = 2',
      })

      const nested = await safeReadFile(join(tmpDir, 'src', 'deep', 'nested.ts'))
      expect(nested).toBe('export const x = 1')

      const root = await safeReadFile(join(tmpDir, 'root.ts'))
      expect(root).toBe('export const y = 2')
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('validate 函数在初始文件上应返回 pass:false（未被修改时）', async () => {
    // 对于重命名任务，未修改的文件不应通过验证
    const tmpDir = await mkdtemp(join(tmpdir(), 'nexus-eval-selftest-'))
    try {
      const renameTask = EVAL_TASKS.find(t => t.id === 'eval-001')!
      for (const [relPath, content] of Object.entries(renameTask.initialFiles)) {
        const parts = relPath.split('/')
        if (parts.length > 1) {
          await mkdir(join(tmpDir, ...parts.slice(0, -1)), { recursive: true })
        }
        await writeFile(join(tmpDir, ...parts), content, 'utf-8')
      }

      const result = await renameTask.validate(tmpDir)
      // 初始文件仍含 function add，验证应失败
      expect(result.pass).toBe(false)
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })
})

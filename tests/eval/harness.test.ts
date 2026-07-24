/**
 * Eval Harness - SWE-bench 风格小任务评估
 * 从 Phase 1 就建,每 phase 都跑
 * 10-20 个小任务:单文件改、多文件改、修 bug、加测试
 */

import { describe, it, expect } from 'bun:test'

/**
 * Eval 任务定义
 * 每个任务包含:初始文件状态、用户指令、期望结果
 */
interface EvalTask {
  id: string
  name: string
  category: 'single-file' | 'multi-file' | 'bug-fix' | 'add-test'
  difficulty: 'easy' | 'medium' | 'hard'
  description: string
  // TODO: 添加 setup/teardown/assert 逻辑
}

const EVAL_TASKS: EvalTask[] = [
  {
    id: 'eval-001',
    name: '重命名函数',
    category: 'single-file',
    difficulty: 'easy',
    description: '将 utils.ts 中的 calculateTotal 重命名为 computeSum,并更新所有调用处',
  },
  {
    id: 'eval-002',
    name: '添加类型注解',
    category: 'single-file',
    difficulty: 'easy',
    description: '给一个 JS 文件添加 TypeScript 类型注解',
  },
  {
    id: 'eval-003',
    name: '修复 off-by-one 错误',
    category: 'bug-fix',
    difficulty: 'medium',
    description: '修复数组遍历中的 off-by-one 错误',
  },
  {
    id: 'eval-004',
    name: '跨文件重构',
    category: 'multi-file',
    difficulty: 'hard',
    description: '将一个 class 拆分为两个,更新所有 import',
  },
  {
    id: 'eval-005',
    name: '添加单元测试',
    category: 'add-test',
    difficulty: 'medium',
    description: '为一个工具函数添加边界条件测试',
  },
]

describe('Eval Harness', () => {
  it('eval 任务列表已定义', () => {
    expect(EVAL_TASKS.length).toBeGreaterThan(0)
  })

  // TODO: Phase 1 完成后,实现真正的 eval 执行逻辑
  // 每个 eval 任务:
  // 1. 创建临时目录,写入初始文件
  // 2. 调用 Orchestrator.submit(任务描述)
  // 3. 验证最终文件状态
  // 4. 检查 diff 干净度(不改无关文件)
  // 5. 记录通过率和 token 消耗

  for (const task of EVAL_TASKS) {
    it(`[placeholder] ${task.id}: ${task.name}`, () => {
      // Placeholder - 实际 eval 需要 LLM API key
      expect(task.description.length).toBeGreaterThan(0)
    })
  }
})

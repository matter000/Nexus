/**
 * 反思引擎（方向二：学习的提炼引擎）
 * 会话结束时用 summarizer 档模型对任务轨迹做反思，
 * 产出结构化的 candidate 教训。原始轨迹直接喂给下次任务价值低，
 * 必须提炼为"当 X 时应 Y"的可泛化表述（剥离具体路径/变量名，防过拟合）。
 */

import { generateText, type LanguageModel } from 'ai'
import type { FailurePattern } from '../memory/TraceStore'
import type { Experience, LessonKind } from '../memory/types'

/** 单次反思最多处理的经验条数（防 prompt 膨胀） */
export const MAX_EXPERIENCES_PER_REFLECTION = 5
/** 单次反思最多产出的教训条数（防记忆库膨胀） */
export const MAX_LESSONS_PER_REFLECTION = 3

export interface ReflectedLesson {
  triggerDesc: string
  advice: string
  kind: LessonKind
}

/**
 * 容错解析 LLM 反思输出。
 * 提取第一个 JSON 数组（允许 LLM 在数组前后输出多余文字），
 * 逐条校验字段合法性，畸形条目直接丢弃。纯函数导出便于单测。
 */
export function parseReflectedLessons(text: string): ReflectedLesson[] {
  if (!text) return []

  // 提取首个 [ ... ] 块（跨行）
  const match = text.match(/\[[\s\S]*\]/)
  if (!match) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(match[0])
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const lessons: ReflectedLesson[] = []
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue
    const obj = item as Record<string, unknown>
    const triggerDesc = typeof obj.triggerDesc === 'string' ? obj.triggerDesc.trim() : ''
    const advice = typeof obj.advice === 'string' ? obj.advice.trim() : ''
    const kind = obj.kind === 'success_strategy' ? 'success_strategy' : 'failure_pattern'
    if (!triggerDesc || !advice) continue
    lessons.push({ triggerDesc, advice, kind })
    if (lessons.length >= MAX_LESSONS_PER_REFLECTION) break
  }
  return lessons
}

export class Reflector {
  private model: LanguageModel

  constructor(model: LanguageModel) {
    this.model = model
  }

  /**
   * 对一批经验做反思，产出候选教训。
   * LLM 调用失败时返回空数组（学习是旁路增强，绝不阻塞主流程）。
   */
  async reflect(experiences: Experience[]): Promise<ReflectedLesson[]> {
    const batch = experiences.slice(0, MAX_EXPERIENCES_PER_REFLECTION)
    if (batch.length === 0) return []

    const experienceText = batch
      .map((exp, i) => {
        const parts = [`[经验${i + 1}] 任务: ${exp.summary}`, `结果: ${exp.outcome}`]
        if (exp.toolSequence) parts.push(`工具序列: ${exp.toolSequence}`)
        if (exp.errorLabel) parts.push(`错误类型: ${exp.errorLabel}`)
        return parts.join(' | ')
      })
      .join('\n')

    const prompt = `请从以下 Agent 任务执行经验中提炼可复用的教训。

要求：
1. 只提炼对未来类似任务真正有指导价值的经验，宁缺毋滥（最多 ${MAX_LESSONS_PER_REFLECTION} 条）
2. 表述必须泛化：剥离具体文件路径、变量名、项目特有细节，抽象为通用模式
3. 失败经验提炼为"失败模式"（当 X 场景时做了 Y 导致失败，应先 Z）
4. 成功经验提炼为"成功策略"（某工具组合/执行顺序显著减少了迭代）
5. 若无值得提炼的内容，返回空数组 []

只输出 JSON 数组，不要输出任何其他文字。格式：
[{"triggerDesc": "当...时", "advice": "应该...", "kind": "failure_pattern" | "success_strategy"}]

--- 任务经验 ---
${experienceText}`

    try {
      const result = await generateText({
        model: this.model,
        system: '你是经验提炼助手。从 Agent 执行轨迹中提炼可泛化的教训，输出严格 JSON。',
        messages: [{ role: 'user', content: prompt }],
        maxOutputTokens: 800,
      })
      return parseReflectedLessons(result.text)
    } catch {
      return []
    }
  }

  /**
   * 精化单个循环失败模式的 advice（LLM 提炼），替代 L4 模板化兜底文案。
   * 输入高频失败模式（loop_name + 失败类型 + 次数），产出具体可执行的建议；
   * LLM 调用失败或解析无结果时返回 null（调用方降级为模板 advice，学习是旁路绝不阻塞）。
   */
  async refineLoopPattern(pattern: FailurePattern): Promise<string | null> {
    const prompt = `请为一个在循环任务中反复出现的失败模式，提炼一条具体可执行的建议。

要求：
1. 建议必须针对该失败模式的实际修复路径（如先跑哪个门禁确认基线、失败后检查哪个信号、避免哪种重复无用功）
2. 表述泛化：可提及“证据门禁/验证结论”等通用机制，但不出现具体文件名或一次性细节
3. 只输出一条 advice，不要输出数组以外的文字

--- 失败模式 ---
循环名称: ${pattern.loopName}
失败类型: ${pattern.pattern}
重复次数: ${pattern.count}

只输出 JSON 数组，格式：
[{"advice": "应该..."}]`

    try {
      const result = await generateText({
        model: this.model,
        system: '你是循环任务失败分析助手。从高频失败模式中提炼具体可执行的建议，输出严格 JSON。',
        messages: [{ role: 'user', content: prompt }],
        maxOutputTokens: 400,
      })
      // 轻量解析：精化输出只有 advice 字段（parseReflectedLessons 要求 triggerDesc，不能复用）
      const match = result.text.match(/\[[\s\S]*\]/)
      if (!match) return null
      const parsed: unknown = JSON.parse(match[0])
      if (!Array.isArray(parsed)) return null
      for (const item of parsed) {
        if (typeof item === 'object' && item !== null) {
          const advice = (item as Record<string, unknown>).advice
          if (typeof advice === 'string' && advice.trim()) return advice.trim()
        }
      }
      return null
    } catch {
      return null
    }
  }
}

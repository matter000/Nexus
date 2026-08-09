/**
 * 单元测试: Reflector 反思引擎
 * parseReflectedLessons 容错解析：正常 JSON 数组、畸形输出、条数上限
 */

import { describe, expect, it } from 'bun:test'
import { MAX_LESSONS_PER_REFLECTION, parseReflectedLessons } from '../../src/agent/Reflector'

describe('parseReflectedLessons', () => {
  it('解析正常 JSON 数组', () => {
    const text = JSON.stringify([
      { triggerDesc: '当运行测试失败时', advice: '应先查看断言', kind: 'failure_pattern' },
      { triggerDesc: '当批量修改文件时', advice: '应分步提交', kind: 'success_strategy' },
    ])
    const lessons = parseReflectedLessons(text)
    expect(lessons.length).toBe(2)
    expect(lessons[0].triggerDesc).toBe('当运行测试失败时')
    expect(lessons[0].kind).toBe('failure_pattern')
    expect(lessons[1].kind).toBe('success_strategy')
  })

  it('允许 JSON 前后有多余文字（LLM 常见输出）', () => {
    const text = `以下是提炼结果：
\`\`\`json
[{"triggerDesc": "当接口变更时", "advice": "应同步更新文档", "kind": "failure_pattern"}]
\`\`\`
希望对你有帮助`
    const lessons = parseReflectedLessons(text)
    expect(lessons.length).toBe(1)
    expect(lessons[0].advice).toBe('应同步更新文档')
  })

  it('空字符串或非 JSON 返回空数组', () => {
    expect(parseReflectedLessons('')).toEqual([])
    expect(parseReflectedLessons('没有 JSON 数组')).toEqual([])
    expect(parseReflectedLessons('{"triggerDesc": "对象而非数组"}')).toEqual([])
    expect(parseReflectedLessons('[{"triggerDesc": "未闭合')).toEqual([])
  })

  it('字段缺失或非法的条目被丢弃', () => {
    const text = JSON.stringify([
      { triggerDesc: '合法条目', advice: '正确建议', kind: 'failure_pattern' },
      { triggerDesc: '缺少 advice', kind: 'failure_pattern' },
      { advice: '缺少 trigger', kind: 'failure_pattern' },
      { triggerDesc: 'kind 非法时默认 failure_pattern', advice: '建议内容', kind: 'unknown_kind' },
      '不是对象',
      null,
    ])
    const lessons = parseReflectedLessons(text)
    expect(lessons.length).toBe(2)
    expect(lessons[0].triggerDesc).toBe('合法条目')
    expect(lessons[1].kind).toBe('failure_pattern')
  })

  it('超过上限的教训被截断', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      triggerDesc: `触发条件-${i}`,
      advice: `建议-${i}`,
      kind: 'failure_pattern',
    }))
    const lessons = parseReflectedLessons(JSON.stringify(items))
    expect(lessons.length).toBe(MAX_LESSONS_PER_REFLECTION)
  })
})

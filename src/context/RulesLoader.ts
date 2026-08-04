/**
 * .nexus/rules.toml 加载器
 * 结构化项目约定,可程序化校验和注入
 */

import { readFile } from 'fs/promises'
import { join, resolve } from 'path'
import { parse } from 'smol-toml'
import type { ProjectRules } from '../agent/types'

const DEFAULT_RULES: ProjectRules = {
  project: {
    name: 'Unknown',
    language: 'typescript',
    testCommand: 'bun test',
    buildCommand: 'bun run build',
  },
  style: {
    indent: 2,
    quote: 'single',
    semicolons: false,
  },
  constraints: {},
  context: {
    alwaysInclude: [],
  },
}

/** 加载 .nexus/rules.toml */
export async function loadRules(projectRoot: string): Promise<ProjectRules> {
  const rulesPath = join(projectRoot, '.nexus', 'rules.toml')

  try {
    const content = await readFile(rulesPath, 'utf-8')
    const raw = parse(content) as Record<string, unknown>

    return {
      project: {
        name: (raw.project as Record<string, string>)?.name ?? DEFAULT_RULES.project.name,
        language:
          (raw.project as Record<string, string>)?.language ?? DEFAULT_RULES.project.language,
        testCommand:
          (raw.project as Record<string, string>)?.test_command ??
          DEFAULT_RULES.project.testCommand,
        buildCommand:
          (raw.project as Record<string, string>)?.build_command ??
          DEFAULT_RULES.project.buildCommand,
      },
      style: {
        indent: (raw.style as Record<string, number>)?.indent ?? DEFAULT_RULES.style.indent,
        quote:
          ((raw.style as Record<string, string>)?.quote as 'single' | 'double') ??
          DEFAULT_RULES.style.quote,
        semicolons:
          (raw.style as Record<string, boolean>)?.semicolons ?? DEFAULT_RULES.style.semicolons,
      },
      constraints: (raw.constraints as Record<string, boolean>) ?? {},
      context: {
        alwaysInclude: (raw.context as Record<string, string[]>)?.always_include ?? [],
      },
    }
  } catch {
    // 文件不存在或解析失败,返回默认值
    return DEFAULT_RULES
  }
}

/** 将规则格式化为 system prompt 片段 */
export function formatRulesForPrompt(rules: ProjectRules): string {
  const parts: string[] = []

  parts.push(`## 项目信息`)
  parts.push(`- 项目名: ${rules.project.name}`)
  parts.push(`- 语言: ${rules.project.language}`)
  parts.push(`- 测试命令: ${rules.project.testCommand}`)
  parts.push(`- 构建命令: ${rules.project.buildCommand}`)

  parts.push(`\n## 代码风格`)
  parts.push(`- 缩进: ${rules.style.indent} 空格`)
  parts.push(`- 引号: ${rules.style.quote === 'single' ? '单引号' : '双引号'}`)
  parts.push(`- 分号: ${rules.style.semicolons ? '使用' : '不使用'}`)

  const activeConstraints = Object.entries(rules.constraints).filter(([, v]) => v)
  if (activeConstraints.length > 0) {
    parts.push(`\n## 硬约束(必须遵守)`)
    for (const [constraint] of activeConstraints) {
      parts.push(`- ${constraint}`)
    }
  }

  return parts.join('\n')
}

/** 获取需要常驻包含的文件路径 */
export function getAlwaysIncludePaths(rules: ProjectRules, projectRoot: string): string[] {
  return rules.context.alwaysInclude.map((p) => resolve(projectRoot, p))
}

/**
 * 子智能体引擎配置加载器
 * 从 .nexus/agents.toml 加载用户定义的引擎（覆盖内置或新增），与 config.ts 容错模式一致
 */

import { readFile } from 'fs/promises'
import { join } from 'path'
import { parse } from 'smol-toml'
import type { AgentEngineDef } from './AgentEngine'

/**
 * 加载 .nexus/agents.toml 中的 [[agents]] 配置；
 * 文件缺失、解析失败或无合法条目时返回空数组
 */
export async function loadAgentEngineConfigs(projectRoot: string): Promise<AgentEngineDef[]> {
  const configPath = join(projectRoot, '.nexus', 'agents.toml')
  try {
    const content = await readFile(configPath, 'utf-8')
    const raw = parse(content) as Record<string, unknown>
    const agents = raw.agents
    if (!Array.isArray(agents)) return []

    return agents
      .filter((a): a is Record<string, unknown> => typeof a === 'object' && a !== null)
      .map((a) => normalizeEngine(a))
      .filter((e): e is AgentEngineDef => e !== null)
  } catch {
    // 配置文件不存在或格式错误，静默跳过
    return []
  }
}

/**
 * 将 TOML 原始条目规范化为 AgentEngineDef。
 * 未配置的字段不写入结果，保证注册表字段级合并时缺省字段沿用内置值。
 */
function normalizeEngine(a: Record<string, unknown>): AgentEngineDef | null {
  if (typeof a.name !== 'string' || a.name.trim() === '') return null
  return {
    name: a.name,
    description: typeof a.description === 'string' ? a.description : '',
    systemPrompt: typeof a.system_prompt === 'string' ? a.system_prompt : '',
    ...(typeof a.model === 'string' && a.model !== '' ? { model: a.model } : {}),
    ...(Array.isArray(a.tools)
      ? { tools: a.tools.filter((t): t is string => typeof t === 'string') }
      : {}),
    ...(typeof a.writable === 'boolean' ? { writable: a.writable } : {}),
    ...(typeof a.max_iterations === 'number' ? { maxIterations: a.max_iterations } : {}),
    ...(typeof a.requires_approval === 'boolean' ? { requiresApproval: a.requires_approval } : {}),
  }
}

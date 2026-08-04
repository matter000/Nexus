/**
 * Provider 适配层
 * 各 LLM provider 的特定适配逻辑
 * Vercel AI SDK 已处理大半,这里补充边界情况
 */

import type { ModelRole } from '../../agent/types'
import type { ProviderSecret, SecretsConfig } from '../../config-secrets'
import { isCustomProviderName } from '../../config-secrets'

export interface ProviderAdapter {
  /** provider 名称（内置为 ProviderName，自定义条目为任意键名） */
  name: string
  /**
   * 检查 provider 是否可用(API key 已配置等)
   * 合并环境变量与 secrets 两个来源：env 优先，secrets 兜底。
   * 与 ModelRouter.initProviders 中 getEffectiveApiKey 的优先级保持一致。
   */
  isAvailable(secrets?: SecretsConfig): boolean
  /** 获取默认模型 */
  getDefaultModel(): string
  /** 获取上下文窗口大小 */
  getContextWindow(model: string): number
  /** 是否支持 tool calling */
  supportsTools(model: string): boolean
  /**
   * 获取 provider 优化后的模型调用参数（temperature, top_p, max_tokens 等）
   * 不同模型/角色使用不同的参数以获得最佳效果。
   * 返回 undefined 表示使用全局默认值。
   */
  getModelParameters?(model: string, role: ModelRole): Record<string, unknown> | undefined
  /**
   * 获取 provider 优化后的系统提示后缀
   * 针对不同模型微调指令风格，DeepSeek 模型对冗长提示敏感度不同。
   * 返回的字符串会追加到基础系统提示之后。
   */
  getSystemPromptSuffix?(model: string, role: ModelRole): string | undefined
}

/** Anthropic 适配器 */
export const anthropicAdapter: ProviderAdapter = {
  name: 'anthropic',
  isAvailable: (secrets) =>
    !!process.env.ANTHROPIC_API_KEY || !!secrets?.providers.anthropic?.apiKey,
  getDefaultModel: () => 'claude-sonnet-4-20250514',
  getContextWindow: () => 200000,
  supportsTools: () => true,
}

/** OpenAI 适配器 */
export const openaiAdapter: ProviderAdapter = {
  name: 'openai',
  isAvailable: (secrets) => !!process.env.OPENAI_API_KEY || !!secrets?.providers.openai?.apiKey,
  getDefaultModel: () => 'gpt-4o',
  getContextWindow: (_model) => {
    // mini 系列上下文窗口与标准模型一致（128k）
    return 128000
  },
  supportsTools: () => true,
}

/** DeepSeek 模型规格（v4 系列）
 *
 * 注意: deepseek-chat 与 deepseek-reasoner 已于 2026/07/24 弃用，分别对应
 * v4-flash 的非思考模式与思考模式。
 *
 * v4-flash: 高速低成本模型，支持 tool calling 和思考模式，适合 planner/executor
 * v4-pro:   高性能模型，支持思考模式 + tool calling + reasoning_effort，适合复杂推理
 *
 * 思考模式说明:
 * - 两个模型默认都启用思考模式（thinking: enabled）
 * - 思考模式下 temperature/top_p/presence_penalty/frequency_penalty 不生效
 * - v4-flash 的思考模式不可控制 reasoning_effort（等效于 high）
 * - v4-pro 支持 reasoning_effort: high/max
 * - 详见: https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
 */
const DEEPSEEK_MODELS: Record<
  string,
  {
    contextWindow: number
    supportsTools: boolean
    /** 推荐 temperature 范围 */
    temperatureRange?: [number, number]
    /** 推荐 top_p 值 */
    recommendedTopP?: number
    description: string
    /** 是否支持 reasoning_content（思维链输出） */
    supportsReasoningContent?: boolean
  }
> = {
  'deepseek-v4-flash': {
    contextWindow: 1_000_000,
    supportsTools: true,
    temperatureRange: [0.0, 0.7],
    recommendedTopP: 0.9,
    description: 'DeepSeek V4-Flash 高速模型，1M 上下文，支持 tool calling 和思考模式，成本极低',
    // v4-flash 也支持思考模式和 reasoning_content，但不可控制 reasoning_effort
    supportsReasoningContent: true,
  },
  'deepseek-v4-pro': {
    contextWindow: 1_000_000,
    supportsTools: true,
    temperatureRange: [0.0, 0.7],
    recommendedTopP: 0.9,
    description:
      'DeepSeek V4-Pro 高性能模型，1M 上下文，支持 tool calling 和思考模式，适合复杂推理',
    supportsReasoningContent: true,
  },
}

/** DeepSeek 模型参数配置（按角色优化）
 *
 * DeepSeek v4 思考模式说明:
 * ========================
 * - v4-flash 和 v4-pro 默认都启用思考模式（thinking: {type: "enabled"}）
 * - 思考模式下 temperature、top_p、presence_penalty、frequency_penalty 不生效
 * - 思考模式 + 工具调用时，多轮对话必须回传 reasoning_content，否则报 422
 * - 非思考模式（thinking: disabled）才支持 temperature 控制与 FIM 补全
 *
 * 适配策略（基于 @ai-sdk/openai@1.3 无法回传 reasoning_content 的事实）:
 * - planner/executor: 关闭思考模式（thinking: disabled，经 fetch 拦截器注入请求体）——
 *   工具密集型 ReAct 多轮调用，SDK 不回传 reasoning_content 必触发 422；
 *   关闭后 temperature 生效且延迟更低
 * - summarizer: 保持思考模式（单轮无工具，无 422 风险）
 * - verifier: 保持思考模式，v4-pro 使用 reasoningEffort: max 获得最佳推理
 *   （驼峰键由 SDK 映射为请求体 reasoning_effort 字段）
 * - max_tokens: 按角色限制（Agent 场景无需 384K 上限）
 */
const DEEPSEEK_PARAMETERS: Record<
  string,
  {
    temperature: number
    topP: number
    maxTokens: number
  }
> = {
  // v4-flash 和 v4-pro 参数一致
  'deepseek-v4-flash': { temperature: 0.0, topP: 0.9, maxTokens: 32768 },
  'deepseek-v4-pro': { temperature: 0.0, topP: 0.9, maxTokens: 32768 },
}

/** DeepSeek 角色最优参数（覆盖模型默认值） */
const DEEPSEEK_ROLE_PARAMETERS: Record<
  ModelRole,
  {
    temperature: number
    topP: number
    maxTokens: number
  }
> = {
  planner: { temperature: 0.1, topP: 0.9, maxTokens: 4096 },
  executor: { temperature: 0.0, topP: 0.9, maxTokens: 8192 },
  summarizer: { temperature: 0.3, topP: 0.9, maxTokens: 2048 },
  verifier: { temperature: 0.5, topP: 1.0, maxTokens: 4096 },
}

/** DeepSeek 优化后的系统提示后缀
 *
 * DeepSeek V4 系列特性:
 * - 1M 上下文窗口，对长文档理解能力极强
 * - v4-flash: 高速模式，默认启用思考模式，适合日常任务
 * - v4-pro: 高性能模式，默认启用思考模式，支持 reasoning_effort 参数控制推理深度
 * - 中文理解能力优秀，中英文混合提示效果最佳
 * - 两个模型都支持 tool calling（思考模式下）
 * - 注意: 思考模式下 temperature/top_p 不生效
 */
const DEEPSEEK_PROMPT_SUFFIX: Record<string, string> = {
  'deepseek-v4-flash': '',
  'deepseek-v4-pro': `
## 思考模式
- 你是 DeepSeek V4-Pro 高性能模型，支持深度推理
- 默认启用思考模式（thinking mode），会输出思维链内容（reasoning_content）
- 思考模式下 temperature/top_p 参数不生效
- 你支持 tool calling，可以执行工具调用
- 你有 1M 上下文窗口，可以处理超长文档`,
}

/** DeepSeek 适配器(兼容 OpenAI 接口)
 *
 * ===== 深度适配说明 =====
 *
 * 1. 模型选择策略（v4 系列）:
 *    - deepseek-v4-flash: 主力模型，高速低成本，支持 tool calling 和思考模式，适合 planner/executor/summarizer
 *    - deepseek-v4-pro: 高性能模型，支持深度推理和 tool calling，适合 verifier/复杂分析任务
 *    - 注意: deepseek-chat / deepseek-reasoner 已于 2026/07/24 弃用
 *
 * 2. 参数优化:
 *    - planner: temperature=0.1, topP=0.9 — 保持规划一致性
 *    - executor: temperature=0.0, topP=0.9 — 确保代码修改精确
 *    - summarizer: temperature=0.3, topP=0.9 — 保持摘要稳定
 *    - verifier: temperature=0.5, topP=1.0 — 允许一定多样性
 *    - v4-pro 额外支持 reasoning_effort（low/medium/high）
 *
 * 3. 上下文窗口:
 *    - 1M tokens（v4 系列统一支持）
 *    - 最大输出 384K tokens
 *    - 成本约为 Claude 的 1/10，GPT-4o 的 1/5
 *
 * 4. 特殊能力:
 *    - v4-pro 支持 reasoning_content（思维链输出）
 *    - 两个模型均支持 thinking 参数切换思考模式
 *    - 两个模型均支持 FIM (Fill-in-the-Middle) 代码补全（仅非思考模式）
 *    - 优秀的中文理解和生成能力
 */
export const deepseekAdapter: ProviderAdapter = {
  name: 'deepseek',
  isAvailable: (secrets) => !!process.env.DEEPSEEK_API_KEY || !!secrets?.providers.deepseek?.apiKey,
  getDefaultModel: () => 'deepseek-v4-flash',
  getContextWindow: (model) => {
    return DEEPSEEK_MODELS[model]?.contextWindow ?? 1_000_000
  },
  supportsTools: (model) => {
    return DEEPSEEK_MODELS[model]?.supportsTools ?? true
  },
  getModelParameters: (model, role) => {
    // 按角色返回最优参数
    const roleParams = DEEPSEEK_ROLE_PARAMETERS[role]

    // planner/executor: 工具密集型 ReAct 多轮调用，显式关闭思考模式。
    // @ai-sdk/openai 不回传 reasoning_content，思考模式下多轮工具调用必触发 422；
    // 关闭后 temperature/top_p 生效，延迟更低。
    if (role === 'planner' || role === 'executor') {
      return {
        temperature: roleParams.temperature,
        topP: roleParams.topP,
        maxTokens: roleParams.maxTokens,
        thinking: { type: 'disabled' },
      }
    }

    // v4-pro 支持推理深度控制，verifier 角色使用 max（复杂 Agent 任务）。
    // 注意: 必须用驼峰键 reasoningEffort，@ai-sdk/openai 才会映射为请求体
    // reasoning_effort 字段（蛇形键会被 SDK 静默丢弃）
    if (model === 'deepseek-v4-pro' && role === 'verifier') {
      return {
        temperature: roleParams.temperature,
        topP: roleParams.topP,
        maxTokens: roleParams.maxTokens,
        reasoningEffort: 'max',
      }
    }
    // v4-pro 的 summarizer 使用 high 推理深度（单轮无工具，保持思考模式）
    if (model === 'deepseek-v4-pro') {
      return {
        temperature: roleParams.temperature,
        topP: roleParams.topP,
        maxTokens: roleParams.maxTokens,
        reasoningEffort: 'high',
      }
    }
    return {
      temperature: roleParams.temperature,
      topP: roleParams.topP,
      maxTokens: roleParams.maxTokens,
    }
  },
  getSystemPromptSuffix: (model, role) => {
    // v4-pro 的 verifier 角色使用推理模式提示
    if (model === 'deepseek-v4-pro' && role === 'verifier') {
      return DEEPSEEK_PROMPT_SUFFIX['deepseek-v4-pro']
    }
    // v4-flash 使用标准提示即可
    return DEEPSEEK_PROMPT_SUFFIX[model] ?? ''
  },
}

/** DeepSeek 工具函数：检查模型是否支持 reasoning_content */
export function supportsReasoningContent(model: string): boolean {
  return DEEPSEEK_MODELS[model]?.supportsReasoningContent ?? false
}

/** DeepSeek 工具函数：获取模型推荐参数 */
export function getDeepSeekModelParameters(model: string): Record<string, unknown> | undefined {
  const params = DEEPSEEK_PARAMETERS[model]
  if (!params) return undefined
  return { ...params }
}

/** 通用 OpenAI 兼容适配器(自定义 base URL) */
export function createCustomAdapter(secrets?: SecretsConfig): ProviderAdapter {
  return {
    name: 'custom',
    isAvailable: () => {
      // 优先级: 环境变量 > secrets 文件
      const apiKey = process.env.CUSTOM_API_KEY || secrets?.providers.custom?.apiKey
      const baseUrl = process.env.CUSTOM_BASE_URL || secrets?.providers.custom?.baseUrl
      return !!(apiKey && baseUrl)
    },
    getDefaultModel: () =>
      process.env.CUSTOM_DEFAULT_MODEL ?? secrets?.providers.custom?.defaultModel ?? 'default',
    getContextWindow: () => 128000, // 默认假设
    supportsTools: () => true, // 大多数 OpenAI 兼容接口支持
  }
}

/**
 * 为命名自定义条目创建动态适配器。
 * 支持任意键名（如 custom-openai-1、custom-anthropic-1），按 compatibility 区分协议。
 */
export function createDynamicCustomAdapter(name: string, secret: ProviderSecret): ProviderAdapter {
  return {
    name,
    isAvailable: () => !!(secret.apiKey && secret.baseUrl),
    getDefaultModel: () => secret.defaultModel ?? 'default',
    getContextWindow: () => 128000, // 默认假设
    supportsTools: () => true, // OpenAI/Anthropic 兼容接口通常都支持 tool calling
  }
}

/** 收集 secrets 中所有自定义条目适配器（含旧 custom 键） */
function collectCustomAdapters(secrets?: SecretsConfig): ProviderAdapter[] {
  if (!secrets) {
    // 无 secrets 时仍尝试旧 custom 环境变量兼容
    return [createCustomAdapter(secrets)]
  }
  const adapters: ProviderAdapter[] = []
  for (const [key, secret] of Object.entries(secrets.providers)) {
    if (!isCustomProviderName(key)) continue
    if (!secret.apiKey) continue
    adapters.push(createDynamicCustomAdapter(key, secret))
  }
  return adapters
}

/** 获取所有可用 provider */
export function getAvailableProviders(secrets?: SecretsConfig): ProviderAdapter[] {
  const staticAdapters = [anthropicAdapter, openaiAdapter, deepseekAdapter]
  const customAdapters = collectCustomAdapters(secrets)
  // 传递 secrets 给 isAvailable，使其能感知 secrets 文件中配置的 key
  return [...staticAdapters, ...customAdapters].filter((p) => p.isAvailable(secrets))
}

/** 按名称获取 provider */
export function getProvider(name: string, secrets?: SecretsConfig): ProviderAdapter | undefined {
  // 内置静态 provider
  const staticMap: Record<string, ProviderAdapter> = {
    anthropic: anthropicAdapter,
    openai: openaiAdapter,
    deepseek: deepseekAdapter,
  }
  if (staticMap[name]) return staticMap[name]

  // 自定义条目（命名键或旧 custom 键）
  if (name === 'custom') return createCustomAdapter(secrets)
  if (secrets && isCustomProviderName(name)) {
    const secret = secrets.providers[name]
    if (secret) return createDynamicCustomAdapter(name, secret)
  }
  return undefined
}

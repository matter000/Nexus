/**
 * DeepSeek API 错误处理
 * 识别 DeepSeek API 特定错误码并提供可读的错误信息和恢复建议
 */

/** DeepSeek API 错误码定义
 *
 * 参考: https://api-docs.deepseek.com/zh-cn/quick_start/error_codes
 */
const DEEPSEEK_ERROR_CODES: Record<
  number,
  { message: string; recoverable: boolean; suggestion: string }
> = {
  400: {
    message: '请求格式错误',
    recoverable: false,
    suggestion: '请根据错误信息提示修改请求体格式',
  },
  401: {
    message: 'API Key 无效或未授权',
    recoverable: false,
    suggestion: '请通过 /config 或环境变量 DEEPSEEK_API_KEY 重新配置有效的 API Key',
  },
  402: {
    message: '账户余额不足',
    recoverable: false,
    suggestion: '请充值 DeepSeek 账户余额后再试',
  },
  403: {
    message: '请求被拒绝（权限不足或违规内容）',
    recoverable: false,
    suggestion: '请检查请求内容是否合规，或确认 API Key 是否有对应模型的访问权限',
  },
  422: {
    message: '请求参数错误',
    recoverable: false,
    suggestion:
      '请检查请求参数是否正确，特别是 thinking/reasoning_effort/max_tokens 等参数，以及消息中 reasoning_content 是否在需要时正确回传。思考模式下有工具调用时，assistant 消息必须包含 reasoning_content 字段',
  },
  429: {
    message: '请求速率达到上限（Rate Limit）',
    recoverable: true,
    suggestion: 'DeepSeek v4-flash 2500 RPM，v4-pro 500 RPM，请降低请求频率后重试',
  },
  500: {
    message: 'DeepSeek 服务端内部错误',
    recoverable: true,
    suggestion: 'DeepSeek 服务暂时不稳定，请稍后重试',
  },
  503: {
    message: 'DeepSeek 服务暂时不可用（过载或维护中）',
    recoverable: true,
    suggestion: '请稍后重试，或切换降级模型',
  },
}

/** DeepSeek 模型特定的速率限制（v4 系列）
 *
 * 参考: https://api-docs.deepseek.com/zh-cn/quick_start/rate_limit
 * - v4-flash: 2500 RPM（共享/专用）
 * - v4-pro: 500 RPM（共享/专用）
 */
const DEEPSEEK_RATE_LIMITS: Record<string, { rpm: number; tpm: number }> = {
  'deepseek-v4-flash': { rpm: 2500, tpm: 10000000 },
  'deepseek-v4-pro': { rpm: 500, tpm: 5000000 },
}

/** 获取 DeepSeek 模型的速率限制信息 */
export function getDeepSeekRateLimit(model: string): { rpm: number; tpm: number } {
  return DEEPSEEK_RATE_LIMITS[model] ?? { rpm: 2000, tpm: 2000000 }
}

/** 解析 DeepSeek API 错误
 *
 * disableThinking: 思考模式 reasoning_content 契约错误标记。
 * 调用方可据此关闭思考模式后自动重试（@ai-sdk/openai 无法回传 reasoning_content）。
 */
export function parseDeepSeekError(
  error: Error,
  model?: string,
): {
  parsed: boolean
  message: string
  recoverable: boolean
  suggestion: string
  disableThinking?: boolean
} {
  const errorMessage = error.message ?? String(error)

  // 优先匹配特征关键词（必须先于状态码分支：
  // 否则 "422 ... reasoning_content" 会被 422 通用分支抢先命中，丢失自愈标记）
  if (errorMessage.includes('reasoning_content') || errorMessage.includes('reasoning')) {
    return {
      parsed: true,
      message: 'DeepSeek 思考模式下 reasoning_content 未正确回传',
      // 可自动恢复：关闭思考模式后重试（SDK 不回传 reasoning_content，多轮工具调用场景必现）
      recoverable: true,
      suggestion:
        '已自动关闭思考模式重试。若需多轮工具调用 + 思考模式，需升级支持 reasoning_content 回传的 SDK',
      disableThinking: true,
    }
  }

  // 尝试从错误消息中提取 HTTP 状态码
  // DeepSeek API 错误格式示例: "401 Authentication Fails" 或 "429 Too Many Requests"
  const statusMatch = errorMessage.match(/(\d{3})\s/)
  if (statusMatch) {
    const statusCode = Number.parseInt(statusMatch[1], 10)
    const errorInfo = DEEPSEEK_ERROR_CODES[statusCode]
    if (errorInfo) {
      const modelInfo = model ? `（模型: ${model}）` : ''
      return {
        parsed: true,
        message: `DeepSeek API 错误 [${statusCode}]: ${errorInfo.message}${modelInfo}`,
        recoverable: errorInfo.recoverable,
        suggestion: errorInfo.suggestion,
      }
    }
  }

  // 检查已知的错误关键词
  if (errorMessage.includes('Insufficient Balance') || errorMessage.includes('余额不足')) {
    return {
      parsed: true,
      message: 'DeepSeek 账户余额不足，请充值后重试',
      recoverable: false,
      suggestion: '请充值 DeepSeek 账户余额',
    }
  }

  if (errorMessage.includes('Rate Limit') || errorMessage.includes('rate_limit')) {
    const modelInfo = model ? `（模型: ${model}）` : ''
    return {
      parsed: true,
      message: `DeepSeek 请求频率超限${modelInfo}`,
      recoverable: true,
      suggestion: '请稍后重试，或降低请求频率',
    }
  }

  if (errorMessage.includes('context length') || errorMessage.includes('context_length')) {
    return {
      parsed: true,
      message: 'DeepSeek 上下文长度超限（最大 1M tokens）',
      recoverable: true,
      suggestion: '对话历史过长，系统会自动压缩上下文，请稍后重试',
    }
  }

  if (errorMessage.includes('insufficient_system_resource')) {
    return {
      parsed: true,
      message: 'DeepSeek 系统推理资源不足，生成被打断',
      recoverable: true,
      suggestion: '请稍后重试，或降低请求的 max_tokens 值',
    }
  }

  if (errorMessage.includes('content_filter')) {
    return {
      parsed: true,
      message: '输出内容因触发过滤策略而被过滤',
      recoverable: false,
      suggestion: '请调整提示词，避免生成可能违规的内容',
    }
  }

  // 未识别错误
  return {
    parsed: false,
    message: errorMessage,
    recoverable: false,
    suggestion: '',
  }
}

/** 判断 DeepSeek 错误是否可自动恢复 */
export function isDeepSeekErrorRecoverable(error: Error): boolean {
  return parseDeepSeekError(error).recoverable
}

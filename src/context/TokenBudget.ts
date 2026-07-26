/**
 * Token 预算管理
 * 组装 prompt 前算总 token,超预算时按优先级丢弃
 */

/** 粗略估算 token 数(英文约 4 字符/token,中文约 2 字符/token) */
export function estimateTokens(text: string): number {
  if (!text) return 0
  // 混合语言估算:统计 ASCII 和非 ASCII 字符
  let asciiChars = 0
  let nonAsciiChars = 0
  for (const char of text) {
    if (char.charCodeAt(0) < 128) {
      asciiChars++
    } else {
      nonAsciiChars++
    }
  }
  // ASCII: ~4 chars/token, 非 ASCII(中文等): ~1.5 chars/token
  return Math.ceil(asciiChars / 4 + nonAsciiChars / 1.5)
}

export interface BudgetAllocation {
  systemPrompt: number
  history: number
  reserved: number // 留给模型输出
  total: number
}

export class TokenBudget {
  private contextWindow: number
  private budgetRatio: number
  private outputReserve: number

  constructor(contextWindow: number, budgetRatio = 0.8, outputReserve = 4096) {
    this.contextWindow = contextWindow
    this.budgetRatio = budgetRatio
    this.outputReserve = outputReserve
  }

  /** 可用于输入的总 token 预算 */
  getInputBudget(): number {
    return Math.floor(this.contextWindow * this.budgetRatio) - this.outputReserve
  }

  /** 分配各层预算 */
  allocate(): BudgetAllocation {
    const total = this.getInputBudget()
    return {
      systemPrompt: Math.floor(total * 0.25),  // L1: 25%
      history: Math.floor(total * 0.75),        // L2: 75%（含历史 + 工具结果压缩）
      reserved: this.outputReserve,
      total: this.contextWindow,
    }
  }

  /** 检查是否超预算 */
  isOverBudget(currentTokens: number): boolean {
    return currentTokens > this.getInputBudget()
  }

  /** 计算需要裁剪的 token 数 */
  getOverflow(currentTokens: number): number {
    const budget = this.getInputBudget()
    return Math.max(0, currentTokens - budget)
  }

  /** 更新上下文窗口大小(切换模型时) */
  setContextWindow(size: number): void {
    this.contextWindow = size
  }

  getContextWindow(): number {
    return this.contextWindow
  }
}

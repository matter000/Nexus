/**
 * Mailbox - 引擎间通信信箱（Agent Teams 三件套之一）
 *
 * 会话级内存信箱：按 agentId 寻址投递，接收方读取未读消息。
 * 主 Agent id 约定为 'lead'；子 Agent id 为 `<engine>-<taskId>`。
 * 用于子 Agent 之间/与主 Agent 之间的轻量协调（如发现依赖、请求澄清）。
 */

export interface MailMessage {
  from: string
  to: string
  content: string
  timestamp: number
  read: boolean
}

/** 单个信箱的消息上限（防失控刷屏撑爆注入上下文） */
const MAX_MESSAGES_PER_AGENT = 50

export class Mailbox {
  private boxes = new Map<string, MailMessage[]>()

  /** 投递消息（收件人信箱不存在时自动创建） */
  send(from: string, to: string, content: string): void {
    const box = this.boxes.get(to) ?? []
    box.push({ from, to, content, timestamp: Date.now(), read: false })
    // 超限丢弃最旧消息
    while (box.length > MAX_MESSAGES_PER_AGENT) box.shift()
    this.boxes.set(to, box)
  }

  /** 读取未读消息并标记已读（无未读返回空数组） */
  readUnread(agentId: string): MailMessage[] {
    const box = this.boxes.get(agentId) ?? []
    const unread = box.filter((m) => !m.read)
    for (const m of unread) m.read = true
    return unread
  }

  /** 查看最近消息（含已读，team 工具诊断用） */
  peek(agentId: string, limit = 10): MailMessage[] {
    return (this.boxes.get(agentId) ?? []).slice(-limit).map((m) => ({ ...m }))
  }

  /** 格式化为可读文本 */
  static formatMessages(messages: MailMessage[]): string {
    return messages.map((m) => `[来自 ${m.from}] ${m.content}`).join('\n')
  }

  clear(): void {
    this.boxes.clear()
  }
}

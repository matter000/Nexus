/**
 * 类型安全的事件总线
 * 基于 EventEmitter 封装，替代 (globalThis as any).__nexusEventHandler
 */

import { EventEmitter } from 'events'
import type { NexusEvent } from '../agent/types'

const EVENT_NAME = 'nexus:event'

export interface NexusEventBus {
  /** 触发事件 */
  emit(event: NexusEvent): void
  /** 监听事件 */
  on(handler: (event: NexusEvent) => void): void
  /** 取消监听 */
  off(handler: (event: NexusEvent) => void): void
  /** 移除所有监听器 */
  removeAllListeners(): void
}

/** 创建新的事件总线实例 */
export function createEventBus(): NexusEventBus {
  const emitter = new EventEmitter()
  // 允许多个监听器，避免内存泄漏警告
  emitter.setMaxListeners(50)

  return {
    emit(event: NexusEvent): void {
      emitter.emit(EVENT_NAME, event)
    },
    on(handler: (event: NexusEvent) => void): void {
      emitter.on(EVENT_NAME, handler)
    },
    off(handler: (event: NexusEvent) => void): void {
      emitter.off(EVENT_NAME, handler)
    },
    removeAllListeners(): void {
      emitter.removeAllListeners(EVENT_NAME)
    },
  }
}

/** 全局共享事件总线单例 */
export const eventBus: NexusEventBus = createEventBus()

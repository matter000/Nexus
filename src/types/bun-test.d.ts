/**
 * bun:test 类型声明
 * 允许在没有 Bun 运行时的环境下进行类型检查
 */

declare module 'bun:test' {
  export function describe(name: string, fn: () => void): void
  export function it(name: string, fn: () => void | Promise<void>): void
  /** bun:test 支持可选超时（ms），长耗时用例（git 操作类）需要 */
  export function it(name: string, fn: () => void | Promise<void>, timeout: number): void
  export function test(name: string, fn: () => void | Promise<void>): void
  export function test(name: string, fn: () => void | Promise<void>, timeout: number): void
  export function expect(value: unknown): {
    toBe(expected: unknown): void
    toBeCloseTo(expected: number, precision?: number): void
    toBeGreaterThan(expected: number): void
    toBeGreaterThanOrEqual(expected: number): void
    toBeLessThan(expected: number): void
    toBeLessThanOrEqual(expected: number): void
    toContain(expected: unknown): void
    toBeUndefined(): void
    toBeDefined(): void
    toBeTruthy(): void
    toBeFalsy(): void
    toBeNull(): void
    toEqual(expected: unknown): void
    toHaveLength(expected: number): void
    toThrow(expected?: unknown): void
    not: {
      toBe(expected: unknown): void
      toEqual(expected: unknown): void
      toContain(expected: unknown): void
      toBeUndefined(): void
      toBeNull(): void
    }
  }
  export function beforeEach(fn: () => void | Promise<void>): void
  export function afterEach(fn: () => void | Promise<void>): void
  export function beforeAll(fn: () => void | Promise<void>): void
  export function afterAll(fn: () => void | Promise<void>): void
  export function mock(fn?: (...args: unknown[]) => unknown): {
    (...args: unknown[]): unknown
    mockReturnValue(value: unknown): void
    mockResolvedValue(value: unknown): void
  }
}

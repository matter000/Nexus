/**
 * 沙箱引擎接口抽象
 *
 * DESIGN.md 设计:
 * - 当前: TypeScriptSandbox (spawn 子进程 + CommandGuard)
 * - v2: GoSandbox (pty + cgroup + syscall 过滤, 通过 IPC/gRPC 通信)
 * - Agent loop 零改动: 只需替换注入的实现
 *
 * 触发迁移到 Go 的明确信号(DESIGN.md §2.2):
 * 1. 需要真沙箱(pty 劫持、cgroup 资源限制、syscall 过滤)
 * 2. 需要常驻后台索引守护进程(整库 embedding 增量更新)
 * 3. 实测某个工具成为 P95 延迟瓶颈
 */

import { spawn } from 'child_process'
import { isDangerousCommand, type DangerAssessment } from './CommandGuard'

// ─── 接口定义 ─────────────────────────────────────────────────────────────────

export interface ExecOptions {
  /** 工作目录(默认项目根) */
  cwd: string
  /** 超时(毫秒) */
  timeoutMs: number
  /** 输出最大字节数 */
  maxOutputBytes: number
  /** 环境变量(可选覆盖) */
  env?: Record<string, string>
}

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
  /** 危险命令评估结果 */
  dangerAssessment?: DangerAssessment
}

export interface IndexStatus {
  /** 索引是否就绪 */
  ready: boolean
  /** 已索引文件数 */
  indexedFiles: number
  /** 最后更新时间 */
  lastUpdated: number | null
  /** 引擎类型 */
  engine: 'typescript' | 'go'
}

/**
 * 沙箱引擎接口
 * Agent 编排层通过此接口执行命令,不直接依赖具体实现
 *
 * v2 引入 Go 引擎时:
 * - 实现 GoSandbox 类,通过 stdio JSON-RPC 或 gRPC 与 Go 进程通信
 * - 在 Orchestrator 初始化时注入 GoSandbox 替代 TypeScriptSandbox
 * - Agent loop 代码零改动
 */
export interface SandboxEngine {
  /** 执行命令(真沙箱或子进程) */
  execute(command: string, options: ExecOptions): Promise<ExecResult>

  /** 检测引擎是否可用 */
  isAvailable(): boolean

  /** 获取后台索引状态 */
  getIndexStatus(): Promise<IndexStatus>

  /** 引擎名称 */
  readonly name: string
}

// ─── TypeScript 默认实现 ──────────────────────────────────────────────────────

/**
 * TypeScript 沙箱(当前默认实现)
 * 使用 spawn 子进程 + CommandGuard 危险命令检测
 *
 * TODO v2: 当 Go 引擎可用时,替换为 GoSandbox:
 * ```typescript
 * class GoSandbox implements SandboxEngine {
 *   private process: ChildProcess
 *
 *   constructor(goEnginePath: string) {
 *     // 启动 Go MCP Server 子进程
 *     this.process = spawn(goEnginePath, ['--mode', 'sandbox'], {
 *       stdio: ['pipe', 'pipe', 'pipe']
 *     })
 *   }
 *
 *   async execute(command: string, options: ExecOptions): Promise<ExecResult> {
 *     // 通过 JSON-RPC over stdio 发送执行请求
 *     // Go 端使用 pty + cgroup 实现真沙箱
 *     return this.rpc('execute', { command, ...options })
 *   }
 *
 *   isAvailable(): boolean {
 *     return this.process.exitCode === null
 *   }
 *
 *   async getIndexStatus(): Promise<IndexStatus> {
 *     return this.rpc('index_status', {})
 *   }
 * }
 * ```
 */
export class TypeScriptSandbox implements SandboxEngine {
  readonly name = 'typescript'

  async execute(command: string, options: ExecOptions): Promise<ExecResult> {
    const { cwd, timeoutMs, maxOutputBytes } = options

    // 危险命令检测
    const dangerAssessment = isDangerousCommand(command)

    const result = await new Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>(
      (resolvePromise) => {
        const isWindows = process.platform === 'win32'
        const shell = isWindows ? 'powershell.exe' : '/bin/bash'
        const shellArgs = isWindows ? ['-NoProfile', '-Command', command] : ['-c', command]

        const child = spawn(shell, shellArgs, {
          cwd,
          env: { ...process.env, TERM: 'dumb', ...options.env },
          stdio: ['ignore', 'pipe', 'pipe'],
          ...(isWindows ? { windowsHide: true } : { detached: true }),
        })

        let stdout = ''
        let stderr = ''
        let timedOut = false
        let settled = false

        const timer = setTimeout(() => {
          timedOut = true
          this.killProcessGroup(child, isWindows)
        }, timeoutMs)

        child.stdout?.on('data', (d: Buffer) => {
          if (stdout.length < maxOutputBytes) stdout += d.toString()
        })
        child.stderr?.on('data', (d: Buffer) => {
          if (stderr.length < maxOutputBytes) stderr += d.toString()
        })

        child.on('close', (code) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolvePromise({ stdout, stderr, exitCode: code ?? 1, timedOut })
        })

        child.on('error', (err) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolvePromise({ stdout, stderr: err.message, exitCode: 1, timedOut: false })
        })
      }
    )

    return { ...result, dangerAssessment }
  }

  isAvailable(): boolean {
    // TypeScript 沙箱始终可用
    return true
  }

  async getIndexStatus(): Promise<IndexStatus> {
    // TypeScript 实现没有后台索引
    return {
      ready: false,
      indexedFiles: 0,
      lastUpdated: null,
      engine: 'typescript',
    }
  }

  private killProcessGroup(child: ReturnType<typeof spawn>, isWindows: boolean): void {
    try {
      if (isWindows) {
        if (child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      } else {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      }
    } catch {
      child.kill('SIGKILL')
    }
  }
}

// ─── 工厂函数 ─────────────────────────────────────────────────────────────────

/**
 * 创建沙箱引擎实例
 * 当前返回 TypeScriptSandbox;v2 时检测 Go 引擎是否可用,可用则返回 GoSandbox
 */
export function createSandboxEngine(): SandboxEngine {
  // TODO v2: 检测 Go 引擎二进制是否存在
  // const goEnginePath = findGoEngine()
  // if (goEnginePath) return new GoSandbox(goEnginePath)
  return new TypeScriptSandbox()
}

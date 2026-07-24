---
kind: error_handling
name: Nexus 错误处理体系：分层捕获、结构化返回与事件驱动上报
category: error_handling
scope:
    - '**'
source_files:
    - src/agent/types.ts
    - src/index.ts
    - src/agent/Orchestrator.ts
    - src/tools/registry.ts
    - src/tools/readFile.ts
    - src/sandbox/CommandGuard.ts
    - packages/nexus-mcp-server/src/index.ts
---

## 1. 采用的错误处理系统/模式
- **无统一异常类库**：未引入第三方错误框架，采用原生 `Error` + 自定义轻量错误类（如 MCP Server 中的 `PathError`）。
- **try/catch + Promise.catch 双轨**：所有 I/O 和子进程调用均包裹 try/catch；顶层入口通过 `.catch()` 兜底打印并退出。
- **结构化错误返回**：工具层不抛错，而是返回 `{ error, result }` 形式的 `ToolResult`；MCP Server 侧使用统一的 `errorResult(errorType, message, suggestion?)` 构造带 `isError: true` 的 JSON-RPC 响应。
- **事件驱动的错误上报**：核心 Agent 通过 `NexusEvent` 中的 `{ type: 'error', message, recoverable }` 事件将错误推送到 TUI 或 CLI 消费者，而非直接抛出。
- **安全拦截作为“业务错误”**：危险命令检测 (`CommandGuard`) 和路径越界校验 (`assertPathSafe`) 以结构化错误形式拒绝执行，不走异常流。

## 2. 关键文件与位置
| 层级 | 文件 | 职责 |
|---|---|---|
| 类型定义 | `src/agent/types.ts` | 定义 `NexusEvent.error`、`ToolResult.error`、`SubAgentResult.error` 等错误相关结构体 |
| 编排入口 | `src/index.ts` | 顶层 `main().catch(...)` 兜底；TUI 提交时 `.catch(err) => emitToUI({type:'error',...})` |
| 编排核心 | `src/agent/Orchestrator.ts` | 协调 Plan/Execute，错误由被调组件通过事件上报，自身不吞错 |
| 工具注册中心 | `src/tools/registry.ts` | 未知工具名返回 `{ error: '未知工具: ...' }`，不抛异常 |
| 工具实现 | `src/tools/readFile.ts` 等 | 每个工具内部 try/catch，统一返回 `{ error, result }` 格式 |
| 沙箱安全 | `src/sandbox/CommandGuard.ts` | 正则黑名单判定危险命令，返回 `DangerAssessment` 供上层决策 |
| MCP Server | `packages/nexus-mcp-server/src/index.ts` | 自定义 `PathError`；统一 `errorResult()` 构造结构化错误响应；`main().catch(...)` 兜底 |

## 3. 架构与约定
### 3.1 三层错误边界
1. **工具层**：`readFile/editFile/bash/grep` 等工具函数内部 try/catch，失败时返回 `ToolResult { error }`，禁止向上抛异常，保证 Agent loop 稳定。
2. **编排层**：`Orchestrator` 不捕获工具错误，而是让 `tool_result` 事件携带 `error` 字段；当发生不可恢复错误时，通过 `emit({ type: 'error', message, recoverable })` 通知 UI。
3. **进程层**：`src/index.ts` 和 `packages/nexus-mcp-server/src/index.ts` 的 `main().catch(...)` 是最终兜底，打印后 `process.exit(1)`。

### 3.2 结构化错误协议
- **ToolResult**：`{ callId, tool, result, error?, truncated? }` —— `error` 非空即表示该次工具调用失败。
- **MCP errorResult**：`{ content: [{ text }] , isError: true }` —— 客户端据此判断工具调用是否出错。
- **NexusEvent.error**：`{ type: 'error', message: string, recoverable: boolean }` —— 用于 TUI 展示可恢复/不可恢复错误。

### 3.3 安全错误的特殊处理
- 路径越界：MCP 侧抛 `PathError`，工具层返回 `error: '路径越界...'`，两者语义一致但传播方式不同（MCP 走异常、工具走返回值）。
- 危险命令：`CommandGuard.isDangerousCommand` 返回 `level === 'dangerous'` 的命令强制审批，即便 `yolo` 模式也不放行。

### 3.4 无全局错误中间件
未发现类似 Express/Koa 的错误中间件或全局 `unhandledRejection` / `uncaughtException` 监听器，错误处理分散在各模块的 try/catch 中。

## 4. 开发者应遵循的规则
1. **工具函数一律 return `{ error }`，不要 throw**：确保 Agent loop 不被单个工具崩溃打断。
2. **I/O 与子进程调用必须 try/catch**：对 `fs/promises`、`child_process.spawn`、网络请求等外部依赖做防御性捕获。
3. **使用 `errorResult(type, msg, suggestion?)` 构造 MCP 错误**：保持客户端可读的错误码与建议信息。
4. **通过 `NexusEvent.error` 上报编排级错误**：在 Orchestrator 或 SubAgent 遇到不可恢复错误时 emit，而非直接抛出。
5. **危险命令走安全策略而非异常**：使用 `CommandGuard.requiresForcedApproval` 判断，命中则走审批流程。
6. **顶层 catch 只负责兜底日志与退出**：不要在中间层吞掉错误而不记录。
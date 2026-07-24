---
kind: logging_system
name: 日志系统 — 基于 console 的轻量级输出与事件驱动 UI 更新
category: logging_system
scope:
    - '**'
source_files:
    - src/index.ts
    - packages/nexus-mcp-server/src/index.ts
    - src/agent/Executor.ts
    - src/agent/Orchestrator.ts
    - src/agent/Planner.ts
---

本仓库未引入任何第三方日志框架（如 pino、winston、bun.log 等），也未建立统一的 logger 模块或日志级别体系。整体采用最简方案：CLI 入口和 MCP Server 使用 Node/Bun 内置 `console.log` / `console.error` 直接输出，核心业务逻辑通过事件回调向 TUI 层推送结构化状态，而非写入日志文件。

### 1. 使用的系统与工具
- **标准输出**：`console.log` 用于版本/帮助信息、非交互模式结果摘要；`console.error` 用于启动提示、错误与优雅退出信号。
- **无结构化日志库**：未发现任何 logger 初始化代码、log level 配置或日志轮转策略。
- **事件驱动替代**：Agent 层通过 `onEvent(NexusEvent)` 回调将执行阶段、工具调用、TODO 进度等以强类型事件对象上报给 TUI 渲染，这承担了“可观测性”的主要职责。

### 2. 关键位置
- **CLI 主入口** `src/index.ts`：`console.log` 打印版本/帮助/非交互结果，`console.error` 捕获顶层异常并退出码 1。
- **MCP Server** `packages/nexus-mcp-server/src/index.ts`：`console.error` 输出服务启动、SIGINT/SIGTERM 处理及启动失败信息；所有工具错误统一走 `errorResult()` 返回结构化 JSON-RPC 响应，不写日志文件。
- **Agent 事件流** `src/agent/Executor.ts`、`Planner.ts`、`Orchestrator.ts`：大量 `onEvent({ type, ... })` 调用，事件类型包括 `llm_start`、`llm_chunk`、`tool_call`、`tool_result`、`checkpoint`、`todo_update`、`error` 等，由 Orchestrator 透传到 TUI 的 `emitToUI`。
- **TUI 渲染** `src/tui/App.tsx`：接收事件并更新界面，是用户可见的“实时日志”。

### 3. 架构与约定
- **分层输出**：CLI/MCP 进程边界用 `console.*` 做进程级诊断；应用内部用强类型 `NexusEvent` 做跨组件状态同步。
- **错误路径**：工具层不使用 `console.error`，而是返回 `{ content, isError }` 的结构化结果，由上层决定是否展示给用户。
- **无持久化**：没有日志文件、没有 stdout/stderr 重定向到文件、没有 log rotation 配置。

### 4. 开发者应遵循的规则
- 新增诊断信息时优先使用 `console.error`（stderr）区分于正常输出，避免污染 stdout。
- 业务状态变更一律通过 `onEvent` 发送 `NexusEvent`，不要自行拼接字符串写到控制台。
- 工具实现中遇到错误应返回 `errorResult(type, message, suggestion?)` 结构体，保持 MCP 协议一致性。
- 如需生产环境可观测性，应在进程启动处集中接入外部日志 SDK（如 bun.log），并在 `src/index.ts` 与 MCP server 入口统一注入，而不是散落各处。
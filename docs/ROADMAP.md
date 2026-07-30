# Nexus 路线图

记录已识别但尚未实施的改进项，供后续迭代参考。源码中的 `TODO v2` 注释均指向本文件对应条目。

## v2：Go 引擎

当前沙箱与代码图谱均为 TypeScript 实现。v2 计划引入 Go 引擎，以获得更强的进程隔离与代码索引性能。相关接口已预留（`SandboxEngine` / `CodeGraph` 接口），替换时上层编排零改动。

### GoSandbox（pty + cgroup + syscall 过滤）

- 位置：`src/sandbox/SandboxEngine.ts`（`TODO v2` 标注于第 80、205 行附近）；类型见 `src/agent/types.ts`
- 目标：用 Go 实现进程沙箱，通过 pty + cgroup + syscall 过滤提供更强的命令执行隔离，经 IPC/gRPC 与主进程通信
- 对接方式：`createSandbox()` 工厂检测 Go 引擎二进制是否可用，可用则返回 `GoSandbox`，否则回退 `TypeScriptSandbox`

### GoGraphEngine（tree-sitter 后台索引服务）

- 位置：`src/context/CodeGraph.ts`（`TODO v2` 标注于第 50、483 行附近）；类型见 `src/agent/types.ts`
- 目标：用 Go 实现 tree-sitter 后台索引服务，提升大型代码库的图谱构建与增量更新性能
- 对接方式：`createGraphEngine()` 工厂检测 Go 引擎可用性，可用则返回 `GoGraphEngine`，否则回退 TypeScript 引擎

## 待办改进项

### Orchestrator 拆分（来源：2026-07 代码精进）

- 现状：`src/agent/Orchestrator.ts` 约 800 行，承担初始化、MCP 编排、会话恢复、成本管理等多重职责；`this.db` 分散在 init / submit / shutdown / restore / getStatus 等核心路径（17 处）
- 计划：提取 `SessionManager`（封装 NexusDB 会话操作）与 MCP 编排模块，降低单文件复杂度
- 前置条件：`tests/unit/orchestrator.test.ts` 当前约 244 行，覆盖不足以保障核心编排逻辑的大规模重构。**建议先补充 Orchestrator 核心路径测试，再拆分**
- 备注：MCP 管理已有独立的 `ExternalMCPManager`，Orchestrator 内为薄编排层，提取价值相对有限

### 系统提示缓存（来源：2026-07 代码精进，评估后暂缓）

- 现状：`buildSystemPrompt` 每次 submit 调用一次，含 `git status` / `git ls-files` 等外部命令
- 评估结论：调用频率低（每次用户输入一次，非每个 ReAct 迭代）；git 命令毫秒级开销相对 LLM 秒级延迟微不足道；缓存会引入"过期上下文"风险（用户编辑文件后 git 状态变化，缓存失效逻辑复杂）
- 结论：暂不实施。若未来基准测试确认为瓶颈，可考虑结合 FileWatcher 对项目树做短 TTL 缓存，git status 不宜长缓存

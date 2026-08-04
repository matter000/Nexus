# AGENTS.md — Nexus 项目 Agent 协作指南

## 项目简介

Nexus 是一个运行在终端的 AI 编程助手（CLI Agent），采用 Bun + TypeScript 构建，使用 Ink (React) 渲染 TUI 界面。核心能力包括：Plan/Execute 双阶段编排、ReAct Loop 执行、多模型路由、工具调用、沙箱隔离和上下文管理。

## 核心架构分层

```
┌─────────────────────────────────────────────────┐
│  TUI 层 (src/tui)          用户交互与渲染        │
├─────────────────────────────────────────────────┤
│  Agent 编排层 (src/agent)  Plan/Execute/ReAct   │
├─────────────────────────────────────────────────┤
│  上下文层 (src/context)    组装/压缩/检索/预算   │
├─────────────────────────────────────────────────┤
│  工具层 (src/tools)        MCP 工具注册与调用    │
├─────────────────────────────────────────────────┤
│  模型路由层 (src/router)   多模型/多Provider路由  │
├─────────────────────────────────────────────────┤
│  基础设施 (src/sandbox, src/storage, src/core)  │
│  沙箱执行 / 持久化 / 事件总线 / 审批注册        │
└─────────────────────────────────────────────────┘
```

## 模块边界表

| 模块 | 职责 | 入口文件 | 关联测试 |
|------|------|----------|----------|
| `src/agent` | Agent 编排核心：Orchestrator 协调 Plan/Execute 双阶段、子 Agent 分派、检查点管理；Executor 执行 ReAct Loop 逐步执行计划 | `src/agent/Orchestrator.ts` | `tests/unit/orchestrator.test.ts`, `tests/unit/executor.test.ts`, `tests/integration/agent.test.ts` |
| `src/context` | 上下文管理：三层上下文组装(L1静态+L2任务+L3检索)、token 预算裁剪、历史压缩、代码图谱、语义搜索、规则加载 | `src/context/Assembler.ts` | `tests/unit/context.test.ts`, `tests/unit/codegraph.test.ts`, `tests/unit/treesitter.test.ts` |
| `src/tools` | MCP 工具注册中心：管理所有内置工具(bash/editFile/grep/glob/git/webSearch等)的注册、查找和调用 | `src/tools/registry.ts` | `tests/integration/tools.test.ts`, `tests/integration/newTools.test.ts` |
| `src/router` | 模型路由器：不同任务用不同模型，平衡能力与成本；支持降级、重试、多 Provider(DeepSeek/Anthropic/OpenAI) | `src/router/ModelRouter.ts` | `tests/unit/router.test.ts`, `tests/unit/providers.test.ts`, `tests/unit/costTracker.test.ts` |
| `src/tui` | TUI 根组件：整合消息列表、工具卡片、审批面板、进度条、输入框；基于 Ink (React) 渲染 | `src/tui/App.tsx` | `tests/unit/todoProgress.test.tsx` |
| `src/sandbox` | 沙箱引擎：命令执行隔离、危险命令拦截(CommandGuard)、检查点回滚管理 | `src/sandbox/SandboxEngine.ts` | `tests/unit/commandGuard.test.ts`, `tests/unit/commandGuardEnhanced.test.ts`, `tests/unit/checkpoint.test.ts` |
| `src/core` | 核心基础设施：事件总线(eventBus)、审批注册(approvalRegistry) | `src/core/eventBus.ts` | `tests/unit/orchestrator.test.ts`（间接覆盖） |
| `src/storage` | 持久化层：SQLite 数据库、迁移管理 | `src/storage/db.ts` | — |
| `src/harness` | 评估引擎：任务加载、执行、验证、报告生成 | `src/harness/Engine.ts` | `tests/eval/harness.test.ts` |

## 核心变更约束

### 必须运行测试的目录

修改以下目录中的任何文件前，**必须**先运行对应测试并确认通过：

| 变更目录 | 必须运行的测试命令 |
|----------|-------------------|
| `src/agent/` | `bun test tests/unit/orchestrator.test.ts tests/unit/executor.test.ts tests/unit/planner.test.ts tests/unit/subagent.test.ts` |
| `src/core/` | `bun test tests/unit/orchestrator.test.ts tests/integration/agent.test.ts` |
| `src/context/` | `bun test tests/unit/context.test.ts tests/unit/codegraph.test.ts` |
| `src/router/` | `bun test tests/unit/router.test.ts tests/unit/providers.test.ts tests/unit/costTracker.test.ts` |
| `src/sandbox/` | `bun test tests/unit/commandGuard.test.ts tests/unit/commandGuardEnhanced.test.ts tests/unit/checkpoint.test.ts` |
| `src/tools/` | `bun test tests/integration/tools.test.ts tests/integration/newTools.test.ts` |

### 通用约束

- 所有变更后运行 `bun run lint` 确保类型检查和代码风格通过
- 新增工具必须在 `src/tools/registry.ts` 注册并在 `src/tools/schemas.ts` 定义 schema
- 修改模型路由逻辑需同步更新 `tests/unit/router.test.ts` 中的用例

## 风险路由：高频变更文件

以下文件变更频率高、影响范围大，修改时需格外谨慎：

| 文件 | 风险说明 | 关联测试路径 |
|------|----------|-------------|
| `src/agent/Orchestrator.ts` | 编排核心，协调所有子系统；变更可能影响整个 Agent 生命周期 | `tests/unit/orchestrator.test.ts`, `tests/integration/agent.test.ts`, `tests/unit/dispatchSubagents.test.ts` |
| `src/agent/Executor.ts` | ReAct Loop 执行引擎；变更影响工具调用、成本追踪、审批流程 | `tests/unit/executor.test.ts`, `tests/integration/agent.test.ts`, `tests/integration/tools.test.ts` |
| `src/context/Assembler.ts` | 上下文组装影响所有 LLM 调用的输入质量 | `tests/unit/context.test.ts` |
| `src/router/ModelRouter.ts` | 模型选择影响全局行为和成本 | `tests/unit/router.test.ts`, `tests/unit/costTracker.test.ts` |
| `src/tools/registry.ts` | 工具注册中心，所有工具调用经过此处 | `tests/integration/tools.test.ts`, `tests/integration/newTools.test.ts` |

## 开发命令速查

```bash
bun run dev          # 开发模式（文件监听）
bun run build        # 构建到 dist/
bun test             # 运行所有测试
bun run test:unit    # 仅单元测试
bun run test:integration  # 仅集成测试
bun run lint         # biome 检查 + tsc 类型检查
bun run format       # biome 格式化
```

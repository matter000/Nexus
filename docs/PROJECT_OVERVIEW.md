# Nexus 项目详解

> 一份面向开发者与用户的全面项目介绍，覆盖架构、模块、工作流、配置与演进历程。
> 基于代码库实际状态整理（2026-08）。

---

## 1. 项目概览

**Nexus** 是一个运行在终端的 AI 编程助手（CLI Coding Agent），核心理念是 **"上下文为王、工具为先、人在环中"**：

- **上下文为王**：通过代码图谱（CodeGraph）与语义检索（SemanticSearch）建立项目全局认知，让 LLM 少猜
- **工具为先**：用工具验证事实，不靠模型猜测
- **人在环中**：关键操作（编辑、危险命令、计划）请求用户审批，支持四档权限模式

### 核心能力一览

| 能力 | 说明 |
|------|------|
| Plan / Execute / Verify 双阶段工作流 | 先探索代码制定计划 → 审批 → 逐步执行 → 独立验证 → 修复循环 |
| Auto 模式 | 跳过规划，LLM 自主拆解任务并执行 |
| 多模型路由 | Anthropic / OpenAI / DeepSeek / 任意 OpenAI 兼容端点，按角色路由 + 成本追踪 + 降级链 |
| Loop Engineering 证据化闭环 | 确定性证据门禁（lint/typecheck/test）+ Maker/Checker 分离验证 + 自动修复循环 |
| 上下文工程 | 三层上下文组装（L1 静态 / L2 任务 / L3 检索）+ Token 预算 + 分级压缩 |
| 多智能体协作 | Supervisor / Fan-out / Pipeline 三种拓扑 + 内置 4 引擎 + worktree 隔离写任务 |
| 安全可控 | 四档权限模式 + CommandGuard 危险命令拦截 + Git Checkpoint 自动回滚 + SSRF 防护 |
| 记忆与学习 | 经验（轨迹快照）→ 教训（提炼知识）→ 技能（固化流程）三级沉淀 |
| 会话持久化 | SQLite 存储，`--resume` 恢复中断会话 |
| 评估引擎 | TOML 任务定义，Mock/Real 双模式，6 种验证规则，CI 回归门 |
| 外部 MCP Server | 可接入任意 MCP 协议工具服务器 |
| Agent Skills / 插件 | SKILL.md 技能沉淀 + 插件加载（渐进式披露 L1 索引 + L2 按需加载） |

---

## 2. 技术栈

| 层 | 技术 | 版本/说明 |
|---|------|----------|
| 运行时 | [Bun](https://bun.sh) | >= 1.1.0（唯一支持，不兼容 Node.js） |
| 语言 | TypeScript | strict 模式 |
| LLM SDK | Vercel AI SDK | `ai@6.0.246`（v6 迁移完成，2026-08） |
| Provider SDK | `@ai-sdk/anthropic@3.0.107` / `@ai-sdk/openai@3.0.91` | DeepSeek 及 OpenAI 兼容端点走 `.chat()` 路由 |
| TUI | Ink v5 + React 18 | 终端渲染 |
| 数据库 | `bun:sqlite` | WAL 模式，单文件 |
| 参数校验 | Zod 4.4.3 | 工具 schema |
| 配置解析 | smol-toml | `.nexus/config.toml` |
| 嵌入模型 | @xenova/transformers | 本地 embedding，无外部 API |
| AST 解析 | tree-sitter-wasm + web-tree-sitter | TS/JS 完整解析 |
| 测试 | `bun test` + Biome | 隔离运行器 + lint |
| MCP | @modelcontextprotocol/sdk | 外部工具服务器接入 |

系统依赖：Git >= 2.30（Checkpoint 版本控制）；可选 ripgrep（grep 加速）。支持 Windows 10+/macOS/Linux（需 true color 终端，TTY 环境）。

---

## 3. 架构分层

```
┌─────────────────────────────────────────────────────┐
│  TUI 层 (src/tui)           用户交互与渲染            │
├─────────────────────────────────────────────────────┤
│  Agent 编排层 (src/agent)   Plan/Execute/ReAct/Loop  │
├─────────────────────────────────────────────────────┤
│  上下文层 (src/context)     组装/压缩/检索/预算        │
├─────────────────────────────────────────────────────┤
│  工具层 (src/tools)         MCP 工具注册与调用         │
├─────────────────────────────────────────────────────┤
│  模型路由层 (src/router)    多模型/多Provider路由      │
├─────────────────────────────────────────────────────┤
│  基础设施 (src/sandbox, src/storage, src/core,       │
│  src/memory, src/harness)   沙箱/持久化/事件/记忆/评估  │
└─────────────────────────────────────────────────────┘
```

### 模块边界表

| 模块 | 职责 | 入口文件 | 关联测试 |
|------|------|----------|----------|
| `src/agent` | Agent 编排核心：Orchestrator 协调 Plan/Execute、子 Agent 分派、检查点、自动修复循环；Executor 执行 ReAct Loop；Planner 规划；AgentEngine 多引擎（Supervisor/Fan-out/Pipeline）；EvidenceGate 证据门禁 | `src/agent/Orchestrator.ts` | `tests/unit/orchestrator.test.ts`, `tests/unit/executor.test.ts`, `tests/unit/planner.test.ts`, `tests/unit/subagent.test.ts`, `tests/integration/agent.test.ts` |
| `src/context` | 上下文管理：三层组装（L1 静态 + L2 任务 + L3 检索）、token 预算裁剪、历史压缩、代码图谱、语义搜索、规则加载 | `src/context/Assembler.ts` | `tests/unit/context.test.ts`, `tests/unit/codegraph.test.ts`, `tests/unit/treesitter.test.ts` |
| `src/tools` | 工具注册中心：管理所有内置工具（bash/editFile/grep/glob/git/webSearch/lsp 等）的注册、查找和调用 | `src/tools/registry.ts` | `tests/integration/tools.test.ts`, `tests/integration/newTools.test.ts` |
| `src/router` | 模型路由器：按任务角色选择模型，平衡能力与成本；降级、重试、多 Provider；成本追踪（含 DeepSeek 峰谷计价） | `src/router/ModelRouter.ts` | `tests/unit/router.test.ts`, `tests/unit/providers.test.ts`, `tests/unit/costTracker.test.ts` |
| `src/tui` | TUI 根组件：消息列表、工具卡片、审批面板、进度条、输入框 | `src/tui/App.tsx` | `tests/unit/taskTimeline.test.tsx` |
| `src/sandbox` | 沙箱引擎：命令执行隔离、危险命令拦截（CommandGuard）、检查点回滚、worktree 管理 | `src/sandbox/SandboxEngine.ts` | `tests/unit/commandGuard.test.ts`, `tests/unit/checkpoint.test.ts` |
| `src/storage` | 持久化层：SQLite 数据库、迁移管理 | `src/storage/db.ts` | — |
| `src/memory` | 学习系统：经验快照、教训提炼、技能固化、检索注入 | `src/memory/MemoryStore.ts` | `tests/unit/memoryStore.test.ts`, `tests/unit/lessonRetriever.test.ts` |
| `src/harness` | 评估引擎：任务加载、执行、验证、报告生成 | `src/harness/Engine.ts` | `tests/eval/harness.test.ts` |
| `src/core` | 核心基础设施：事件总线（eventBus）、审批注册（approvalRegistry） | `src/core/eventBus.ts` | 间接覆盖 |
| `src/cli` | CLI 参数解析、斜杠命令路由 | `src/cli/args.ts` | `tests/unit/args.test.ts`, `tests/integration/cli-args.test.ts` |

---

## 4. 核心工作流

### 4.1 启动链路（`src/index.ts`）

```
解析 CLI 参数 → 加载 config.toml → 读取 secrets（恢复上次模型）
→ 创建 Orchestrator → 后台初始化（CodeGraph / DB / MCP，不阻塞交互）
→ TUI 渲染 或 非交互模式执行 → 退出时持久化模型 + 合并 checkpoint
```

- **非交互模式**（`--non-interactive`）：供 CI/脚本调用，支持 `--output-format json` 结构化输出（含 success/phase/todos/cost）
- **TTY 校验**：非 TTY 环境拒绝启动（Ink raw mode 需要）
- **审批桥接**：入口通过 `core/approvalRegistry`（按 callId 索引的 resolver 注册表）+ `eventBus` 与 TUI 交互，避免 globalThis 反模式

### 4.2 任务执行链路（Orchestrator.submit）

```
用户输入
  ↓
上下文组装（System Prompt + 项目规则 + 代码图谱 + 历史 + 教训/技能注入）
  ↓
┌─ Plan 模式 ──────────────────────────────┐
│ Planner 探索代码 → 生成计划（summary +    │
│ todos + filesToModify）                   │
│ → 用户审批（可反馈重规划 ×3）             │
└──────────────────────────────────────────┘
  ↓
┌─ Execute 阶段 ───────────────────────────┐
│ ReAct Loop（默认最多 50 步）：             │
│   LLM 思考 → 工具调用 → 观察结果 → 循环    │
│ 每步：权限检查 → Diff 预览 → 执行 →        │
│   Checkpoint → 结果回传                    │
│ 护栏：成本上限 / 中断信号 / 卡死检测 nudge  │
│       / 连续编辑失败自动回滚 / 上下文压实   │
│ 步级测试闭环：edit 后自动跑受影响测试       │
└──────────────────────────────────────────┘
  ↓
┌─ Loop Engineering 验证闭环（2026-08 新增）─┐
│ ① 证据门禁：lint / typecheck / test       │
│    （确定性失败直通修复，无需 LLM 复述）   │
│ ② verifier 独立模型语义检查（Maker/Checker│
│    分离，只读工具，最多 5 步）             │
│ ③ 自动修复循环：失败反馈回传重试           │
│    （max_auto_retries 默认 1，验证封顶 2） │
│ ④ 循环报告：轮次/证据/验证/成本汇总        │
└──────────────────────────────────────────┘
  ↓
返回结果（含 ## 验证 区块）
```

### 4.3 验证闭环详解（Loop Engineering L1+L2）

基于 2026-08 前沿调研（Loop-Engineering-Handbook / loop-engineering-guide / 菜鸟教程）实施的证据化核心闭环：

1. **确定性证据门禁**（`src/agent/EvidenceGate.ts`）：任务完成且改动代码时运行 lint/typecheck/test 确定性检查；命令来源三级（config 显式 → 探测 package.json scripts → 跳过）；超时按 skipped 处理；输出截断保留尾部
2. **验证证据化**（`src/agent/Executor.ts`）：证据结果注入 verifyPrompt（"确定性失败无需复述，全绿才做语义检查"）；失败项结构化（`[缺失]/[行为不符]` 开头、`[建议]` 结尾 + evidence 字段）
3. **自动修复循环默认开启**（`src/config.ts`）：`max_auto_retries` 默认 1；证据门禁失败即使 verifier 通过也进修复循环；fixInstruction 证据优先列出
4. **循环 trace 观测**：`LoopTraceRound` 记录每轮（轮次/迭代数/证据/验证结论），循环结束 emit 循环报告（system_info，不污染交付文本）

### 4.4 L3 事件驱动循环（/goal + /loop，2026-08）

Loop 五积木（Automations/Worktrees/Skills/MCP/Sub-agents + State）对照 Claude Code 与 Codex 的产品化形态（2026-03 起 /loop 与 /goal 内建）补齐缺失的**触发器与跨轮次状态**：

| 原语 | 对应实现 | 说明 |
|------|---------|------|
| `/goal` 目标驱动 | `src/agent/GoalLoop.ts` | 跨多次 execute 的验收循环：目标未达成时整个任务重跑（携带上一轮证据/验证摘要）；验收判定**门禁优先 + verifier 兜底**（“测试”→test gate 映射，确定性失败拦截） |
| `/loop` 节拍循环 | `src/agent/LoopState.ts` + `Orchestrator.runLoop` | 按间隔重跑（最小 1 分钟）；状态持久化到 `.nexus/loop-state.md`（人类可读 Markdown + meta JSON，损坏重置）；停止规则：max-rounds / max-cost / 状态文件 stop_requested / Ctrl+C |
| 门面与命令 | `Orchestrator.getLastExecutionSignals` + 斜杠命令 | `/goal <目标> [--max-rounds N] [--max-cost $]`；`/loop <任务> [--interval 10m] [--max-rounds N]` |

与单次 execute 内自动修复（maxAutoRetries）的差异：/goal 是**多次 execute 之间**的循环，适合“目标整体未达成”场景。

### 4.5 本地 Automations（loops.toml 声明式调度，2026-08）

对齐 Codex automations.toml（name/schedule/prompt/budget）与 Claude Code 定时任务体系（heartbeat 形态），补齐 Automations 的**声明式完整形态**：

| 组件 | 实现 | 说明 |
|------|------|------|
| 配置 | `.nexus/loops.toml` `[loops.<name>]` 段 | `schedule`（"10m"/"2h"，≥1m）/ `prompt` / `gates`（lint/typecheck/test）/ `max_cost`（默认 $2）/ `worktree` / `enabled`；单条损坏跳过不阻塞 |
| 调度器 | `src/agent/LoopScheduler.ts` | 会话内自动心跳（Bun setTimeout 链）；到点读状态 → 执行 → 写状态 → 下一轮；启动补跑（错过 2×interval 立即补）；停止：disable / Ctrl+C / 成本超限；同 loop 并发护栏 |
| 命令 | `/loops` | `list`（状态/下次运行/上次结果）、`run-now`、`enable`/`disable`、`inbox`（Triage 分级：[紧急]/[本周]/[观察]） |
| 状态 | `loop-state-<name>.md` | 按 loop 名分文件（防多 loop 覆盖、防"任务失忆"）；findings 分级 meta |

防"失忆"关键设计：每轮携带上一轮状态（对齐 Codex 踩坑复盘——Cron 触发拉起新上下文丢失工具权限/历史状态）。

---

## 5. 模块详解

### 5.1 Agent 编排层（src/agent）

| 文件 | 职责 |
|------|------|
| `Orchestrator.ts` | 编排核心：init/startBackgroundInit/submit/abort/undo、会话恢复、自动修复循环、学习信号采集 |
| `Planner.ts` | Plan 阶段：探索循环（read_file/grep）→ 生成结构化计划（summary/todos/filesToModify/estimatedSteps） |
| `Executor.ts` | Execute 阶段：ReAct Loop 执行引擎（并行/串行工具分离、权限检查、checkpoint、压实、步级测试、验证循环） |
| `ReActLoop.ts` | 共享 LLM 调用工具：streamText + 重试（Retry-After 尊重）+ 成本记录 + 推理内容事件 + 422 自愈 + 降级 |
| `EvidenceGate.ts` | Loop Engineering 证据门禁（2026-08 新增） |
| `SubAgent.ts` | 子 Agent 分派（dispatch_subagent / dispatch_subagents，含 worktree 隔离写任务） |
| `AgentEngine.ts` | 多引擎注册表：内置 explorer/coder/reviewer/researcher 四引擎 |
| `PipelineRunner.ts` | Pipeline 拓扑执行器 |
| `LearningManager.ts` | 学习闭环：任务结果 → determineOutcome → 经验快照 → 教训提炼 |
| `SkillLibrary.ts` / `PluginLoader.ts` | 技能库与插件系统 |
| `SessionManager.ts` | 会话持久化与恢复 |
| `agentsConfig.ts` | `.nexus/agents.toml` 解析（自定义引擎） |

**关键机制**：

- **卡死检测**：连续 8 步无 todo 进展 → 注入纠偏 nudge（Claude Code 模式）到 LLM 消息流，最多 2 次
- **上下文压实**：按窗口占用分档（微压实 / 紧急压实），紧急压实用 summarizer 模型摘要早期迭代，并提示模型回读任务笔记（update_notes 外置状态）
- **步级测试闭环**：edit_file/create_file 成功后自动映射受影响测试（src/**/name.ts → tests 下 name.test.ts(x)）并运行，失败喂回 LLM；同文件去重 + 上限 10 次护栏
- **自动回滚**：同一文件连续 3 次编辑失败 → 自动回滚到上一个良好 checkpoint
- **多引擎协作**：`dispatch_agent`（Supervisor 单引擎）、`dispatch_agents`（Fan-out 并行，最多 3 个，写任务自动串行）、`run_pipeline`（Pipeline 链式）；引擎可自定义模型与工具白名单，深度限制 1 层

### 5.2 上下文工程层（src/context）

| 文件 | 职责 |
|------|------|
| `Assembler.ts` | 三层上下文组装：L1 静态（系统提示 + 项目规则 + 目录树）+ L2 任务（历史 + todo）+ L3 检索（代码图谱 + 语义搜索 + 教训/技能注入）；超预算按优先级裁剪 |
| `CodeGraph.ts` | 多语言代码图谱（TS/JS 全解析 + Python/Go/Rust/Java 正则签名提取），文件监听增量更新 |
| `GraphCache.ts` | 图谱缓存 |
| `SemanticSearch.ts` | 本地 embedding 语义检索（@xenova/transformers） |
| `Compressor.ts` / `Compactor.ts` | 历史压缩：compressHistory（LLM 摘要）/ llmCompressHistory / emergencyCompactMessages / microCompactMessages |
| `TokenBudget.ts` | token 估算与预算管理 |
| `RulesLoader.ts` | `.nexus/rules.toml` 项目规则加载（含 always_include 路径） |
| `FileWatcher.ts` | 外部编辑器修改后自动增量更新索引 |
| `parsers/treesitter.ts` | tree-sitter WASM 解析（TS/JS/TSX/JSX） |

**三层组装原则**：L1 静态层保持稳定（Anthropic 前缀缓存 stable 段）；L3 检索层按任务相关性注入（教训 top-3 / 技能元数据 top-8，各有 token 硬上限防膨胀）。

### 5.3 工具层（src/tools）

注册中心 `registry.ts` 管理 20+ 内置工具，按阶段（plan/execute）过滤暴露：

**只读工具**：`read_file` / `grep` / `glob` / `list_directory` / `search_symbol` / `lsp`（TS 语义诊断/定义/引用）/ `semantic_search`

**写工具**：`edit_file`（diff 生成 + 唯一匹配校验）/ `create_file` / `bash`（信号量限流 3 并发）/ `git`（status/commit/push）/ `update_todo` / `update_notes`（任务笔记外置状态）

**编排工具**：`submit_plan` / `dispatch_agent` / `dispatch_agents` / `run_pipeline` / `dispatch_subagent` / `dispatch_subagents`

**网络工具**：`fetch_url`（SSRF 防护）/ `web_search`

**技能工具**：`load_skill`（渐进式披露 L1 索引 → L2 按需加载正文）

**外部工具**：MCP Server（stdio 启动，工具注册进 ToolRegistry，退出自动断开）

**安全机制**：所有工具经 `requiresApproval` 声明 + `checkPermission`（四档权限模式）；bash 命令经 CommandGuard 危险检测（无论什么模式危险命令强制审批）；路径校验 `isInsideProject`（relative() 检测防同前缀绕过）；fetchUrl 完整 SSRF 防护（私有网段/元数据端点/.internal 域名）。

### 5.4 模型路由层（src/router）

| 文件 | 职责 |
|------|------|
| `ModelRouter.ts` | 角色路由（planner/executor/summarizer/verifier）、内置成本表、降级链（getDistinctFallbackModel） |
| `providers/index.ts` | Provider 适配器（anthropic/openai/deepseek/custom）：模型参数（思考模式/推理强度）、系统提示后缀 |
| `providers/deepseekFetch.ts` | DeepSeek 拦截器：thinking 注入、reasoning_content 契约变换、tool_choice 剥离 |
| `providers/deepseekErrors.ts` | DeepSeek 错误解析（422 思考模式契约错误 → 自愈关闭思考模式重试） |
| `CostTracker.ts` | 成本记录与预算：分级计价（缓存命中/未命中）、DeepSeek 峰谷计价（本地 9-12/14-18 点 2 倍，env 可覆盖） |
| `RateLimiter.ts` | 客户端令牌桶限流（防并发 429） |

**DeepSeek 深度适配**（2026-08，基于官方文档 + 社区 issue 交叉调研）：

- reasoning_content 回传加固：拦截器在 wire 层把 reasoning part 转为顶层 `reasoning_content`、带 tool_calls 缺 reasoning 注入空串兜底（修复 @ai-sdk 剥离导致的 400，opencode #24104 同因）、剥离 tool_choice
- 思考模式默认开启（executor/planner），`NEXUS_DEEPSEEK_THINKING=off` 逃生舱
- 成本表对齐官方现行价 + 峰谷计价

### 5.5 沙箱与安全（src/sandbox）

| 文件 | 职责 |
|------|------|
| `SandboxEngine.ts` | 沙箱接口抽象（当前 TypeScript 实现，v2 规划 GoSandbox：pty + cgroup + syscall 过滤，Agent loop 零改动） |
| `CommandGuard.ts` | 危险命令检测（rm -rf / git push --force / chmod 777 / sudo 等强制审批） |
| `Checkpoint.ts` | Git 自动 checkpoint（每次 edit 提交到 nexus/checkpoints 分支）+ 回滚 + 单文件回滚 |
| `WorktreeManager.ts` | Git worktree 隔离（并行写任务） |

### 5.6 存储与持久化（src/storage）

- `NexusDB`（bun:sqlite，WAL 模式）：`.nexus/nexus.db` 存储会话（sessions）、消息（messages）与学习系统表
- 迁移管理：`migrations/index.ts` 版本化迁移
- 会话恢复：`--resume [id]` 恢复历史上下文与未完成 todo

### 5.7 记忆与学习系统（src/memory）

三级沉淀闭环：

1. **经验（Experience）**：每次任务结束保存轨迹快照（summary / tool_sequence / outcome / error_label / cost / duration）
2. **教训（Lesson）**：失败任务提炼"触发场景 → 建议"（trigger_desc → advice），按命中率与有效性评分治理（LESSON_CAP=200，低分自动归档）
3. **技能（Skill）**：固化流程为 SKILL.md（跨会话复用，渐进式披露注入）

检索：LessonRetriever 按任务 query 检索相关教训，注入系统提示（top-3，≤300 token）。

### 5.8 评估引擎（src/harness）

- TOML 任务定义（`tests/eval/tasks/*.toml`）：fixture 文件 + user_request + validations
- 6 种验证规则：`file_exists` / `file_contains` / `file_not_contains` / `bash_pass` / `bash_fail` / `custom`
- Mock / Real 双模式；`--difficulty` 过滤；`--json` 报告导出
- CI 回归门：配置 `NEXUS_EVAL_API_KEY` 时跑 easy 任务集真实模式（passRate >= 60% + 总成本 < $2 双护栏）

### 5.9 TUI 层（src/tui）

组件：`App` / `MessageList`（Markdown 渲染）/ `ToolCard`（工具调用可视化，含 todo 归属）/ `ApprovalPrompt`（diff 预览审批）/ `PlanApprovalPanel` / `InputBox` / `ModelSelector` / `TaskTimeline` / `ApiConfigPanel` / `LogoBanner` / `LoadingSpinner` / `DiffView` / `theme.ts`（标签配色）。

### 5.10 基础设施（src/core + src/utils）

- `eventBus`：全局事件流（llm_chunk / tool_call / tool_result / cost_update / plan_approval_request / tool_approval_request / file_artifact / checkpoint / system_info...）
- `approvalRegistry`：审批 resolver 注册表（按 callId 索引，TUI 与入口解耦）
- `debugLog`：JSONL 调试日志（`.nexus/debug.jsonl`）；`errorReport`：错误记录；`export`：会话导出 Markdown；`ssrf`：SSRF 防护

---

## 6. 配置体系

| 配置 | 位置 | 说明 |
|------|------|------|
| 项目配置 | `.nexus/config.toml` | 模型角色、providers、权限模式、limits（成本/迭代/超时）、context（压实水位）、checkpoint、mcp_servers、hooks、evidence |
| 密钥 | `~/.nexus/secrets.toml` | 全局 API Key（权限 0600）+ lastModel 持久化 |
| 项目规则 | `.nexus/rules.toml` | testCommand / buildCommand / 代码风格 / 必须包含路径 |
| 引擎配置 | `.nexus/agents.toml` | 自定义子 Agent 引擎（字段级合并） |
| 环境变量 | `.env` | API Key、NEXUS_DEBUG、NEXUS_DEEPSEEK_THINKING、NEXUS_DEEPSEEK_PEAK_*、NEXUS_STALL_TIMEOUT_MS 等 |

**关键配置项**（`[limits]`）：`max_session_cost`（默认 $5.0）/ `bash_timeout` / `max_read_lines` / `max_iterations`（默认 50）/ `max_auto_retries`（默认 1，Loop Engineering 修复循环）。

**`[evidence]` 段**（2026-08 新增）：`lint_command` / `typecheck_command` / `test_command` / `timeout_ms`——确定性证据门禁命令，未配置时自动探测 package.json scripts。

**权限模式**：`ask`（默认，每个写操作询问）/ `auto-edit`（编辑自动，bash 询问）/ `auto-all`（全部自动，危险命令仍强制）/ `yolo`（完全信任）。

---

## 7. 质量保障

### 测试矩阵

| 命令 | 覆盖 |
|------|------|
| `bun run scripts/run-tests-isolated.ts` | 全量 35 文件隔离运行（根治 bun mock.module 跨文件泄漏） |
| `bun run test:unit` | 单元测试（排除 tree-sitter/skill-plugin 分组） |
| `bun run test:unit:tree-sitter` / `test:unit:skillplugin` | 特殊分组（WASM/文件系统敏感） |
| `bun run test:integration` | 集成测试 |
| `bun run lint` | Biome check + tsc --noEmit |
| `bun run scripts/check-import-boundaries.ts` | 模块边界检查（分层 import 约束） |
| `eval:mock` / CI 真实 eval | 端到端任务成功率回归门 |

### 风险路由（高频变更文件）

`Orchestrator.ts` / `Executor.ts` / `Assembler.ts` / `ModelRouter.ts` / `registry.ts` 变更影响面大，修改需运行对应关联测试（AGENTS.md 中有逐目录测试矩阵）。

---

## 8. 近期演进（2026-07 → 2026-08）

| 时间 | 里程碑 |
|------|--------|
| 2026-07 | v0.1.0 发布：四阶段路线图（P0-P3）全部实现——双阶段工作流、15 内置工具、Harness 评估、上下文工程、模型路由、安全沙箱、TUI、会话持久化、外部 MCP |
| 2026-07 | 多智能体协作系统：四引擎 + 三拓扑 + worktree 隔离写任务 + agents.toml 自定义引擎 |
| 2026-07 | 四维优化：可靠性/成本/质量/生态（步级测试闭环、测试工程治理、LSP 语义工具、stuck 检测等） |
| 2026-08 | AI SDK v4 → v6 迁移（maxSteps → stopWhen、tool-result output 判别联合、.chat() 兼容端点路由） |
| 2026-08 | DeepSeek 深度适配（V4 系列）：reasoning_content wire 层契约变换、思考模式默认开启、峰谷计价、成本表对齐 |
| 2026-08 | Loop Engineering 核心闭环（L1+L2 证据化）：EvidenceGate 确定性门禁、验证证据化、自动修复循环默认开启、循环 trace 观测 |
| 2026-08 | **L3 事件驱动循环**：/goal 目标驱动（跨 execute 验收循环，门禁优先 + verifier 兜底）+ /loop 节拍循环（loop-state.md 状态文件、可中断等待、四重停止护栏） |
| 2026-08 | **本地 Automations**：loops.toml 声明式配置 + LoopScheduler 会话内自动心跳 + /loops 命令（list/run-now/enable/disable/inbox Triage 分级） |
| 待规划 | v2 Go 引擎（真沙箱 pty+cgroup、后台索引守护进程）；云端调度（/schedule 形态，引导 GitHub Actions 托管）；L4 trace 驱动自改进；真实 DeepSeek/Loop/Automations 冒烟 |

---

## 9. 开发指南

### 常用命令

```bash
bun run dev          # 开发模式（文件监听）
bun run start        # 启动
bun run build        # 构建到 dist/
bun test             # 运行所有测试
bun run test:isolated# 隔离运行全量测试
bun run lint         # biome + tsc 类型检查
bun run format       # biome 格式化
bun run eval:mock    # 评估引擎 mock 模式
```

### 添加新工具

1. 在 `src/tools/` 创建工具文件（参考 `createFile.ts`）
2. 在 `src/tools/schemas.ts` 添加 schema（v6 需 `jsonSchema()` 包装）
3. 在 `src/tools/registry.ts` 注册（含阶段过滤与审批声明）
4. 在 `src/tui/theme.ts` 添加标签（可选）

### 修改约束（AGENTS.md）

- 改 `src/agent/` 必须跑 orchestrator/executor/planner/subagent 测试；改 `src/router/` 跑 router/providers/costTracker；改 `src/sandbox/` 跑 commandGuard/checkpoint；改 `src/tools/` 跑集成测试
- 所有变更后运行 `bun run lint` + import 边界检查
- 工具参数 schema 必须 Zod/jsonSchema 校验（`resolveToolParameters` 统一包装）

---

## 10. 附录

### 目录结构

```
src/
├── agent/          # 编排核心（Orchestrator/Planner/Executor/ReActLoop/SubAgent/
│                   #   AgentEngine/PipelineRunner/LearningManager/EvidenceGate/
│                   #   SkillLibrary/PluginLoader/SessionManager/Mailbox/TaskBoard）
├── cli/            # CLI 参数 + 斜杠命令
├── context/        # 上下文工程（Assembler/CodeGraph/SemanticSearch/Compressor/
│                   #   Compactor/TokenBudget/RulesLoader/FileWatcher/parsers）
├── core/           # eventBus + approvalRegistry
├── harness/        # 评估引擎（Engine/TaskLoader/Validator/Reporter）
├── memory/         # 学习系统（MemoryStore/LessonRetriever）
├── router/         # 模型路由 + providers + CostTracker + RateLimiter
├── sandbox/        # CommandGuard/Checkpoint/SandboxEngine/WorktreeManager
├── storage/        # SQLite + migrations
├── tools/          # 20+ 内置工具 + registry + schemas
├── tui/            # Ink 组件
└── utils/          # debugLog/errorReport/export/ssrf
```

### 术语表

| 术语 | 含义 |
|------|------|
| ReAct Loop | 推理-行动交替循环（Thought → Action → Observation） |
| Plan-and-Execute | 先规划后执行的双阶段模式 |
| Maker/Checker | 写代码的 Agent（Maker）与独立验证者（Checker）分离，不自我判定完成 |
| EvidenceGate | 确定性证据门禁（lint/typecheck/test），"基于证据循环"的落地 |
| Loop Engineering | 把 Agent 循环当作可设计、可控制、可观测的工程系统 |
| CodeGraph | 多语言代码图谱（符号索引） |
| Checkpoint | Git 自动提交点，支持一键回滚 |
| MCP | Model Context Protocol，工具服务器标准协议 |
| Harness | 评估引擎（任务定义 + 验证规则 + 报告） |
| Skill | SKILL.md 技能沉淀，渐进式披露 |

---

*本文档由代码库实际状态整理生成；详细设计决策见 [DESIGN.md](DESIGN.md)，演进路线见 [ROADMAP.md](ROADMAP.md)，变更记录见 [CHANGELOG.md](../CHANGELOG.md)。*

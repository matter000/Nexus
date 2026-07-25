# Nexus

> 终端 AI Coding Agent — Bun 全栈 TypeScript，像素风蜘蛛 Logo

**核心理念**: 先规划后执行、人在环中审批、每次编辑可回滚。

## 特性

- **🕷️ 像素风 TUI**: 基于 Ink v5 (React for CLI)，16×16 像素蜘蛛 Logo，单色剪影
- **📋 Plan/Execute 双阶段**: 先探索 + 规划 → 审批完整计划（含 todo 和文件列表）→ 逐步执行
- **🤖 Auto 模式**: `/auto` 切换，跳过规划直接执行，LLM 自主拆解任务
- **🔄 重规划循环**: 审批时输入反馈 → Planner 带反馈重新规划（最多 3 次）
- **🔧 14 个工具**: read_file / edit_file / bash / grep / glob / list_directory / search_symbol / fetch_url / update_todo / submit_plan / dispatch_subagent + MCP 外部工具
- **🛡️ 统一安全检查**: 所有工具路径遍历 + URL SSRF 防护由 ToolRegistry 自动执行
- **🗂️ 交互式模型选择器**: `/model` 弹出选择面板，支持添加 OpenAI/Anthropic 兼容自定义端点，可删除
- **🎛️ 运行时模式切换**: `/plan` `/auto` 命令 + 状态栏实时显示当前模式
- **📊 Git Checkpoint**: 每次 edit_file 自动 git commit，支持 undo/jumpTo，`autoCheckpoint` 开关可控
- **💰 成本追踪**: CostTracker 记录每次 LLM 调用的 token 消耗和估算成本
- **🏃 降级与恢复**: 连续 edit 失败 3 次自动提示重读文件；5 步无进展提示用户可中断
- **🪝 Harness Engine**: `nexus eval` 子命令，TOML 任务定义，Mock/真实双模式，终端彩色报告 + JSON 导出
- **🔑 交互式 API 配置**: `/config` 面板，引导式输入 Key/URL/Model，原子写入 `~/.nexus/secrets.toml`

## 快速开始

### 前置要求

- [Bun](https://bun.sh) >= 1.1.0
- [ripgrep](https://github.com/BurntSushi/ripgrep) (grep 工具依赖)
- Git

### 安装

```bash
bun install
```

### 配置

首次运行自动弹出 API 配置面板。也可以手动设置环境变量或 `~/.nexus/secrets.toml`：

```bash
# Anthropic / OpenAI / DeepSeek / 自定义端点都通过 /config 或 /model → 添加新模型 配置
# 支持 OpenAI 兼容和 Anthropic 兼容两种端点类型
```

### 运行

```bash
# 交互式会话
bun run start

# 带初始任务
bun run start "重构 utils 模块"

# 指定模型
bun run start -m claude-sonnet-4-20250514 "修复登录 bug"

# Plan 模式（默认）
nexus "任务描述"

# Auto 模式（跳过规划）
nexus --skip-plan "任务描述"

# 非交互模式
nexus --non-interactive "运行测试并修复失败的用例"
```

### 权限模式

| 模式 | 说明 |
|------|------|
| `ask` | 每个写操作都问（默认） |
| `auto-edit` | edit 自动批准，bash 仍问 |
| `auto-all` | 全部自动（危险命令仍强制问） |
| `yolo` | 全部自动，含危险命令 |

### 斜杠命令

| 命令 | 说明 |
|------|------|
| `/model` | 交互式模型选择器（↑↓ 选择 / d 删除 / 添加新模型） |
| `/plan` | 切换到 Plan 模式（规划→审批→执行） |
| `/auto` | 切换到 Auto 模式（跳过规划直接执行） |
| `/config` | 打开交互式 API 配置面板 |
| `/cost` | 查看本次会话花费 |
| `/clear` | 清除当前上下文 |
| `/undo` | 回滚到上一个检查点 |
| `/history` | 查看会话历史 |
| `/eval` | Harness Engine CLI 入口说明 |
| `/help` | 显示可用命令 |

### Eval（评估）

```bash
# Mock 模式（验证框架，不调 API）
nexus eval tests/eval/tasks/ --mock

# 真实模式（需要 API Key）
nexus eval tests/eval/tasks/ --model claude-sonnet-4-20250514

# 指定单个任务 + JSON 导出
nexus eval tests/eval/tasks/ --task math-rename --json report.json
```

任务用 TOML 定义，支持 6 种验证规则（file_exists / file_contains / bash_pass 等）。

## 技术栈

| 层 | 技术 |
|---|------|
| 运行时 | Bun ≥1.1.0 |
| 语言 | TypeScript (strict) |
| LLM SDK | Vercel AI SDK (`ai` + `@ai-sdk/anthropic` + `@ai-sdk/openai`) |
| TUI | Ink v5 (React for CLI) |
| 数据库 | `bun:sqlite` (WAL模式) |
| 校验 | Zod |
| 配置 | smol-toml |
| 测试 | `bun test` |

全部依赖仅 10 个三方包，其余（SQLite/spawn/build/test）由 Bun 内置提供。

## 架构

```
┌──────────────────────────────────────────┐
│ TUI 层 (Ink + React)                     │
│ App → MessageList, ToolCard, InputBox,   │
│ ApprovalPrompt, PlanApprovalPanel,       │
│ TodoProgress, ModelSelector              │
├──────────────────────────────────────────┤
│ Agent 核心 (Orchestrator)                 │
│ Plan → Approve → Execute → Verify        │
│ ReActLoop.ts (统一 LLM 调用)              │
├──────────────────────────────────────────┤
│ 工具层 (ToolRegistry)                     │
│ 14 个工具 + 统一安全检查                  │
├──────────────────────────────────────────┤
│ 路由层 (ModelRouter)                      │
│ 多 Provider → CostTracker → 降级链       │
├──────────────────────────────────────────┤
│ 基础设施                                  │
│ Checkpoint (git), NexusDB (SQLite),       │
│ ContextAssembler, CodeGraph, TokenBudget  │
└──────────────────────────────────────────┘
```

## 开发

```bash
# 类型检查
bun run lint

# 测试
bun test

# 构建
bun run build
```

## License

MIT

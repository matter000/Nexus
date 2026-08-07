# Nexus — 终端 AI 编程助手

> 生产级终端 Coding Agent，基于 Bun + TypeScript 全栈构建。
> 核心理念：**上下文为王、工具为先、人在环中**。

---

## 目录

- [项目简介](#项目简介)
- [系统要求](#系统要求)
- [安装指南](#安装指南)
- [配置说明](#配置说明)
- [快速上手](#快速上手)
- [使用详解](#使用详解)
- [斜杠命令](#斜杠命令)
- [权限模式](#权限模式)
- [配置文件参考](#配置文件参考)
- [外部 MCP Server](#外部-mcp-server)
- [评估引擎 (Harness)](#评估引擎-harness)
- [架构设计](#架构设计)
- [开发者指南](#开发者指南)
- [常见问题](#常见问题)

---

## 项目简介

Nexus 是一个运行在终端的 AI 编程助手，它能：

- **理解你的代码库**：通过代码图谱（CodeGraph）和语义搜索自动建立项目全局认知
- **规划后执行**：先分析需求制定计划，经你审批后逐步执行修改
- **安全可控**：四档权限模式 + Git Checkpoint 自动回滚，犯错不怕
- **多模型支持**：Anthropic / OpenAI / DeepSeek / 任意 OpenAI 兼容端点
- **成本透明**：实时追踪 token 消耗和费用，支持预算上限

### 核心特性

| 特性 | 说明 |
|------|------|
| Plan/Execute 双阶段 | 先探索代码 → 制定计划 → 审批 → 逐步执行 → 验证 |
| Auto 模式 | 跳过规划，LLM 自主拆解任务并执行 |
| 会话恢复 | `--resume` 恢复上次中断的对话上下文 |
| Git Checkpoint | 每次编辑自动 commit，`/undo` 一键回滚 |
| 编辑回滚 | 连续 3 次编辑失败自动恢复文件到良好状态 |
| 流式 Markdown | 终端内渲染代码块、标题、列表等格式 |
| Diff 预览 | 审批前展示彩色 diff，清楚知道改了什么 |
| LLM 上下文压缩 | 长对话自动用 summarizer 模型压缩历史 |
| 多语言代码图谱 | 支持 TS/JS/Python/Go/Rust/Java 项目结构解析 |
| 文件监听 | 外部编辑器修改文件后自动增量更新索引 |
| 子 Agent 并行 | 多个独立子任务可并行执行 |
| 多引擎协作 | 专用子智能体引擎：Supervisor / Fan-out / Pipeline 三种拓扑 |
| 对话导出 | `/export` 导出完整会话为 Markdown |
| 成本追踪 | 实时显示 token 用量和费用 |
| 外部 MCP Server | 可接入任意 MCP 协议工具服务器 |

---

## 系统要求

### 必需

| 依赖 | 版本要求 | 用途 |
|------|----------|------|
| [Bun](https://bun.sh) | >= 1.1.0 | 运行时（唯一支持，不兼容 Node.js） |
| [Git](https://git-scm.com) | >= 2.30 | Checkpoint 版本控制 |

### 可选

| 依赖 | 用途 |
|------|------|
| [ripgrep](https://github.com/BurntSushi/ripgrep) | grep 工具加速（未安装时降级为内置搜索） |

### 操作系统

- **Windows 10/11**：推荐 Windows Terminal（PowerShell 7+）
- **macOS**：Terminal.app 或 iTerm2
- **Linux**：任意支持 true color 的终端

> ⚠️ **注意**：Nexus 需要在交互式终端中运行（TTY），不支持管道或非交互式环境。

---

## 安装指南

### 第一步：安装 Bun

**Windows (PowerShell)**：
```powershell
irm bun.sh/install.ps1 | iex
```

安装后需要刷新 PATH（或重新打开终端）：
```powershell
# 临时生效（当前会话）
$env:Path = "C:\Users\<你的用户名>\.bun\bin;" + $env:Path

# 验证安装
bun --version
```

**macOS / Linux**：
```bash
curl -fsSL https://bun.sh/install | bash

# 重新加载 shell 配置
source ~/.bashrc  # 或 source ~/.zshrc

# 验证
bun --version
```

### 第二步：克隆项目

```bash
git clone https://github.com/matter000/Nexus.git
cd Nexus
```

### 第三步：安装依赖

```bash
bun install
```

这将安装所有运行时依赖（仅约 10 个三方包）。

### 第四步：验证安装

```bash
# 类型检查（确认环境正确）
bun run lint

# 运行测试
bun test tests/unit/

# 查看版本
bun run start --version
```

如果以上命令都正常执行，安装完成。

---

## 配置说明

Nexus 支持三种配置方式（优先级从高到低）：

1. **CLI 参数**（`--model`、`--permission` 等）
2. **环境变量**（`ANTHROPIC_API_KEY` 等）
3. **配置文件**（`.nexus/config.toml` + `~/.nexus/secrets.toml`）

### 方式一：交互式配置（推荐新手）

首次运行 Nexus 时，如果没有检测到任何 API Key，会自动弹出配置面板：

```bash
bun run start
# 自动进入 API 配置界面，按提示输入即可
```

也可以在运行中使用 `/config` 命令随时打开配置面板。

### 方式二：环境变量

```bash
# Anthropic (Claude)
export ANTHROPIC_API_KEY="sk-ant-..."

# OpenAI (GPT)
export OPENAI_API_KEY="sk-..."

# DeepSeek
export DEEPSEEK_API_KEY="sk-..."

# 自定义 OpenAI 兼容端点
export CUSTOM_API_KEY="your-key"
```

**Windows PowerShell**：
```powershell
$env:ANTHROPIC_API_KEY = "sk-ant-..."
```

**永久设置（Windows）**：
```powershell
[System.Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY", "sk-ant-...", "User")
```

### 方式三：Secrets 文件

API Key 存储在全局 secrets 文件中（不进版本控制）：

```
~/.nexus/secrets.toml
```

格式：
```toml
[providers.anthropic]
api_key = "sk-ant-..."

[providers.openai]
api_key = "sk-..."

[providers.deepseek]
api_key = "sk-..."
base_url = "https://api.deepseek.com"

# 自定义端点（任意名称）
[providers.my-provider]
api_key = "your-key"
base_url = "https://api.example.com/v1"
compatibility = "openai"  # 或 "anthropic"
default_model = "model-name"
```

---

## 快速上手

### 最简使用

```bash
# 进入你的项目目录
cd your-project

# 启动 Nexus
bun run start
```

启动后直接输入自然语言描述你的需求：

```
> 帮我看看 src/utils.ts 里的 formatDate 函数有什么 bug，修复它
```

Nexus 会自动：
1. 读取相关文件理解代码
2. 制定修复计划
3. 展示计划等待你审批
4. 批准后逐步执行修改
5. 运行测试验证

### 带初始任务启动

```bash
bun run start "重构 src/utils 模块，将所有导出函数添加 JSDoc 注释"
```

### 指定模型

```bash
bun run start -m claude-sonnet-4-20250514 "优化数据库查询性能"
bun run start -m gpt-4o "添加单元测试"
bun run start -m deepseek-chat "解释这段代码的作用"
```

---

## 使用详解

### CLI 参数完整列表

```
用法:
  nexus [options] [prompt]

选项:
  -m, --model <model>        指定模型 (e.g. claude-sonnet-4-20250514, gpt-4o, deepseek-chat)
  -p, --provider <provider>  指定 provider (anthropic, openai, deepseek, custom)
  --permission <mode>        权限模式: ask | auto-edit | auto-all | yolo
  --cwd <dir>                项目根目录 (默认: 当前目录)
  --skip-plan                跳过 Plan 阶段，直接执行（Auto 模式）
  --max-iterations <n>       最大迭代步数 (默认: 50)
  --non-interactive          非交互模式，执行完即退出
  --resume [sessionId]       恢复上次会话（或指定会话 ID）
  -v, --verbose              显示详细日志
  --version                  显示版本号
  -h, --help                 显示帮助
```

### 运行模式

#### 交互模式（默认）

```bash
bun run start
```

进入 TUI 界面，支持多轮对话、实时流式输出、工具调用可视化。

#### 非交互模式

```bash
bun run start --non-interactive "运行测试并修复失败的用例"
```

执行完任务后自动退出，适合 CI/CD 或脚本调用。

#### Auto 模式（跳过规划）

```bash
bun run start --skip-plan "给所有函数添加类型注解"
```

不经过 Plan 阶段，LLM 自主拆解任务并直接执行。适合简单、明确的任务。

#### 会话恢复

```bash
# 恢复最近一次会话
bun run start --resume

# 恢复指定会话
bun run start --resume <session-id>
```

中断的对话（Ctrl+C）可以从断点继续，包括历史上下文和未完成的 todo。

### 工作流示例

**示例 1：修复 Bug**
```
> src/router/ModelRouter.ts 的 fallback 逻辑有问题，当主模型超时时没有正确降级

Nexus 会：
1. [Plan] 读取 ModelRouter.ts，分析 fallback 链路
2. [Plan] 制定修复方案（展示给你审批）
3. [Execute] 修改代码
4. [Verify] 运行相关测试确认修复
```

**示例 2：添加功能**
```
> 给用户模块添加邮箱验证功能，注册时发送验证邮件

Nexus 会：
1. [Plan] 探索现有用户模块结构
2. [Plan] 制定实现计划（新建哪些文件、修改哪些接口）
3. [审批] 你可以输入反馈让它调整计划
4. [Execute] 逐步创建和修改文件
5. [Verify] 运行测试验证
```

**示例 3：代码审查**
```
> 审查 src/sandbox/ 目录的安全性，检查是否有命令注入风险
```

---

## 斜杠命令

在交互模式中输入 `/` 开头的命令：

| 命令 | 别名 | 说明 |
|------|------|------|
| `/model [name]` | `/m` | 查看/切换模型（无参数打开交互式选择器） |
| `/config` | `/api` | 打开 API 配置面板 |
| `/plan` | — | 切换到 Plan 模式（规划→审批→执行） |
| `/auto` | — | 切换到 Auto 模式（跳过规划直接执行） |
| `/cost` | — | 查看本次会话花费（含按模型分类明细） |
| `/clear` | `/cls` | 清除当前对话上下文 |
| `/compact` | — | 手动触发上下文压缩 |
| `/undo` | `/u` | 回滚到上一个 Git 检查点 |
| `/resume [id]` | `/r` | 恢复历史会话 |
| `/export [path]` | `/e` | 导出当前会话为 Markdown 文件 |
| `/status` | `/st` | 显示各子系统健康状态 |
| `/help` | `/?` | 显示所有可用命令 |

### 使用示例

```
/model                     ← 打开模型选择器
/model gpt-4o              ← 直接切换到 GPT-4o
/cost                      ← 查看花了多少钱
/undo                      ← 上一步改错了，回滚
/export                    ← 导出对话记录
/status                    ← 检查系统状态
```

---

## 权限模式

控制 Nexus 执行写操作时是否需要你的批准：

| 模式 | 说明 | 适用场景 |
|------|------|----------|
| `ask` | 每个写操作（edit/bash）都询问（**默认**） | 日常使用，最安全 |
| `auto-edit` | 文件编辑自动批准，bash 命令仍询问 | 信任 AI 的代码修改 |
| `auto-all` | 全部自动（危险命令仍强制询问） | 快速迭代 |
| `yolo` | 全部自动，包括危险命令 | 完全信任（慎用） |

### 切换方式

```bash
# CLI 参数
bun run start --permission auto-edit

# 配置文件 (.nexus/config.toml)
[permissions]
mode = "auto-edit"
```

### 危险命令保护

无论什么权限模式，以下命令始终需要手动确认：
- `rm -rf`、`del /s`（删除操作）
- `git push --force`（强制推送）
- `chmod 777`（权限修改）
- 涉及 `sudo` 的命令

---

## 配置文件参考

项目级配置文件位于 `.nexus/config.toml`：

```toml
# ═══ 模型配置 ═══
[models]
planner = "auto"       # Plan 阶段模型（"auto" 自动选择）
executor = "auto"      # Execute 阶段模型
summarizer = "auto"    # 摘要/压缩用模型（轻量）
verifier = "auto"      # 验证阶段模型

# ═══ Provider 配置 ═══
[models.providers.anthropic]
api_key_env = "ANTHROPIC_API_KEY"
default_model = "claude-sonnet-4-20250514"

[models.providers.openai]
api_key_env = "OPENAI_API_KEY"
default_model = "gpt-4o"

[models.providers.deepseek]
api_key_env = "DEEPSEEK_API_KEY"
base_url = "https://api.deepseek.com"
default_model = "deepseek-chat"

# 自定义 OpenAI 兼容端点（Moonshot/智谱/硅基流动等）
[models.providers.custom]
api_key_env = "CUSTOM_API_KEY"
base_url = "https://api.moonshot.cn/v1"
default_model = "moonshot-v1-8k"

# ═══ 权限 ═══
[permissions]
mode = "ask"           # ask | auto-edit | auto-all | yolo

# ═══ 限制 ═══
[limits]
max_session_cost = 5.0    # 每会话最大花费（美元）
bash_timeout = 30         # bash 命令超时（秒）
max_read_lines = 2000     # 文件读取最大行数
max_iterations = 50       # Agent 最大迭代步数
max_output_bytes = 102400 # bash 输出最大字节

# ═══ 上下文 ═══
[context]
budget_ratio = 0.8        # Token 预算占上下文窗口比例
recent_turns_keep = 5     # 近期完整保留的对话轮数

# ═══ 检查点 ═══
[checkpoint]
auto_checkpoint = true    # 是否自动 git commit
branch = "nexus/checkpoints"  # checkpoint 分支名
```

---

## 外部 MCP Server

Nexus 支持接入 [Model Context Protocol](https://modelcontextprotocol.io) 外部工具服务器，扩展能力边界。

### 配置方法

在 `.nexus/config.toml` 中添加：

```toml
# 文件系统增强
[[mcp_servers]]
name = "filesystem"
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "."]

# 跨会话记忆
[[mcp_servers]]
name = "memory"
command = "npx"
args = ["-y", "@modelcontextprotocol/server-memory"]

# Git 增强
[[mcp_servers]]
name = "git"
command = "npx"
args = ["-y", "@modelcontextprotocol/server-git", "--repository", "."]
```

### 工作原理

1. Nexus 启动时读取 `[[mcp_servers]]` 配置
2. 逐个启动外部 Server 进程（stdio 通信）
3. 获取 Server 提供的工具列表
4. 注册到 ToolRegistry，LLM 可像内置工具一样调用
5. 退出时自动断开所有连接

---

## 评估引擎 (Harness)

用于测试和评估 Nexus 的代码修改能力：

### 基本用法

```bash
# Mock 模式（验证框架流程，不调 API）
bun run start eval tests/eval/tasks/ --mock

# 真实模式（需要 API Key）
bun run start eval tests/eval/tasks/

# 指定单个任务
bun run start eval tests/eval/tasks/ --task math-rename

# 导出 JSON 报告
bun run start eval tests/eval/tasks/ --json report.json
```

### 任务定义格式

任务用 TOML 文件定义（`tests/eval/tasks/*.toml`）：

```toml
id = "fix-divzero"
description = "修复除零错误"
user_request = "src/math.ts 的 divide 函数在除数为 0 时会崩溃，请添加检查"

[fixture]
files = { "src/math.ts" = "..." }

[[validations]]
type = "file_contains"
path = "src/math.ts"
pattern = "if.*===.*0"

[[validations]]
type = "bash_pass"
command = "bun test"
```

支持 6 种验证规则：`file_exists`、`file_contains`、`file_not_contains`、`bash_pass`、`bash_fail`、`custom`。

---

## 技术栈

| 层 | 技术 |
|---|------|
| 运行时 | Bun ≥1.1.0（唯一支持，不兼容 Node.js） |
| 语言 | TypeScript (strict) |
| LLM SDK | Vercel AI SDK (`ai` + `@ai-sdk/anthropic` + `@ai-sdk/openai`) |
| TUI | Ink v5 (React for CLI) |
| 数据库 | `bun:sqlite` (WAL 模式) |
| 校验 | Zod |
| 配置 | smol-toml |
| 测试 | `bun test` |

全部依赖仅约 10 个三方包，其余（SQLite/spawn/build/test）由 Bun 内置提供。

## 架构设计

```
┌─────────────────────────────────────────────────────┐
│                    TUI 层 (Ink + React)              │
│  App → MessageList(Markdown渲染), ToolCard,          │
│  InputBox, ApprovalPrompt(Diff预览),                 │
│  PlanApprovalPanel, TodoProgress, ModelSelector      │
├─────────────────────────────────────────────────────┤
│              Agent 编排层 (Orchestrator)              │
│  Plan → Approve → Execute(ReAct Loop) → Verify      │
│  SubAgent(多引擎: 单/并行/流水线) ← Checkpoint(自动回滚) │
├─────────────────────────────────────────────────────┤
│              上下文工程层 (Context)                    │
│  Assembler(L1/L2/L3) + CodeGraph(多语言AST)         │
│  + SemanticSearch(Embedding) + Compressor(LLM压缩)  │
│  + TokenBudget + FileWatcher(增量索引)               │
├─────────────────────────────────────────────────────┤
│              工具层 (ToolRegistry)                    │
│  21个内置工具 + 统一安全检查 + 外部MCP工具           │
│  read_file / edit_file / create_file / bash /        │
│  grep / glob / list_directory / search_symbol /      │
│  fetch_url / semantic_search / update_todo /         │
│  submit_plan / dispatch_agent / dispatch_agents /    │
│  run_pipeline / dispatch_subagent / dispatch_subagents│
├─────────────────────────────────────────────────────┤
│              模型路由层 (ModelRouter)                 │
│  多Provider → 角色路由 → CostTracker → 降级链        │
├─────────────────────────────────────────────────────┤
│              基础设施层                               │
│  Checkpoint(Git) + NexusDB(SQLite) + Config(TOML)   │
│  + Secrets + EventBus + DebugLog                     │
└─────────────────────────────────────────────────────┘
```

### 执行流程

```
用户输入
  ↓
上下文组装 (System Prompt + 历史 + 代码图谱)
  ↓
┌─ Plan 模式 ─────────────────────────┐
│  Planner 探索代码 → 生成计划         │
│  → 用户审批（可反馈重规划 ×3）       │
└─────────────────────────────────────┘
  ↓
┌─ Execute 阶段 ──────────────────────┐
│  ReAct Loop (最多 50 步):            │
│    LLM 思考 → 调用工具 → 观察结果    │
│    → 循环直到完成                    │
│  每步: 权限检查 → Diff预览 → 执行    │
│       → Checkpoint → 结果回传        │
└─────────────────────────────────────┘
  ↓
┌─ Verify 阶段 ───────────────────────┐
│  独立验证者 (mini ReAct, 5步):       │
│    read_file 检查修改 + bash 跑测试  │
│    → 输出验证报告                    │
└─────────────────────────────────────┘
  ↓
返回结果
```

## 多智能体引擎协作

Nexus 内置多引擎协作体系：多个专用子智能体引擎可协同完成复杂任务，由主 Agent 按任务性质动态选择协作拓扑。

### 内置引擎

| 引擎 | 角色 | 写权限 | 工具范围 |
|------|------|--------|----------|
| `explorer` | 只读探索代码库 | 否 | read_file / grep / glob / list_directory / search_symbol / semantic_search |
| `coder` | 可写编码实现 | 是 | 读写工具 + bash + git（受权限控制） |
| `reviewer` | 只读代码审查 | 否 | 只读工具，输出分级审查报告 |
| `researcher` | 联网调研 | 否 | web_search / fetch_url + 只读工具 |

### 协作拓扑

| 拓扑 | 工具 | 说明 |
|------|------|------|
| Supervisor | `dispatch_agent` | 单引擎调度，按引擎名路由（需审批） |
| Fan-out | `dispatch_agents` | 多引擎并行（最多 3 个），写任务自动串行 |
| Pipeline | `run_pipeline` | 引擎链式执行，前序输出作为后序输入（需审批） |

所有引擎均有独立角色提示词、工具白名单与上下文窗口，只返回最终摘要；深度限制 1 层（引擎内不可再分派）。引擎可指定独立模型（缺省用 executor 模型），成本按该模型路由计费。

### 自定义引擎

通过 `.nexus/agents.toml` 覆盖内置引擎或新增自定义引擎（字段级合并，缺省字段沿用内置值）：

```toml
[[agents]]
name = "translator"                     # 新增引擎名
description = "翻译引擎：中英互译与术语统一"
system_prompt = "你是翻译引擎，只读分析代码中的文案…"
model = "deepseek-v4-flash"             # 可选：指定模型（缺省用 executor）
tools = ["read_file", "grep", "glob"]   # 工具白名单
writable = false
max_iterations = 6
```

配置问题仅告警不阻塞；未知工具名会被跳过并提示。

---

## 开发者指南

### 项目结构

```
src/
├── agent/          # Agent 核心（Orchestrator, Planner, Executor, SubAgent）
├── cli/            # CLI 参数解析 + 斜杠命令
├── context/        # 上下文工程（Assembler, CodeGraph, Compressor, SemanticSearch）
│   └── parsers/    # 多语言正则解析器（Python/Go/Rust/Java）
├── core/           # EventBus 事件总线
├── harness/        # 评估引擎
├── router/         # 模型路由 + 成本追踪
├── sandbox/        # 沙箱（CommandGuard, Checkpoint）
├── storage/        # SQLite 存储层
├── tools/          # 15 个内置工具
├── tui/            # TUI 组件（Ink + React）
│   └── components/ # UI 组件（MessageList, DiffView, Markdown...）
└── utils/          # 工具函数（debugLog, export）
```

### 常用命令

```bash
# 开发模式（文件变更自动重启）
bun run dev

# 类型检查
bun run lint

# 运行所有测试
bun test

# 仅单元测试
bun run test:unit

# 仅集成测试
bun run test:integration

# 构建
bun run build
```

### 添加新工具

1. 在 `src/tools/` 创建工具文件（参考 `createFile.ts`）
2. 在 `src/tools/schemas.ts` 添加 Zod 校验 schema
3. 在 `src/tools/registry.ts` 注册工具
4. 在 `src/tui/theme.ts` 添加标签（可选）

### 技术栈

| 层 | 技术 |
|---|------|
| 运行时 | Bun >= 1.1.0（唯一支持） |
| 语言 | TypeScript (strict) |
| LLM SDK | Vercel AI SDK (`ai` + `@ai-sdk/anthropic` + `@ai-sdk/openai`) |
| TUI | Ink v5 (React for CLI) |
| 数据库 | `bun:sqlite` (WAL 模式) |
| 参数校验 | Zod |
| 配置解析 | smol-toml |
| 测试 | `bun test` |
| MCP | @modelcontextprotocol/sdk |

---

## 常见问题

### Q: `bun` 命令找不到？

**Windows**：安装后需手动添加 PATH：
```powershell
$env:Path = "C:\Users\<用户名>\.bun\bin;" + $env:Path
```
或重新打开终端。

**macOS/Linux**：
```bash
source ~/.bashrc  # 或 ~/.zshrc
```

### Q: 启动报错 "EINVAL" 或 "需要交互式终端"？

Nexus 需要真正的终端（TTY）。请确保：
- 在 Windows Terminal / PowerShell / CMD 中直接运行
- 不要通过管道或重定向调用
- VS Code 内置终端需升级到最新版本

### Q: 如何切换模型？

三种方式：
1. 交互模式中输入 `/model`
2. CLI 参数：`-m gpt-4o`
3. 配置文件：`[models] executor = "gpt-4o"`

### Q: 如何控制花费？

- 配置 `max_session_cost`（默认 $5.0），超过后自动暂停
- 使用 `/cost` 实时查看花费
- 选择更便宜的模型（如 `deepseek-chat`、`gpt-4o-mini`）

### Q: 编辑改错了怎么办？

- `/undo`：回滚到上一个检查点
- 连续 3 次编辑同一文件失败时，Nexus 会自动回滚该文件
- Checkpoint 分支保留所有历史，可以 `git log nexus/checkpoints` 查看

### Q: 如何恢复之前中断的会话？

```bash
bun run start --resume          # 恢复最近一次
/resume                         # 交互模式中恢复
/resume <session-id>            # 恢复指定会话
```

### Q: 支持哪些编程语言的项目？

- **完整支持**（AST 级解析）：TypeScript、JavaScript、TSX、JSX
- **基础支持**（正则签名提取）：Python、Go、Rust、Java
- **工具可用**（读取/编辑/搜索）：任何文本文件

### Q: 如何接入国内大模型？

在 `/config` 或 `/model` → "添加新模型" 中配置：
- **Moonshot (Kimi)**：base_url = `https://api.moonshot.cn/v1`
- **智谱 (GLM)**：base_url = `https://open.bigmodel.cn/api/paas/v4`
- **硅基流动**：base_url = `https://api.siliconflow.cn/v1`
- **DeepSeek**：内置支持，直接配置 API Key 即可

所有 OpenAI 兼容端点均可接入。

---

## License

MIT

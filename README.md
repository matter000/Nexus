# Nexus — 终端 AI 编程助手

> 生产级终端 Coding Agent，基于 Bun + TypeScript 全栈构建。
> 核心理念：**上下文为王、工具为先、人在环中**。

![version](https://img.shields.io/badge/version-1.0.0-blue)
[Release v1.0.0](https://github.com/matter000/Nexus/releases/tag/v1.0.0)（含 Windows 独立可执行文件）

---

## 目录

- [项目简介](#项目简介)
- [系统要求](#系统要求)
- [安装指南](#安装指南)
- [配置说明](#配置说明)
- [快速上手](#快速上手)
- [使用详解](#使用详解)
- [斜杠命令](#斜杠命令)
- [Loop Engineering 四层循环](#loop-engineering-四层循环)
- [权限模式](#权限模式)
- [配置文件参考](#配置文件参考)
- [外部 MCP Server](#外部-mcp-server)
- [评估引擎 (Harness)](#评估引擎-harness)
- [云端调度](#云端调度)
- [学习与记忆系统](#学习与记忆系统)
- [架构设计](#架构设计)
- [文档](#文档)
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
| Loop Engineering 四层循环 | L1 ReAct 执行 → L2 证据门禁验证 → L3 事件驱动（/goal /loop /loops）→ L4 trace 驱动自改进 |
| 证据门禁（EvidenceGate） | 完成时确定性运行 lint/typecheck/test，失败自动进入修复循环 |
| verifier 独立验证 | Maker/Checker 分离：写代码的 Agent 不自判完成 |
| 多模型路由 | Anthropic / OpenAI / DeepSeek / 任意 OpenAI 兼容端点；角色路由 + 降级链 + 成本追踪 |
| DeepSeek 深度适配 | 思考模式默认开启（wire 层契约变换）、峰谷计价、422 错误自愈 |
| 上下文工程 | 三层组装（L1 静态/L2 任务/L3 检索）+ Token 预算 + 分级压缩 + 代码图谱 + 语义检索 |
| 多智能体协作 | 4 内置引擎 × 3 拓扑（Supervisor/Fan-out/Pipeline）+ worktree 隔离 + 任务板/信箱 |
| 学习与记忆 | 经验 → 教训 → 技能三级沉淀；教训检索注入上下文；L4 循环失败模式聚类反哺 |
| 评估引擎 | 23 个 TOML 任务 + Mock/Real 双模式 + CI 回归门（通过率/成本双门槛） |
| 云端调度模板 | GitHub Actions workflow 模板，关机照常运行 |
| 会话恢复 | `--resume` 恢复上次中断的对话上下文 |
| Git Checkpoint | 每次编辑自动 commit，`/undo` 一键回滚 |
| 安全可控 | 四档权限模式 + CommandGuard 危险命令拦截 + SSRF/路径防护 |
| 外部 MCP Server | 可接入任意 MCP 协议工具服务器；另附独立 MCP Server 供外部宿主挂载 |

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

### 方式 A：一行命令安装（Windows，推荐）

```powershell
irm https://raw.githubusercontent.com/matter000/Nexus/main/install.ps1 | iex
```

脚本自动完成：下载 Release 安装包 → 安装到 `~/.nexus/bin` → 配置 PATH → 校验版本。

可选参数：

```powershell
irm <url> | iex -Version 1.0.0        # 指定版本
irm <url> | iex -InstallDir D:\tools   # 自定义安装目录
```

> 仓库转 public 后此命令对外可用；当前 private 期间可先下载脚本本地执行：`iex (irm https://raw.githubusercontent.com/matter000/Nexus/main/install.ps1)` 需认证，或直接下载 [Release 安装包](#方式-b直接下载安装包-windows)。
> 国内网络：先开启加速器，或用代理前缀 `https://githubproxy.cc/<下载地址>`。

### 方式 B：直接下载安装包（Windows）

从 [Release v1.0.0](https://github.com/matter000/Nexus/releases/tag/v1.0.0) 下载 `nexus-windows-x64.exe`（约 108MB，独立可执行，无需 Bun），放入任意 PATH 目录即可：

```powershell
nexus                      # 启动
nexus --version            # Nexus v1.0.0
```

### 方式 C：bun link 全局安装（开发用）

```bash
git clone https://github.com/matter000/Nexus.git
cd Nexus
bun install
bun link                  # 全局 nexus 命令指向源码，改代码即时生效
```

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

在交互模式中输入 `/` 开头的命令（支持 Tab 补全 / ↑↓ 选择 / Ctrl+R 历史搜索）：

### 模型

| 命令 | 别名 | 说明 |
|------|------|------|
| `/model [name]` | `/m` | 查看/切换模型（无参数打开交互式选择器） |
| `/config` | `/api` | 打开 API 配置面板 |
| `/cost` | — | 查看本次会话花费（含按模型分类、缓存命中与推理统计） |

### 会话

| 命令 | 别名 | 说明 |
|------|------|------|
| `/plan` / `/auto` | — | 切换 Plan（规划→审批→执行）/ Auto（直接执行）模式 |
| `/clear` | `/cls` | 清除当前对话上下文 |
| `/compact` | — | 手动触发上下文压缩 |
| `/undo` | `/u` | 回滚到上一个 Git 检查点 |
| `/resume [id]` | `/r` | 恢复历史会话 |
| `/export [path]` | `/e` | 导出当前会话为 Markdown 文件 |
| `/status` | `/st` | 显示各子系统健康状态 |
| `/search <词>` | `/s` | 搜索历史会话消息 |
| `/errors [n]` | `/err` | 查看最近错误报告 |

### 循环

| 命令 | 说明 |
|------|------|
| `/goal <目标> [--max-rounds N] [--max-cost $]` | 目标驱动循环：反复执行直到验收通过（门禁优先 + verifier 兜底） |
| `/loop <任务> [--interval 10m] [--max-rounds N]` | 节拍循环：按间隔重跑，状态持久化到 loop-state 文件 |
| `/loops [run-now\|enable\|disable <name>\|inbox]` | 本地 Automations：管理 loops.toml 定时循环 |
| `/autofix [0-3]` | `/af` | 查看/设置自动修复重试次数（默认 1） |

### 工具

| 命令 | 说明 |
|------|------|
| `/eval` | 运行评估任务（TUI 入口） |
| `/memory` | `/mem` | 查看/管理学习记忆（经验/教训/技能） |
| `/plugins` | `/plugin` | 查看已安装插件 |
| `/help` | `/?` | 按分组显示所有可用命令 |

### 使用示例

```
/model                     ← 打开模型选择器
/model gpt-4o              ← 直接切换到 GPT-4o
/goal "让所有测试通过"      ← 目标驱动循环
/loop "检查依赖更新" --interval 10m
/cost                      ← 查看花了多少钱
/undo                      ← 上一步改错了，回滚
/export                    ← 导出对话记录
/status                    ← 检查系统状态
```

---

## Loop Engineering 四层循环

Nexus 实现了 LangChain Loop Engineering 的四层循环体系（`docs/ROADMAP.md` 有各层落地记录）：

```
L4 Hill-Climbing（trace 驱动自改进）: loop_traces 持久化 → 失败模式聚类 → 教训反哺 → 下次任务检索注入
L3 Event-Driven: /goal 目标驱动 + /loop 节拍 + /loops 本地 Automations（LoopScheduler 心跳）
L2 Verification: EvidenceGate 确定性门禁（lint/typecheck/test）+ verifier 独立验证 + 自动修复循环
L1 Agent Loop: ReAct（Planner/Executor 双阶段执行）
```

### L2 证据门禁与修复循环

- **证据门禁**：任务完成且改码时，确定性运行 lint/typecheck/test（命令三级来源：config → package.json 探测 → 跳过）
- **Maker/Checker 分离**：verifier 角色用独立模型 + 只读工具验证（≤5 步），输出结构化结论（pass/failures+evidence）
- **自动修复**：`max_auto_retries` 默认 1（`/autofix` 可调 0-3）；证据门禁失败即使 verifier 通过也进修复；验证修复封顶 2 次

### L3 事件驱动

| 命令 | 机制 | 典型场景 |
|------|------|----------|
| `/goal` | 跨多次 execute 的验收循环：每轮跑门禁+verifier，直到验收通过或达轮次/成本上限 | 让所有测试通过、让 lint 清零 |
| `/loop` | 按间隔重跑任务，`loop-state.md` 状态文件防“任务失忆”（外部改 `stop_requested` 可停止） | 定时巡检、监控 |
| `/loops` | `loops.toml` 声明式配置，会话内心跳（最小 1m，setTimeout 链无 cron 依赖） | 本地自动化值班 |

### L4 trace 驱动自改进

- 循环轨迹（轮次/迭代/证据/验证/成本）持久化到 `loop_traces` 表
- 会话末按失败模式聚类（count ≥ 3），生成教训：advice 优先 LLM 精化（`NEXUS_L4_REFINE=off` 关闭），失败降级模板文案

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

# 运行时快捷键：Shift+Tab 轮换 ask → auto-edit → auto-all → yolo（状态栏显示当前模式）
```

### 审批交互（TUI）

- `y`/`Enter` 批准 · `n`/`Esc` 拒绝 · `a` 自动批准此类（本会话）
- `x` 拒绝并输入原因（反馈给 LLM，避免盲目重试同一操作）
- 计划审批：`Enter` 批准 · `n` 拒绝 · `e` 输入修改意见触发带反馈重规划（最多 3 次）

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

用于测试和评估 Nexus 的代码修改能力（当前 23 个任务：easy 7 / medium 11 / hard 5）：

### 基本用法

```bash
# Mock 模式（验证框架流程，不调 API）
bun run start eval tests/eval/tasks --mock

# 真实模式（需要 API Key）
bun run start eval tests/eval/tasks --real --difficulty easy

# 指定单个任务
bun run start eval tests/eval/tasks --real --task generic-stack

# 导出 JSON 报告
bun run start eval tests/eval/tasks --real --json report.json
```

CI 真实门：passRate ≥60% 且总成本 <$2（由 `NEXUS_EVAL_API_KEY` secret 触发）。

### 任务定义格式

任务用 TOML 文件定义（`tests/eval/tasks/*.toml`）：

```toml
[id]
name = "修复除零错误"
category = "bug-fix"
difficulty = "easy"
description = "修复 divide 函数除零崩溃"

[request]
user_prompt = "修复 src/math.ts 的 divide 函数在除数为 0 时崩溃的问题"

[[initial_files]]
path = "src/math.ts"
content = """
export function divide(a: number, b: number): number {
  return a / b
}
"""

[[validate]]
type = "file_contains"
path = "src/math.ts"
pattern = "=== 0"

[[validate]]
type = "bash_pass"
command = "bun test 2>&1"
```

支持 7 种验证规则：`file_exists` / `file_not_exists` / `file_contains` / `file_not_contains` / `bash_pass` / `bash_output_contains` / `no_extra_files`（diff 干净度，防 agent 改任务范围外文件）。

### 真实回归基线（2026-08）

- easy 5/7（71%）、medium 4/11、hard 1/5；非环境性真失败仅 2 个（模型行为，已记录基线）
- 真实回归驱动修复：Validator 的 .git / PowerShell 缓存误报、任务定义规则过严等

---

## 云端调度

让 Nexus 任务在本地关机/合盖后照常运行——把 loops.toml 式任务“搬上” GitHub Actions。

- 模板：`.github/workflows/nexus-cloud-automation.yml`（默认仅手动触发，取消 cron 注释即启用）
- 文档：[`docs/CLOUD_SCHEDULING.md`](docs/CLOUD_SCHEDULING.md)（映射表/启用 5 步/防失忆/多任务扩展）
- 复用 `--non-interactive --output json` CLI 入口，任务 prompt 与 workflow 解耦（`.nexus/cloud-tasks/<name>.prompt`）
- 防失忆：loop-state 文件提交回仓库，下一轮从上次进度继续

---

## 学习与记忆系统

```
经验（experiences）：每次任务快照（summary/tool_sequence/outcome/error_label/cost）
  ↓ 会话末 Reflector（LLM 反思，≤5 条水位线）
教训（lessons）：trigger_desc+advice，评分治理（低分自动归档），检索注入下次任务上下文（top-3）
  ↓ 高频复用
技能（skills）：固化 SKILL.md，渐进式披露（L1 索引注入 + L2 load_skill 按需加载）
L4 循环 trace：失败模式聚类 → 模板化/LLM 精化教训（NEXUS_L4_REFINE 开关）
```

常用命令：`/memory`（查看/删除）、`/memory skills`（技能列表）

---

## 技术栈

| 层 | 技术 |
|---|------|
| 运行时 | Bun ≥1.1.0（唯一支持，不兼容 Node.js） |
| 语言 | TypeScript (strict) |
| LLM SDK | Vercel AI SDK v6 (`ai` + `@ai-sdk/anthropic` + `@ai-sdk/openai`) |
| TUI | Ink v5 (React for CLI) |
| 代码解析 | tree-sitter-wasm（多语言 AST）+ TypeScript Compiler API |
| 语义检索 | @xenova/transformers（本地 embedding） |
| 数据库 | `bun:sqlite` (WAL 模式) |
| 校验 | Zod 4 |
| 配置 | smol-toml |
| 测试 | `bun test` + 隔离运行器 |

## 架构设计

```
┌─────────────────────────────────────────────────────┐
│                    TUI 层 (Ink + React)              │
│  App → MessageList(Markdown渲染), ToolCard,          │
│  InputBox, ApprovalPrompt(x拒绝原因/Diff预览),       │
│  PlanApprovalPanel(e修改意见), TaskTimeline,          │
│  AgentRunList, ModelSelector, LogoBanner             │
├─────────────────────────────────────────────────────┤
│              Agent 编排层 (Orchestrator)              │
│  Plan → Approve(可反馈重规划) → Execute(ReAct Loop)   │
│    → EvidenceGate(门禁) → Verify(独立验证) → 修复循环  │
│  GoalLoop / LoopState / LoopScheduler（L3 事件驱动）  │
│  LearningManager（经验/教训/技能/L4 trace）           │
│  SubAgent(多引擎: 单/并行/流水线) ← Checkpoint(自动回滚)│
├─────────────────────────────────────────────────────┤
│              上下文工程层 (Context)                    │
│  Assembler(L1/L2/L3) + CodeGraph(多语言AST)         │
│  + SemanticSearch(Embedding) + Compressor(LLM压缩)  │
│  + TokenBudget + FileWatcher(增量索引)               │
├─────────────────────────────────────────────────────┤
│              工具层 (ToolRegistry)                    │
│  24+ 内置工具 + 统一安全检查 + 外部MCP工具            │
├─────────────────────────────────────────────────────┤
│              模型路由层 (ModelRouter)                 │
│  多Provider → 角色路由 → CostTracker → 降级链        │
│  DeepSeek 适配(thinking注入/峰谷计价/422自愈)         │
├─────────────────────────────────────────────────────┤
│              基础设施层                               │
│  Checkpoint(Git) + NexusDB(SQLite) + Config(TOML)   │
│  + Secrets + EventBus + 记忆库(经验/教训/技能/trace) │
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
│  证据门禁: lint/typecheck/test 确定性检查 │
│  独立验证者 (verifier, ≤5步):        │
│    read_file 检查修改 + bash 跑测试  │
│    → 结构化结论（pass/failures）      │
│  失败 → 自动修复循环（max_auto_retries）│
└─────────────────────────────────────┘
  ↓
返回结果（含 ## 验证 区块）
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

## 文档

| 文档 | 说明 |
|------|------|
| [`docs/PROJECT_DETAILS.md`](docs/PROJECT_DETAILS.md) | 项目详解（技术栈/结构/架构/工作流/数据/配置/测试/依赖关系） |
| [`docs/DESIGN.md`](docs/DESIGN.md) | 设计契约（与代码冲突处以代码为准） |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | 演进路线与已完成记录（含真实回归基线） |
| [`docs/CLOUD_SCHEDULING.md`](docs/CLOUD_SCHEDULING.md) | 云端调度使用指南 |
| [`AGENTS.md`](AGENTS.md) | Agent 协作指南（模块边界/测试约束） |

---

## 开发者指南

### 项目结构

```
src/
├── agent/          # Agent 核心（Orchestrator, Planner, Executor, SubAgent, Loop 体系）
├── cli/            # CLI 参数解析 + 斜杠命令
├── context/        # 上下文工程（Assembler, CodeGraph, Compressor, SemanticSearch）
│   └── parsers/    # 多语言解析（tree-sitter WASM + 正则兜底）
├── core/           # EventBus 事件总线 + 审批注册表
├── harness/        # 评估引擎
├── memory/         # 学习系统（经验/教训/技能/trace 存储与检索）
├── router/         # 模型路由 + 成本追踪 + DeepSeek 适配
├── sandbox/        # 沙箱（CommandGuard, Checkpoint, Worktree）
├── storage/        # SQLite 存储层（迁移版本化）
├── tools/          # 24+ 内置工具
├── tui/            # TUI 组件（Ink + React）
│   └── components/ # UI 组件（MessageList, DiffView, Markdown...）
└── utils/          # 工具函数（debugLog, export, ssrf）
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

### Q: DeepSeek 思考模式/峰谷计价是什么？

- 思考模式默认开启（wire 层注入 thinking 参数并回传 reasoning_content），可用环境变量 `NEXUS_DEEPSEEK_THINKING=off` 关闭
- 峰谷计价：高峰时段（默认 9-12/14-18 时）成本按 2x 计，`NEXUS_DEEPSEEK_PEAK_MULTIPLIER` / `NEXUS_DEEPSEEK_PEAK_HOURS` 可调

### Q: 如何让任务关机后也能运行？

使用[云端调度](#云端调度)：把任务 prompt 放入 `.nexus/cloud-tasks/`，启用模板 workflow 即可（详见 `docs/CLOUD_SCHEDULING.md`）。

### Q: 为什么状态栏提示“建议 /compact”？

上下文占用超过 80% 时会提示（阈值着色）。执行 `/compact` 压缩历史即可降低占用。

---

## License

MIT

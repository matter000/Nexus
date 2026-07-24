# Nexus

> 一个面向生产级的终端 Coding Agent。

**核心理念**: 上下文为王、工具为先、人在环中。

## 特性

- **流式 TUI**: 基于 Ink (React for CLI) 的终端交互界面，实时流式渲染
- **Plan/Execute 双阶段**: 先规划后执行，关键决策点请求审批
- **四个核心工具**: read_file / edit_file / bash / grep，走 MCP 协议
- **多模型路由**: 不同任务阶段使用不同模型，平衡能力与成本
- **子 Agent 编排**: 复杂任务自动拆解为子任务并行执行
- **Git Checkpoint**: 每次编辑自动提交，一键回滚
- **上下文工程**: 三层上下文组装 + 压缩策略，长会话不爆窗口
- **成本追踪**: 实时显示 token 消耗和花费

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

设置 API Key 环境变量：

```bash
# Anthropic
export ANTHROPIC_API_KEY="your-key-here"

# OpenAI
export OPENAI_API_KEY="your-key-here"

# DeepSeek
export DEEPSEEK_API_KEY="your-key-here"

# 通用 OpenAI 兼容接口(Moonshot/智谱/硅基流动等)
export CUSTOM_API_KEY="your-key-here"
export CUSTOM_BASE_URL="https://api.moonshot.cn/v1"  # 厂商的 OpenAI 兼容端点
export CUSTOM_DEFAULT_MODEL="moonshot-v1-8k"          # 模型名称
```

项目级配置在 `.nexus/config.toml`，项目约定在 `.nexus/rules.toml`。

#### 支持的模型厂商

| Provider | 环境变量 | 默认模型 | 说明 |
|----------|----------|----------|------|
| Anthropic | `ANTHROPIC_API_KEY` | claude-sonnet-4-20250514 | 原生支持 |
| OpenAI | `OPENAI_API_KEY` | gpt-4o | 原生支持 |
| DeepSeek | `DEEPSEEK_API_KEY` | deepseek-chat | OpenAI 兼容接口 |
| Ollama | 无需 | llama3 | 本地模型 |
| Custom | `CUSTOM_API_KEY` + `CUSTOM_BASE_URL` | 自定义 | 任意 OpenAI 兼容厂商 |

**DeepSeek 使用示例：**

```bash
# 使用 deepseek-chat 作为执行模型
bun run start -m deepseek-chat "重构代码"

# 在 .nexus/config.toml 中配置各阶段使用 DeepSeek
# [models]
# planner = "deepseek-chat"
# executor = "deepseek-chat"
```

**其他厂商示例（Moonshot/智谱/硅基流动）：**

```bash
# Moonshot (Kimi)
export CUSTOM_API_KEY="your-moonshot-key"
export CUSTOM_BASE_URL="https://api.moonshot.cn/v1"
bun run start -m moonshot-v1-8k "你的任务"

# 智谱 (GLM)
export CUSTOM_API_KEY="your-zhipu-key"
export CUSTOM_BASE_URL="https://open.bigmodel.cn/api/paas/v4"
bun run start -m glm-4 "你的任务"

# 硅基流动 (SiliconFlow)
export CUSTOM_API_KEY="your-siliconflow-key"
export CUSTOM_BASE_URL="https://api.siliconflow.cn/v1"
bun run start -m deepseek-ai/DeepSeek-V3 "你的任务"
```

### 运行

```bash
# 交互式会话
bun run start

# 带初始任务
bun run start "重构 utils 模块"

# 指定模型
bun run start -m gpt-4o "修复登录 bug"

# 自动批准编辑
bun run start --permission auto-edit "添加单元测试"

# 非交互模式
bun run start --non-interactive "运行测试并修复失败的用例"
```

### 权限模式

| 模式 | 说明 |
|------|------|
| `ask` | 每个写操作都问（默认） |
| `auto-edit` | edit 自动批准，bash 仍问 |
| `auto-all` | 全部自动（危险命令仍强制问） |
| `yolo` | 全部自动，含危险命令（自负责任） |

### 斜杠命令

| 命令 | 说明 |
|------|------|
| `/model [name]` | 查看或切换模型 |
| `/cost` | 查看本次会话花费 |
| `/clear` | 清除当前上下文 |
| `/undo` | 回滚到上一个检查点 |
| `/history` | 查看会话历史 |
| `/help` | 显示可用命令 |

## 架构

```
TUI 层 (Ink)
    ↓
Agent 编排层 (Plan/Execute + ReAct + 子Agent)
    ↓                    ↓
模型路由层          上下文工程层
    ↓
工具层 (MCP-native: read/edit/bash/grep)
    ↓ (未来)
Go 引擎 (可选, 真沙箱/后台索引)
```

## 开发

```bash
# 类型检查
bun run lint

# 运行测试
bun test

# 构建
bun run build
```

## 路线图

- **Phase 0**: 骨架搭建 — 最小 agent loop ✓
- **Phase 1**: MVP — 流式 TUI + 核心工具 + 审批 UX
- **Phase 2**: 上下文工程 + 多模型路由
- **Phase 3**: 子 Agent 编排
- **Phase 4**: 语义检索 + Go 引擎评估

详见 [DESIGN.md](./DESIGN.md)。

## License

MIT

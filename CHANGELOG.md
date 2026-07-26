# Changelog

本项目所有重要变更均记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Fixed
- Provider 适配器 `isAvailable()` 现在正确合并环境变量与 `~/.nexus/secrets.toml` 配置（原先仅查 `process.env`，用户只在 secrets 文件配置 key 时误判为不可用）
- SubAgent 现在响应 `abortSignal`，Ctrl+C 可中断已分派的子 Agent（原先 SubAgent 的 `generateText` 调用未传递 abortSignal）
- `dispatch_subagents` 改用 `Promise.allSettled`，单个子任务崩溃不再丢失其他已完成任务的结果（原先用 `Promise.all` 会导致整批 reject）
- 集成测试断言工具数从 12 更新为 14（同步实际注册的工具数量）

## [0.1.0] - 2026-07-24

### Added
- 四阶段开发路线图全部实现（P0-P3）：Plan/Execute 双阶段、Auto 模式、子 Agent 编排、语义检索
- 15 个内置工具：read_file / edit_file / bash / grep / glob / list_directory / search_symbol / fetch_url / create_file / update_todo / submit_plan / dispatch_subagent / dispatch_subagents / semantic_search + 外部 MCP 工具接入
- Harness Engine 评估框架：TOML 任务定义，Mock/Real 双模式，6 种验证规则
- 上下文工程层：CodeGraph 多语言图谱、SemanticSearch 本地 embedding、Compressor 分级压缩、TokenBudget 预算管理
- 模型路由层：多 Provider（Anthropic/OpenAI/DeepSeek/自定义兼容端点）、角色路由、降级链、成本追踪
- 安全沙箱：CommandGuard 危险命令检测、Checkpoint Git 自动回滚、SandboxEngine 接口抽象
- TUI：基于 Ink v5 的流式 Markdown 渲染、Diff 预览、工具卡片、审批面板、模型选择器
- 会话持久化：SQLite 存储、`--resume` 恢复中断会话
- 外部 MCP Server 支持：通过 `.nexus/config.toml` 接入任意 MCP 工具服务器

### Changed
- 整理目录结构：logo 文件移入 assets/，文档移入 docs/，二进制资源不上传
- 从版本控制中移除 .qoder 和 .zcode 目录
- 重写 README 为详细安装使用说明

### Fixed
- 消除 Agent 重复响应（清除 streamingText，Planner 使用 system_info）
- 修复工具卡片折叠状态的 useEffect 重置问题
- 查询类任务跳过验证阶段，每次执行重置状态
- stuck 检测最多警告 2 次避免刷屏
- 调试日志改为 JSONL 格式，启动时显示路径

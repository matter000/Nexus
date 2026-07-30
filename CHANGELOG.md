# Changelog

本项目所有重要变更均记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added
- 引入 Biome 代码规范工具（格式化 + lint），`lint` 脚本集成 `biome check`，新增 `format` 脚本
- 测试覆盖率：新增 `test:coverage` 脚本，CI 启用 `--coverage` 记录基线
- 新增 `.env.example` 环境变量示例文件
- 提取 `src/utils/ssrf.ts` 公共 SSRF 防护模块，新增 `ssrf.test.ts`（10 用例）
- 提取 `src/core/approvalRegistry.ts` 审批 resolver 注册表（按 callId 索引）
- 模型成本支持配置外置：`[models.cost_overrides]` 可声明新增/自定义模型成本
- 新增 `docs/ROADMAP.md` 路线图（v2 Go 引擎规划及待办改进项）
- 引入 `ink-testing-library`，新增 TodoProgress 组件测试（4 渲染分支）

### Changed
- SubAgent 成本参数从 router 动态获取，提取 `createSubAgent()` 工厂方法消除硬编码与重复代码
- MCP Server 路径校验改用 `isInsideProject`；registry 的 SSRF 检查对齐 fetchUrl 的完整防护范围
- `plan_approval_request` 事件携带 callId，工具与计划审批统一改用 callId 队列
- `saveSecrets` 移除未使用的 `projectRoot` 参数（写入全局路径）
- README 合并去重，将简略版独特的技术栈表并入详尽版
- SemanticSearch 补充 `close()`，Orchestrator shutdown 时释放数据库连接

### Removed
- 移除入口与 TUI 中的 globalThis 审批反模式及死代码 set/get 函数
- 移除 npm 遗留的 `package-lock.json`
- 移除 Orchestrator 中多余的 `as any` 断言

### Security
- 加固 MCP Server 路径遍历防护：从 `startsWith` 前缀匹配改为 `relative()` 检测，防范同前缀路径绕过
- 统一并补全 SSRF 防护范围：新增 `metadata.google.internal`、`.local`/`.internal` 后缀及完整私有网段（127/169.254/0）

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

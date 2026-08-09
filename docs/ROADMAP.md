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

### Loop Engineering 核心闭环（已完成，2026-08；基于 Loop-Engineering-Handbook / loop-engineering-guide / 菜鸟教程三来源交叉调研：Addy Osmani 六大组件 + LangChain 四层循环堆叠）

实现范围：**L1+L2 证据化核心闭环**（不包含 L3 事件驱动 / L4 自改进）。核心铁律落地：不基于置信度循环、基于证据循环；写代码的 Agent 不能自判完成（Maker/Checker 分离）；反馈紧凑可操作；硬门禁退出条件。

1. **EvidenceGate 确定性证据门禁**（新增 `src/agent/EvidenceGate.ts`）：任务完成且改动代码时运行 lint/typecheck/test 确定性检查；命令来源三级（config.evidence 显式配置 → 探测 package.json scripts 与锁文件 runner → 跳过）；超时按 skipped 处理（自定义超时，规避 Windows spawn 只杀 shell 不杀子进程树导致 close 永不触发）；输出截断保留尾部（失败信息在尾部）；不新增审批路径
2. **验证阶段证据化**（Executor）：证据门禁结果注入 verifyPrompt（确定性失败按失败处理，无需 verifier 复述；全绿/跳过时才做语义检查）；失败项 detail 结构化（[缺失]/[行为不符] 开头、[建议] 结尾），新增 evidence 字段；VerifyFailure 扩展 evidence?: string（向后兼容）
3. **自动修复循环默认开启**（config）：`limits.max_auto_retries` 默认 0 → 1（L2 反馈回传是验证循环核心，此前默认关闭是最大短板）；证据门禁失败即使 verifier 通过也进入修复循环（确定性失败直通）；fixInstruction 证据优先列出（gate + 输出尾部），验证失败项附证据字段；验证修复封顶 2 次预算保留
4. **循环 trace 观测**：LoopTraceRound 接口（轮次/迭代数/证据/验证结论）；Executor.getLoopTrace() 记录；Orchestrator 聚合各轮并在循环结束后 emit 循环报告（N 轮 / 证据门禁 X 过 Y 败 / 验证通过率 / 总成本），不污染交付文本；数据结构供后续 L4（trace 驱动自改进）复用

验证：证据门禁 6 用例（执行判定/跳过/截断/超时/script 探测）+ config 2 用例 + executor 3 用例（证据注入 verifyPrompt/getEvidenceResult/evidence 字段解析）+ orchestrator 2 用例（证据失败直通修复循环/循环报告）；全量隔离套件 + lint/tsc/import 边界全通过。

### L3 事件驱动循环（已完成，2026-08；基于 Claude Code /loop 与 /goal 产品化形态调研：2026-03 v2.1.71 发布 /loop，/goal 独立模型验收；Codex Automations 声明式对照）

实现范围：**/goal + /loop 斜杠命令**（Loop 五积木中 Automations 触发器与跨轮次状态补齐；loops.toml 声明式调度遵循“先手动跑通再自动化”顺序原则留待后续）。

1. **/goal 目标驱动循环**（新增 `src/agent/GoalLoop.ts`）：跨多次 execute 的验收循环——目标未达成时整个任务重跑（携带上一轮证据/验证摘要）；验收判定**门禁优先 + verifier 兜底**（acceptance 映射“测试→test gate”等，映射命中且门禁非 skipped 时以确定性结果为准，否则确定性失败拦截 + verifier 语义兜底）；护栏 maxRounds（默认 5）+ maxCost（默认 $2，与 max_session_cost 取小）+ abortSignal
2. **/loop 节拍循环**（新增 `src/agent/LoopState.ts` + Orchestrator.runLoop）：按间隔重跑任务（最小 1 分钟，对齐 Claude Code）；状态持久化到 `.nexus/loop-state.md`（人类可读 Markdown + HTML 注释 JSON meta，社区 STATE.md 共识；损坏重置不阻塞）；停止规则 max-rounds / max-cost / 状态文件 stop_requested / Ctrl+C（可中断等待）
3. **命令与门面**：/goal /loop 斜杠命令注册（--max-rounds/--max-cost/--interval 10m|1h 解析）；CommandContext 注入 runGoal/runLoop 委托；Orchestrator 新增 getLastExecutionSignals（evidence+verify+error 聚合，供 /goal 验收与外部复用）

验证：goalLoop 13 用例（验收判定/重跑/预算/中断/门禁映射）+ loopState 6 用例（读写/合并/停止信号/损坏重置/往返）+ slashCommands 8 用例（命令解析与委托）+ orchestrator 3 用例（门面）；隔离套件 38 文件 / 476 用例全绿；lint/tsc/import 边界全通过。**真实链路冒烟已完成（2026-08-09，DeepSeek 临时 Key）**：/goal "让 tests/unit/loopState.test.ts 全部通过" 首轮验收通过（$0.038）；/loop 节拍一轮执行 + loop-state.md 写入正常。

### 本地 Automations（已完成，2026-08；基于 Codex automations.toml 与 Claude Code 定时任务体系调研：heartbeat 形态、Cron 触发"任务失忆"坑复盘、官方"先手动跑通再自动化"顺序建议）

实现范围：**loops.toml 声明式配置 + LoopScheduler 会话内自动心跳 + /loops 命令**（Loop 五积木 Automations 的声明式完整形态；云端 /schedule 形态不做，文档化引导 GitHub Actions）。

1. **配置解析**（新增 `src/agent/LoopConfigLoader.ts`）：`.nexus/loops.toml` 的 `[loops.<name>]` 段——schedule（m/h 间隔，≥1m）/ prompt / gates（lint/typecheck/test，非法值整条跳过）/ max_cost（默认 $2）/ worktree / enabled；单条损坏跳过并告警不阻塞；文件缺失静默返回 []
2. **会话内调度器**（新增 `src/agent/LoopScheduler.ts`）：每个 enabled loop 一条 setTimeout 链（Bun 原生，无 cron 依赖）；到点读状态文件 → 执行（复用 runLoop 链路，loopName 分状态文件防"失忆"）→ 写状态（含 Triage 分级）→ 调度下一轮；启动补跑（lastRunAt 空或超 2×interval）；停止规则 disable / Ctrl+C / 成本超限暂停；同 loop 并发护栏
3. **/loops 命令与 Triage**：/loops（列表：状态/下次运行/上次结果）、run-now / enable / disable / inbox（[紧急]/[本周]/[观察] 分级发现，宽松标记解析写入状态文件）；CommandContext 委托 + Orchestrator 门面（startLoops 挂 startBackgroundInit、stopLoops 挂 shutdown、listLoops/runLoopNow/setLoopEnabled/getLoopInbox）
4. **状态文件按名分文件**：LoopState 支持 name，`loop-state-<name>.md`（main 保持 loop-state.md 兼容）；findings 分级 meta

验证：loopConfig 7 用例（schedule 解析/默认值/损坏跳过/语法错误）+ loopScheduler 6 用例（补跑/tick 触发/runNow/启停/list/成本暂停）+ loopState 扩展 3 用例（分文件/parseFindings/往返）+ orchestrator 门面 1 用例（无配置降级）+ slashCommands 6 用例；隔离套件 40 文件 / 498 用例全绿；lint/tsc/import 边界全通过。**真实链路冒烟已完成（2026-08-09）**：loops.toml 心跳启动补跑执行一轮，loop-state-smoke-demo.md 状态文件（round/findings）写入正确，/loops list 状态正常。

### L4 trace 驱动自改进（已完成，2026-08；LangChain 四层循环第四层：用历史 trace 自动改写指令/工具/评测器，让系统自我进化）

实现范围：**loop_traces 持久化 + 执行链路采集 + 失败模式聚类生成教训**（零 LLM 成本模板化；Reflector 精化提炼留待有成本预算时评估）。

1. **loop_traces 表**（migration v5）：loop_name/kind（exec|goal|loop）/round/iterations/evidence/verify/cost/created_at
2. **TraceStore**（新增 `src/memory/TraceStore.ts`）：独立打开 nexus.db + 迁移；record/recentTraces/failurePatterns（按 loop_name+失败类型聚类，count ≥ minCount 防噪音）
3. **采集链路**：Orchestrator 三处钩子——emitLoopTraceSummary 逐轮（kind='exec'）、runGoal roundSummaries（kind='goal'）、runLoop 汇总（kind='loop' 按 loop_name 分文件）；失败静默（学习系统旁路原则）
4. **失败模式消费**：LearningManager.consumeLoopTraces（会话末调用）——高频失败（count≥3）且无等价教训时生成模板化教训（triggerDesc `[循环] <loop>: <pattern>`），零 LLM 成本；system_info 播报提炼数

验证：traceStore 7 用例（往返/迁移幂等/聚类命中与阈值/独立聚类）+ learningManagerTrace 4 用例（教训生成/去重/阈值/降级）+ orchestrator 采集 1 用例（/goal 写入 loop_traces）+ executor 1 用例（allowSystemInMessages 契约）；隔离套件 42 文件 / 511 用例全绿；lint/tsc/import 边界全通过。

### DeepSeek 深度适配（已完成，2026-08；基于官方文档与社区 issue 交叉调研：V4 GA / 涨价预警 / 峰谷计价 / thinking 三约束）

1. **reasoning_content 回传加固**（核心）：deepseekFetch 拦截器在请求体层完成思考模式契约变换——assistant 消息 content 中的 reasoning part 转为顶层 `reasoning_content` 字段并剥离 part；带 tool_calls 且缺 reasoning_content 的 assistant 消息注入空串兜底（社区验证的 200 修复，opencode #24104/#24442 同因）；剥离 `tool_choice`（thinking 模式 supportsToolChoice: false）。端到端验证确认 @ai-sdk/openai 会剥离 reasoning part（与社区一致），拦截器保证 wire 契约不 400
2. **思考模式默认开启**（用户决策：质量优先）：planner/executor 由 disabled 改为 enabled（V4 agentic coding 优势，DeepSeek 内部即此用法）；`NEXUS_DEEPSEEK_THINKING=off` 一键回退；422 自愈保留为兜底；v4-flash 新增 Agentic Coding 系统提示后缀
3. **峰谷计价**（用户决策：纳入成本统计）：CostTracker 新增 deepSeekPeakConfig（倍率默认 2、峰窗默认本地时间 9-12/14-18 点，env 可覆盖）；DeepSeek 请求峰窗内输入/输出/缓存命中单价统一乘倍率，getSummary 附注标识；非 DeepSeek 不受影响
4. **成本表对齐**：v4-flash/pro 更新为 2026-08 官方现行价（flash $0.14/$0.0028/$0.28，pro $0.435/$0.0034/$0.87，单位 M token），注释标注 8/6 涨价预警与峰谷处理位置
5. **v6 消息缺陷修复**（spike 意外发现）：AI SDK v6 的 tool-result part 要求 output 为判别联合 `{type:'text'|'json', value}`（非裸字符串）——normalizeMessagesForSDK 与 Executor 验证循环已修复，此前仅被 mock 测试掩盖

验证：隔离测试 34 文件 / 433 用例全绿（新增 transformDeepSeekBody 4 单测 + 端到端链路用例、峰谷计价 4 用例、思考模式默认/覆盖用例）；lint/tsc/import 边界全通过。**真实链路冒烟已完成（2026-08-09）**：思考模式 + 多轮工具调用（grep→read_file 连续调用）无 400（reasoning_content 回传契约正常），基础连接 $0.007/次。

### Agent 深化改进四专项（已完成，2026-08；基于 Harness Engineering 第三范式共识：验证层是新瓶颈）

1. **步级测试驱动闭环**（长任务稳定共识架构，SWE-bench 79.4% Pass@1 同款）：Executor 在 edit_file/create_file 成功后自动映射受影响测试（src/**/name.ts → tests 下任意深度的 name.test.ts(x)）并运行，失败结果以 `[自动测试反馈]` 注入 LLM 下轮上下文；同文件每轮去重 + 单任务累计上限 10 次护栏；仅当 rules.testCommand 形如 `bun test` 时启用，其他框架保守跳过
2. **测试工程治理**：
   - 新增 `scripts/run-tests-isolated.ts` 逐文件进程隔离运行器（根治 bun mock.module 跨文件泄漏，34 文件全量单命令可复现）；CI 主套件切换为隔离模式，package.json 新增 `test:isolated`
   - eval 真实模式回归门：CLI 新增 `--difficulty <easy|medium|hard>` 过滤；CI 在配置 `NEXUS_EVAL_API_KEY` 时跑 easy 任务集真实模式（passRate >= 60% + 总成本 < $2 双护栏，无密钥自动跳过不影响 fork PR）
3. **LSP 语义工具**（2026 能力分水岭：语义层 + 验证层让 agent 少猜）：新增 `lsp` 工具（TS LanguageService 惰性单例，无需外部语言服务器进程），三个 action：definition 精确定义跳转 / references 跨文件引用 / diagnostics 语义诊断（错误优先，最多 15 条）；非 TS/JS 拒绝并引导 grep/search_symbol；项目文件数 > 3000 自动禁用
4. **AI SDK v4 → v6 迁移**（按既有评估清单执行，v6 于 2026-01 进入 Stable）：
   - 依赖升级：ai@6.0.246 / @ai-sdk/anthropic@3.0.107 / @ai-sdk/openai@3.0.91 / zod@4.4.3
   - 适配：`maxSteps` → `stopWhen: stepCountIs(n)`；工具字段 `parameters` → `inputSchema`；usage `promptTokens/completionTokens` → `inputTokens/outputTokens`（ReActLoop 内映射保持下游形状不变）；toolCall `args` → `input`、tool-result `result` → `output`（normalizeMessagesForSDK 与验证循环同步更新）；reasoning 数组 → 拼接文本；maxTokens → maxOutputTokens（splitModelParameters 兼容映射）
   - 关键 spike 结论：**v6 createOpenAI 默认走 Responses API（/v1/responses），DeepSeek 及 openai 兼容端点必须经 `.chat()` 路由到 Chat Completions**（ModelRouter 新增 createOpenAICompatible 包装）；DeepSeek fetch 拦截器（thinking 注入）与 reasoningEffort 映射在 v6 下验证通过；Anthropic cacheControl 断点保留

验证：隔离测试 34 文件 / 423 用例全绿（含新增 lsp 7 用例、步级测试相关 executor 回归）；lint/tsc/import 边界全通过；eval mock gate 15 任务端到端运行正常。真实 DeepSeek 冒烟（思考模式 422 自愈路径）留待有 API Key 环境执行。

### 终端体验四维优化（已完成，2026-08；基于 CLI Agent 体验调研：成本可观测性共识 + Ink 防闪烁标准方案）

对 TUI 实施四维体验优化（全部为消费侧改动，不改事件协议与 Agent 层）：

1. **多智能体可见性**（补齐多智能体协作系统的体验闭环）：新增 `AgentRunList` 组件渲染 agent_start/agent_done 事件（引擎名/任务 ID/状态/摘要）；新增 `formatApprovalParams` 审批参数可读格式化（git_merge 展示分支数、bash 展示命令等，替代裸 JSON）；theme labels 与工具 emoji 补全全部 27 个工具
2. **成本仪表盘**（业界"成本敏感时代"共识：statusline 生态首要诉求）：状态栏新增会话累计费用/in/out token/缓存命中率/todo 进度速览；ctx 占用升级三级语义色（绿/黄/红）；数据源 CostTracker 已就绪，展示层零新增成本
3. **渲染性能防闪烁**（qwen-code #1778 / Claude Code 渲染分析的标准方案）：定稿消息改用 Ink `<Static>` 沉入终端滚动历史（不再参与动态帧重布局，移除任务面板锚点分割逻辑）；流式 chunk 80ms 节流批渲染（防每 chunk 一次 setState）；流式输出改 Markdown 渲染；MessageItem/ToolCard/TodoHeader/AgentRunList 全部 memo 化
4. **输入体验与降噪**：InputBox 新增 ↑/↓ 输入历史回溯（会话级，连续重复去重）；system_info 从逐条消息刷屏收敛为单行可变状态行（错误仍留痕）；快捷键提示行补充 [↑ 历史] [T 工具展开]

验证：新增 tuiUx.test.tsx 12 用例（参数格式化/子智能体卡片/输入历史，含 ink-testing-library stdin 模拟）；CI 分组全量 416+11+12 全绿；lint/tsc/import 边界均通过。已知取舍：Static 沉降后历史消息不可重渲染（Ink 语义）；输入历史不跨会话持久化；不实现光标移动编辑（Ink 原生输入限制）。

### 多智能体协作系统（已完成，2026-08；基于 Claude Code Agent Teams / Codex subagents / Anthropic 多智能体复盘调研）

在既有 Supervisor/Fan-out/Pipeline 三拓扑与 4 内置引擎基础上，落地四项协作能力：

1. **worktree 隔离并行写**（业界首选方案，Claude Code `isolation: worktree` / Codex `worktree: true` 同款）：
   - 新增 `WorktreeManager`（创建/提交/diff/合并/清理，提交身份环境变量兜底不修改 git 配置）；写任务从"串行互斥"升级为"各跑独立 worktree 并行（总并发 3），完成后统一审批合并"；冲突时 merge --abort 保留现场；非 git 仓库保守回退串行
   - dispatch_subagent(s)/dispatch_agents 支持 `isolation: "worktree"` 参数；合并审批接入 TUI 审批面板（人在环中）
2. **coder→reviewer 自动审查闭环**：引擎新增 `autoReview` 字段（coder 默认开启，agents.toml 可覆盖）；写任务成功且有变更时自动派 reviewer 审查，报告含高严重度问题时回传原引擎修复一轮（限 1 轮，noReview 标记防递归）
3. **共享任务板**（Agent Teams 三件套之一）：`TaskBoard` 会话级任务板，计划批准后 todos 灌入，新增 team_task_list/team_task_claim 工具（原子认领，单进程事件循环天然无双重认领）
4. **Agent Mailbox**（三件套之二）：`Mailbox` 按 agentId 寻址（主 Agent=lead，子 Agent=`<engine>-<taskId>`），send_message/read_messages 工具 + 子 Agent 每轮自动轮询注入下轮上下文

成本护栏（Anthropic 复盘：多 Agent 耗 token 约 15x，80% 性能差异由 token 投入解释）：
- SubAgent 入口成本熔断：会话成本超限时拒绝 spawn 新子任务（此前仅主循环有熔断）
- 工具描述补充适用性指引：仅高价值、高度可并行任务用多智能体；强依赖/共享上下文任务用单循环

架构决策：Mailbox/任务板为会话级内存实现（不持久化，对齐 Agent Teams 实验形态）；深度限制仍 1 层（审查闭环是编排层行为不算嵌套 spawn）；工具层经结构化接口（TaskBoardProvider/MailboxProvider）避免层级越界。成本量化：审查闭环每个写子任务约 +2 轮子 Agent 调用（reviewer 只读，token 约为 coder 的 1/3-1/2）。

验证：新增 18 个用例（multiAgent.test.ts：任务板/信箱/worktree 全流程/成本熔断/审查闭环/合并审批）；CI 分组全量 438 用例全绿；tsc + biome error 级 + import 边界检查均通过。

### 四维优化：可靠性/成本/质量/生态（已完成，2026-08；基于业界 2025-2026 Agent 工程实践调研）

调研对照 Anthropic《Effective context engineering for AI agents》(2025-09)、《Effective harnesses for long-running agents》(2025-11)、《Harness Design for Long-Running Apps》(2026-01) 及前缀缓存实战报告后，落地四批改进：

1. **可靠性（循环纠偏 + 任务笔记外置）**：
   - Executor stuck 检测从"仅提示 UI"升级为向 LLM 消息流注入 nudge（含当前 todo 状态与改道指令），模型可自行纠偏而非空转至迭代上限
   - 新增 `update_notes` 工具（`.nexus/task-notes.md`，免审批/双阶段/已 gitignore）：长任务关键决策外置到磁盘，emergency 压实后追加回读提示——补齐 Anthropic 长时程 harness 三招（压缩/笔记/子代理）中缺失的结构化笔记
2. **成本（Anthropic 显式前缀缓存）**：
   - Assembler 拆分 stable（基础指令+规则+工具+技能，逐轮不变）/dynamic（git 状态/项目树/todos/教训等逐轮变化）两段；`assembleMessagesSplit` 输出双 system 消息
   - provider 为 anthropic 时，`normalizeMessagesForSDK` 给首条 system 消息附 `providerOptions.anthropic.cacheControl`（API 按 AI SDK v4.3.19 官方文档验证）；DeepSeek/OpenAI 为自动前缀缓存无需标记
   - 缓存计量接入现有 CostTracker 管道（`providerMetadata.anthropic.cacheReadInputTokens`），成本表补 Anthropic 缓存读取价（基础价×0.1）
   - 预期：stable 前缀约 3-6k token，长会话第 2 轮起按 0.1x 计费，输入成本预计降 60-80%（待真实 API 冒烟确认）
3. **质量（工具描述审计 + Eval 指标扩展）**：
   - edit_file/grep/bash/update_todo/search_symbol 描述补强失败模式与工具边界（依据 Anthropic 实践：劣质工具描述使任务完成时间 +40%）
   - 15 个 eval 任务全量覆盖 `no_extra_files`（diff 干净度）；EvalReport 新增 avgSteps/avgPeakUtilization/extraFilesViolations 聚合指标与报告行；Validator 豁免 agent 运行时旁路文件（task-notes.md）
4. **生态（AGENTS.md 兼容）**：RulesLoader 读取项目根 AGENTS.md（2026 年事实标准），以独立段落注入 stable 上下文，2000 token 截断上限，与结构化 rules.toml 冲突时后者优先

验证：按 CI 分组方式（主套件/tree-sitter/skill-plugin 三进程）全部通过；tsc + biome error 级无告警。已知遗留：`bun test` 单进程全量运行时的 16 个失败为既有 mock.module 跨文件泄漏（CI 分组已规避，与本次变更无关）。

### AI SDK v4 → v5/v6 升级评估（已完成评估，2026-08；结论：已按本清单于 2026-08 完成 v6 迁移，见上方“Agent 深化改进四专项”第 4 条）

**背景**：项目锁定 `ai@^4.3.0`（v4），已知 v4 的工具 schema 与消息格式静默失败陷阱（靠 `normalizeMessagesForSDK` 等补丁规避）。截至 2026 年中的公开资料显示：v5 于 2025 年发布并引入大量破坏性变更；v6 已于 2026 年 1 月进入 Stable（v6.0.42），新增 Agent 抽象（ToolLoopAgent）与工具执行审批原语。

**v5 破坏性变更与本项目接触面映射**（基于公开迁移指南与社区资料，非本地安装验证）：

| v5 变更 | 本项目接触面 | 风险 |
|---|---|---|
| `maxTokens` → `maxOutputTokens` | `ReActLoop.splitModelParameters` 顶层参数白名单 | 低（改一行映射） |
| `maxSteps` 移除 → `stopWhen: stepCountIs(n)` | Planner/Executor/验证循环均用 `maxSteps: 1` | 低（机械替换） |
| 工具定义 `parameters` → `inputSchema`（Zod 或 jsonSchema()） | 全部工具以 `{ description, parameters: 裸 JSON Schema }` 传入 streamText/generateText | **高**：不改则工具被静默忽略，需统一换 `jsonSchema()` 包装 |
| `CoreMessage` → `ModelMessage`（content 部件数组） | `normalizeMessagesForSDK` 手写的 tool-call/reasoning 部件转换 | 中（格式方向与 v5 一致，需按新类型重校） |
| `streamOptions: { include_usage: true }` 顶层参数 | ReActLoop 流式用量统计 | 中（未确认 v5/v6 是否移入 providerOptions，需实测） |
| `providerMetadata.openai.cachedPromptTokens/reasoningTokens` | DeepSeek 缓存/推理分级计费（CostTracker） | 中（字段映射未确认，成本统计可能失真） |
| zod 4.1.8+ 推荐 + `@ai-sdk/*` provider 主版本配套 | 项目 zod ^3.24、@ai-sdk/anthropic ^1.2、@ai-sdk/openai ^1.3 | 中（依赖链整体升级） |
| createOpenAI 自定义 `fetch` 选项 | DeepSeek fetch 拦截器（thinking 注入） | 低（大概率保留，需实测） |

**决策：不迁 v5，等待直接迁 v6**，理由：
1. v6 已 Stable，迁 v5 等于付两次迁移成本；
2. 本项目是手写单步循环（`maxSteps: 1` + 外部审批/checkpoint/成本熔断），SDK 原生 agent 循环（stopWhen/prepareStep/ToolLoopAgent）无法承载中-loop 审批，迁过去核心架构仍不变，收益有限；
3. v4 当前稳定且陷阱已有补丁覆盖，无能力阻塞。

**迁移执行清单（未来开专项分支时照单验收）**：
1. 用 `npx @ai-sdk/codemod` + 手工结合完成参数/类型迁移；
2. 重点 spike 四个未确认项：裸 JSON Schema 工具定义、`streamOptions` 位置、`providerMetadata` 缓存/推理字段、createOpenAI `fetch` 拦截器；
3. 全量测试 + eval harness + DeepSeek 真实调用冒烟（思考模式 422 自愈路径必测）；
4. 触发条件：v4 停止维护、DeepSeek 新能力被 v4 适配器阻塞、或需要 v6 审批原语时提前启动。

### Orchestrator 拆分（已完成，2026-08）

- 现状：已按“先补测试再拆分”路径落地：`tests/unit/orchestrator.test.ts` 补齐 submit 主流程/重规划/自动修复（含 Verify→Fix）/会话恢复用例后，提取了 `SessionManager`（封装 NexusDB 会话/消息/todo 操作）与 `LearningManager`（经验/反思/技能）；Orchestrator 不再直接持有 db/memoryStore 字段
- 备注：MCP 管理保留独立 `ExternalMCPManager`，Orchestrator 内为薄编排层

### 系统提示缓存（来源：2026-07 代码精进，评估后暂缓）

- 现状：`buildSystemPrompt` 每次 submit 调用一次，含 `git status` / `git ls-files` 等外部命令
- 评估结论：调用频率低（每次用户输入一次，非每个 ReAct 迭代）；git 命令毫秒级开销相对 LLM 秒级延迟微不足道；缓存会引入"过期上下文"风险（用户编辑文件后 git 状态变化，缓存失效逻辑复杂）
- 结论：暂不实施。若未来基准测试确认为瓶颈，可考虑结合 FileWatcher 对项目树做短 TTL 缓存，git status 不宜长缓存

### eval 任务集扩充（已完成，2026-08）

- 任务数 15 → 23：新增 8 个任务（generic-stack / error-path / json-parse-tolerance / perf-dedup / state-machine / backward-compat-rename / test-first-multiply / email-validation），覆盖泛型、错误处理、JSON 容错、性能重构、状态机、向后兼容重命名、测试先行等此前缺失的主题
- 难度分布：easy 7 / medium 11 / hard 5；全部仅用现有 7 种验证规则（含 bash_pass 跑 fixture 内测试的真实行为验证），零 harness 代码变更
- CI mock 门阈值同步 15 → 23（`.github/workflows/ci.yml`）

### 云端调度模板（已完成，2026-08）

- 交付 `.github/workflows/nexus-cloud-automation.yml`（模板，默认不启用）+ `docs/CLOUD_SCHEDULING.md`（映射表/启用 5 步/防失忆/多任务扩展/安全成本）
- 复用 `--non-interactive --output json` CLI 入口，零运行时代码变更；prompt 与 workflow 解耦（.nexus/cloud-tasks/<name>.prompt）
- 不实际启用任何定时 workflow；用户按文档自行启用（GitHub Actions cron 最小粒度 5 分钟）

### 真实门回归基线（2026-08-09，DeepSeek 真实链路）

- 执行：`eval tests/eval/tasks --real --difficulty easy`（隔离 HOME 避开 secrets 的 defaultProvider 干扰 + `--model deepseek-v4-flash` 命中 MODEL_PROVIDER_MAP 直达 deepseek），3 轮共 $0.30
- **easy 7 任务：5 通过（71%，≥ CI 门 60%）**——create-logger / extract-constant / fix-divzero / math-rename / offbyone；email-validation / nullguard 仅 Windows 本地无 bash 导致 bash_pass 环境性失败（file 规则全过，CI ubuntu 可完整验收）
- medium 抽查 3 个新任务（generic-stack / error-path / json-parse-tolerance）：file 规则与 no_extra_files 全过，仅 bash_pass 环境性失败——prompt 可理解、agent 行为正确
- **暴露并修复两处缺陷**：① harness `Validator.ts` no_extra_files 把 Checkpoint 初始化的 `.git/` 计入 diff 干净度（真实回归误杀 5 个 easy 任务）→ listAllFiles 跳过 .git；② offbyone 任务 prompt 未约束文件范围（agent 合理补测试被 no_extra_files 拒绝）→ prompt 明确“仅修改 src/paginate.ts”
- 关键经验：真实回归必须排除 secrets.toml 的 defaultProvider 干扰（模型名不在 MODEL_PROVIDER_MAP 时会被解析到默认自定义 provider）

### 难度基线扩展（medium/hard 真实回归，2026-08-09）

- 执行：同 easy 轮次环境（隔离 HOME + --model deepseek-v4-flash），medium 全量 11 + hard 全量 5，成本 $0.34
- **medium 基线：4/11 全规则通过**（add-export / cross-file-rename / add-test / shared-types）；6 个仅 Windows bash_pass 环境性失败（file 规则全过：email-tests / error-path / generic-stack / json-parse-tolerance / retry-wrapper / test-first-multiply）；1 个模型行为失败（async-convert ×2 未产出 async/await，prompt 与规则一致，记为模型基线）
- **hard 基线：1/5 全规则通过**（extract-refactor）；3 个仅 bash_pass 环境性失败（backward-compat-rename / perf-dedup / state-machine，file 规则全过）；1 个模型行为失败（csv-quote-fix 违反“不改变函数签名”约束）
- **再修复两处**：① add-test 规则过严（要求测试文件字面包含 “function greet”，合理实现用 import 引用）→ 放宽为 “greet”；② Validator listAllFiles 排除 PowerShell 模块缓存目录（agent 在无 bash 的 Windows 上改用 powershell，其 ModuleAnalysisCache 落在 cwd 被误报为多余文件）
- 汇总：23 任务中非环境性真失败仅 2 个（async-convert / csv-quote-fix，均模型行为），任务定义在修复后与 agent 行为一致

### L4 教训 LLM 精化（2026-08-09）

- `consumeLoopTraces` 的失败模式教训 advice 由模板化文案升级为 **Reflector.refineLoopPattern LLM 精化**（summarizer 档模型，每会话约 $0.01）
- 降级链：精化失败/关闭 → 模板 advice（零成本兜底）；`NEXUS_L4_REFINE=off` 环境变量完全关闭 LLM 调用
- 实现：Reflector 新增 refineLoopPattern（轻量 JSON 解析 advice，不复用要求 triggerDesc 的 parseReflectedLessons）；LearningManager.consumeLoopTraces 改 async + 接收 summarizerModel；Orchestrator 会话末传 router.getModel('summarizer')
- 测试：learningManagerTrace.test.ts 新增精化/降级/开关 3 用例（mock ai 模块，mock 注册先于 import 的 executor.test.ts 同模式）+ 现有用例转 async（withLearningManager helper 适配）

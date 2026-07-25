# Nexus 详细设计说明

> 一个面向生产级的终端 Coding Agent。
> 文档版本:v0.1 (设计阶段) · 最后更新:2026-07-24

---

## 0. TL;DR

Nexus 是一个运行在终端的 AI 编程助手,核心理念是 **"上下文为王、工具为先、人在环中"**。

- **架构**:TypeScript (Bun) 单体起步,工具层从第一天起就走 MCP 协议;Go 引擎作为未来可插拔的执行后端,在撞到真沙箱/后台索引需求时再抽离,届时 Agent loop 零改动。
- **三大差异化**:上下文工程(代码图谱 + 语义检索)、多模型路由(能力 × 成本动态选择)、子 Agent 编排(复杂任务自动拆解)。
- **MVP 范围**:流式 TUI + 审批体验 + 四个核心工具(read / edit / bash / grep)可用。UI 是皮,工具可靠性是骨,两者绑成同一个 MVP 交付。
- **首发形态**:纯 CLI / TUI,不做 IDE 插件。

本文不是营销稿,是工程契约:每一节都写清"为什么这么选""边界在哪""什么时候该反悔"。

---

## 1. 定位与设计哲学

### 1.1 我们做什么、不做什么

**做**:在终端里,用户用自然语言描述编程任务,Nexus 自主完成"理解代码库 → 规划 → 读文件 → 改文件 → 跑测试 → 自我验证 → 交付"的闭环,关键决策点向用户请求审批。

**不做**(至少 v1):
- 不做 IDE 内联补全(那是 Copilot 的战场,不是 Agent 的)。
- 不做无监督的"全自动 PR 机器人"——人在环中是底线。
- 不做 GUI 版本。TUI 先做到极致。

### 1.2 五条设计哲学

这些哲学会在后续每个模块的设计中反复体现,是做取舍时的最终裁决依据。

1. **上下文质量 > 工具数量**。给 LLM 喂什么,决定了它聪不聪明。一个 read_file 工具配上下文压缩策略,胜过十个花哨工具。
2. **工具可靠性 > 工具覆盖面**。edit 一次幻觉覆盖错文件,用户信任就没了。宁可工具少,但要每个都稳。
3. **可验证 > 可执行**。agent 跑完测试通过才算完成,而不是"我改完了"。验证闭环是信任的来源。
4. **人在环中,但别烦人**。危险操作必审批,安全操作自动跑。审批 UX 的颗粒度决定体验。
5. **可回滚 > 不会错**。agent 一定会犯错,关键是有 git checkpoint 让用户一键回到任意一步。Aider 这点做得极好,我们继承。

### 1.3 与同类产品的差异定位

| 维度 | Claude Code | Aider | Cursor | **Nexus** |
|------|------------|-------|--------|-----------|
| 形态 | CLI | CLI | IDE | **CLI/TUI** |
| 上下文 | 强(整库) | 中(依赖 git) | 强(索引) | **强(图谱+语义)** |
| 模型 | 仅 Claude | 多模型 | 多模型 | **多模型+路由策略** |
| 多 Agent | 单 loop | 单 loop | 单 loop | **子 Agent 编排** |
| 沙箱 | 无 | 无 | 无 | **MCP 工具可挂 Go 后端** |

---

## 2. 总体架构

### 2.1 分层视图

```
┌─────────────────────────────────────────────────────────┐
│  TUI 层 (Ink / React for terminal)                       │
│  流式渲染 · Diff 高亮 · 工具审批卡片 · Spinner · 日志      │
└────────────────────────┬────────────────────────────────┘
                         │ (内部调用,非 IPC)
┌────────────────────────┴────────────────────────────────┐
│  Agent 编排层 (Orchestrator)                              │
│  ReAct Loop · Plan/Execute 双阶段 · 子 Agent 分派 · 检查点  │
└──────────┬───────────────────────────┬──────────────────┘
           │                           │
┌──────────┴───────────┐   ┌───────────┴──────────────────┐
│  模型路由层 (Router)   │   │  上下文工程层 (Context)        │
│  Provider 适配 · 成本   │   │  代码图谱 · 语义检索 · 压缩    │
│  估算 · 能力降级 · 重试  │   │  Token 预算 · .nexusrules      │
└──────────────────────┘   └──────────────────────────────┘
           │
┌──────────┴───────────────────────────────────────────────┐
│  工具层 (MCP-native)                                      │
│  read · edit · bash · grep · glob · todo · ...           │
│  所有工具实现 MCP Server 接口;可被外部 IDE 反向挂载         │
└───────────────────────┬──────────────────────────────────┘
                        │ (未来: stdio JSON-RPC)
                ┌───────┴────────┐
                │ Go 引擎 (可选)  │  ← v2 引入,真沙箱/后台索引
                │ MCP Server     │
                └────────────────┘
```

### 2.2 为什么是单体而不是 TS+Go 双体(起步)

明确写下这个决策的理由,以便未来复盘:

- **LLM 延迟主导**:agent loop 里最慢的是等 LLM 回 token(几百 ms 到几秒),Go 把 grep 从 20ms 降到 2ms 用户感知为零。过早优化。
- **IPC 调试成本**:跨进程 JSON-RPC,断点、日志、错误归因都更难,MVP 阶段拖慢迭代。
- **分发地狱**:5 平台二进制 + postinstall 下载,是几周的脏活,且是用户首次安装失败的重灾区。
- **MCP 解耦了**:工具层是 MCP Server 接口,未来把某个工具(比如 bash)挪到 Go 实现,Agent loop 和其他工具零改动。**这就是"单体起步、可平滑迁移"的技术保证**。

**触发迁移到 Go 的明确信号**(写下来,避免凭感觉):
1. 需要真沙箱(pty 劫持、cgroup 资源限制、syscall 过滤)——Node 做不好。
2. 需要常驻后台索引守护进程(整库 embedding 增量更新)——Node 常驻吃内存。
3. 实测某个工具成为 P95 延迟瓶颈——用数据说话,不靠猜。

### 2.3 技术栈选型

| 层 | 选型 | 理由 |
|----|------|------|
| 运行时 | **Bun** | 启动快、内置 TS、内置测试、原生 fetch、单二进制可打包分发 |
| TUI | **Ink** (React for CLI) | 组件化、流式友好、生态成熟(Claude Code 同款) |
| LLM SDK | **Vercel AI SDK** | Provider 无关、流式 + tool calling 抽象统一、社区活跃 |
| MCP | **@modelcontextprotocol/sdk** | 官方 TS SDK,双向(client + server)都支持 |
| 检索 | **ripgrep 子进程** + 自研语义层 | rg 是事实标准,不重造轮子 |
| AST | **tree-sitter** (可选,v2 引入) | 代码骨架提取 |
| 持久化 | **SQLite (better-sqlite3)** | 单文件、无服务、索引/embedding/会话历史 |
| 配置 | **TOML** (`.nexus/rules.toml` 等) | 人类友好、注释支持 |

---

## 3. 核心模块详解

### 3.1 Agent 编排层 (Orchestrator)

这是 Nexus 的大脑,也是最容易设计错的模块。

#### 3.1.1 双阶段:Plan → Execute

单 loop(纯 ReAct)在大任务上必然翻车:模型边想边写,写到一半发现方向错了,又舍不得删,就硬着头皮乱改。Nexus 强制分两阶段:

```
用户输入
   │
   ▼
┌──────────────┐    用户审批    ┌──────────────┐
│ Plan 阶段     │ ───────────▶ │ Execute 阶段  │
│ 探索+生成计划  │   (可修改)    │ 逐步执行+验证  │
│ 只读工具      │              │ 读写工具      │
└──────────────┘              └──────────────┘
   │                              │
   │ Plan 阶段只能用 read/grep/   │ Execute 阶段才解锁
   │ glob,禁止 edit/bash 写操作   │ edit/bash,且每步可回滚
```

Plan 输出一个结构化计划(TodoList),用户可改、可砍、可拒。审批通过后才进 Execute。

**关键设计**:Plan 阶段的 token 消耗(探索用的文件读取)和 Execute 阶段共享一个上下文窗口,通过压缩策略(见 3.3)避免爆窗口。

#### 3.1.2 ReAct Loop 内部状态机

Execute 阶段的核心循环:

```
        ┌────────────────────────────┐
        │ 组装上下文 (system + history │
        │  + 压缩后的文件 + todos)     │
        └────────────┬───────────────┘
                     ▼
        ┌────────────────────────────┐
        │ 调用 LLM (流式 + tools)     │
        └────────────┬───────────────┘
                     ▼
              ┌──────────────┐
              │ 有 tool_call? │
              └──────┬───────┘
           否 │              │ 是
              ▼              ▼
        ┌─────────┐   ┌────────────────────────┐
        │ 输出最终  │   │ 权限检查 → 审批?        │
        │ 文本,结束 │   └─────────┬──────────────┘
        └─────────┘        通过 │        拒绝
                           ▼            ▼
                  ┌──────────────┐  ┌──────────────┐
                  │ 执行工具      │  │ 注入"用户拒绝 │
                  │ (带超时/截断) │  │ 了此操作"结果 │
                  └──────┬───────┘  └──────┬───────┘
                         │                 │
                         ▼                 │
                  ┌──────────────┐         │
                  │ 结果喂回 LLM  │◀────────┘
                  │ (更新 todos)  │
                  └──────────────┘
                         │
                         └──────▶ (回到顶部)
```

几个非显然的设计点:

- **拒绝也是观察**:用户拒绝工具调用不报错,而是作为 `tool_result` 喂回 LLM(内容:"用户拒绝了此操作,原因:..."),让 agent 学会改道。这比抛异常优雅得多。
- **TodoList 持久化**:每个 Execute 步骤都会更新结构化 todos,UI 实时渲染进度条。用户能看到"做到第 3/7 步了"。
- **迭代上限**:硬上限(如 50 步)防失控,达到上限强制进入"总结当前进度并停止"。

#### 3.1.3 子 Agent 编排 (Sub-agent Dispatch)

这是 Nexus 的三大差异化之一。单 loop 处理不了大重构(比如"把全库从 CommonJS 改成 ESM"),上下文会爆、注意力会散。

**子 Agent 模型**:

```
主 Agent (Orchestrator)
  │
  ├──▶ spawn 子 Agent A (探索型,只读)
  │     任务:"找出所有 require() 调用并归类"
  │     返回:结构化清单 (不占主 agent 上下文)
  │
  ├──▶ spawn 子 Agent B (执行型,可写)
  │     任务:"改 src/utils/ 下所有文件"
  │     独立 loop,独立 todos,完成后汇报 diff
  │
  └──▶ spawn 子 Agent C (验证型,只读)
        任务:"跑测试 + 检查残留 require"
```

**关键约束**:
- 子 Agent 有**独立的上下文窗口**,只把最终结果(不是过程)回传主 Agent。这是省 token 的核心。
- 子 Agent 的**写权限默认关闭**,需要主 Agent 显式授权(在 spawn 参数里指定 `writable: true`)。
- **深度限制**:子 Agent 不能再 spawn 子 Agent(防止递归爆炸),最多一层。
- 子 Agent 的工具审批**继承主 Agent 的策略**,不重新问用户。

实现上,子 Agent 就是同一个 Orchestrator 类的递归实例,通过 `dispatch_subagent` 这个特殊 tool 暴露给 LLM。这个设计和 superpowers 的分派模式一致,被验证有效。

---

### 3.2 工具层 (MCP-native Tool Layer)

#### 3.2.1 为什么 MCP 从第一天就要上

蓝图作者这点判断完全正确,我强化一下:

1. **免费接入生态**:社区有成千上万的 MCP Server(GitHub、Jira、Postgres、Slack...),Nexus 一出生就有无限扩展能力。
2. **反向被挂载**:Nexus 的工具实现成 MCP Server 后,Cursor/VSCode/Claude Desktop 能直接把 Nexus 当工具用——这是分发渠道。
3. **未来抽离零成本**:bash 工具从 TS 挪到 Go,对 Agent loop 来说只是换了一个 MCP Server 的 transport,业务逻辑零改动。

#### 3.2.2 MVP 工具集(四个,严格克制)

| 工具 | 作用 | 权限默认 | 关键设计 |
|------|------|---------|---------|
| `read_file` | 读文件 | 自动 | 行数截断(>2000 行只给头尾)、二进制检测、行号格式化 |
| `edit_file` | 精准替换 | **审批** | 见下方"edit 的可靠性设计" |
| `bash` | 执行命令 | **审批** | 危险命令拦截、超时、输出截断、工作目录锁定 |
| `grep` | 代码检索 | 自动 | 封装 ripgrep,支持正则/文件过滤/上下文行 |

**为什么先只做四个**:这四个覆盖了 90% 的编程任务。tool 越多,LLM 越容易选错、prompt 越长、维护成本越高。后续的 `glob`、`todo`、`web_fetch` 在 v1.1 再加。

#### 3.2.3 edit 的可靠性设计(重中之重)

edit 是 agent 最容易翻车的工具。幻觉的表现:替换字符串匹配到多处、上下文不够唯一、直接覆盖整个文件。Nexus 的 edit 设计:

```
edit_file(params):
  path, old_string, new_string
  
  1. 读文件原文
  2. 在原文中查找 old_string:
     - 0 处匹配 → 报错"未找到,可能文件已变,请重新 read"
     - 1 处匹配 → ✅ 继续
     - >1 处匹配 → 报错"匹配不唯一,请提供更多上下文行"
  3. 应用替换,生成 diff
  4. (可选)用 tree-sitter 验证替换后语法仍合法
  5. 写入文件 (原子写:写临时文件 → rename)
  6. 自动 git checkpoint (见 3.4)
  7. 返回 diff 给 LLM
```

**强制 old_string 唯一匹配**是 Aider 的核心思路,我们继承。不提供"按行号替换"的捷径(行号会漂移),也不提供"整文件覆盖"(容易丢内容)。

#### 3.2.4 bash 的安全设计

```
bash(params):
  command, timeout=30s
  
  1. 危险命令检测 (正则黑名单 + 启发式):
     - rm -rf /, rm -rf ~, :(){ :|:& };:
     - dd, mkfs, shred
     - curl/wget 拉到根目录执行
     - 管道到 bash/sh (curl ... | sh)
     命中 → 强制审批(即便用户开了自动模式)
  2. 工作目录锁定在项目根(防 cd 越狱)
  3. 资源限制:超时、输出大小上限(默认 100KB 截断)
  4. 环境变量隔离(可选,过滤敏感变量)
  5. 进程组管理:超时 kill 整个进程组,不留僵尸
```

**未来 Go 化的钩子**:bash 工具的接口不变,实现从 `child_process.exec` 换成调用 Go MCP Server(用 pty + cgroup),Agent 无感知。

---

### 3.3 上下文工程层 (Context Engineering)

**这是 Nexus 最大的护城河。** 光靠 grep 不够——grep 只能找到"提到 X 的地方",找不到"和 X 概念相关的地方"。

#### 3.3.1 三层上下文组装

```
┌─────────────────────────────────────────────┐
│ L1: 静态上下文 (每次都带)                     │
│  · System Prompt (角色 + 工具说明 + 规则)     │
│  · .nexus/rules.toml (项目约定)              │
│  · 当前 git 状态 (分支、未提交改动)           │
│  · 项目骨架树 (目录结构,自动生成)             │
├─────────────────────────────────────────────┤
│ L2: 任务上下文 (按需注入)                     │
│  · 用户本轮请求                               │
│  · Plan 阶段产出的 todos                      │
│  · 本会话历史 (压缩后,见 3.3.3)              │
├─────────────────────────────────────────────┤
│ L3: 检索上下文 (agent 主动拉取)               │
│  · grep/glob 的精确匹配结果                   │
│  · 语义检索的相似代码块 (v1.1)                │
│  · read_file 读取的具体文件                   │
└─────────────────────────────────────────────┘
```

L3 是 agent 通过工具调用主动获取的,不预先塞满窗口。这避免了"整库灌进 prompt"的 token 爆炸。

#### 3.3.2 代码图谱与语义检索 (v1.1 引入)

**为什么需要**:用户说"改一下登录逻辑",grep "login" 找不全(有的叫 `authenticate`,有的叫 `signIn`)。语义检索能跨词面匹配。

**实现策略(轻量版,不依赖重型向量库)**:

1. **代码骨架提取**:用 tree-sitter 解析每个文件,提取函数/类/方法的签名 + docstring,生成"地图"(每文件压缩到几行)。这张地图常驻 L1 上下文,让 agent 知道全库有什么。
2. **分块 + Embedding**:把函数级代码块切出来,本地 embedding(如 `Xenova/all-MiniLM-L6-v2` via transformers.js)存 SQLite。
3. **检索时**:agent 调用 `semantic_search` 工具,返回 top-K 代码块摘要,agent 再决定 read 哪个。
4. **增量索引**:监听文件变更,只重算变化的块。

**关键约束**:embedding 模型跑本地(transformers.js,纯 JS),不把代码发外部。这是隐私底线。

#### 3.3.3 上下文压缩策略

长会话必然爆窗口。压缩策略:

- **近期完整保留**:最近 N 轮对话完整保留。
- **早期摘要**:超过阈值的轮次,用小模型(或规则)压缩成"做了什么 + 关键决策"的摘要。
- **工具结果分级**:
  - read_file 结果:只保留被 edit 过的文件路径,内容丢弃(agent 需要可重新 read)。
  - grep 结果:保留命中的文件:行号,丢弃上下文行。
  - bash 成功输出:保留 exit code + 摘要,丢弃全文。
  - bash 失败输出:**完整保留**(错误信息对 debug 至关重要)。
- **Token 预算管理**:组装 prompt 前算总 token,超预算时按优先级丢弃(L3 → 旧 L2 → L1 的部分)。

#### 3.3.4 `.nexus/rules.toml` (项目约定)

类似 `.cursorrules`,但是结构化的:

```toml
[project]
name = "Nexus"
language = "typescript"
test_command = "bun test"
build_command = "bun run build"

[style]
# 让 agent 生成的代码符合项目风格
indent = 2
quote = "single"
semicolons = false

[constraints]
# 硬约束,agent 必须遵守
"不要引入新的运行时依赖" = true
"修改 core/ 前必须写测试" = true

[context]
# 额外常驻上下文
always_include = ["ARCHITECTURE.md", "src/types/index.ts"]
```

结构化比纯文本好的地方:可以程序化校验和注入,而不是全靠 LLM 自觉。

---

### 3.4 模型路由层 (Router)

#### 3.4.1 Provider 抽象

Vercel AI SDK 已经做了 Provider 无关的抽象,我们在其上加一层 Nexus 特有的路由逻辑:

```typescript
interface ModelRoute {
  provider: 'anthropic' | 'openai' | 'google' | 'ollama' | 'openrouter';
  model: string;          // e.g. 'claude-sonnet-4'
  role: 'planner' | 'executor' | 'summarizer' | 'verifier';
  cost_per_1k_input: number;
  cost_per_1k_output: number;
  context_window: number;
  supports_tools: boolean;
  supports_streaming: boolean;
}
```

#### 3.4.2 路由策略

不同任务用不同模型,平衡能力与成本:

| 任务阶段 | 推荐模型档位 | 理由 |
|---------|-------------|------|
| Plan (探索+规划) | 高档(Claude Sonnet+/GPT-4o+) | 规划质量决定一切,值得花钱 |
| Execute (写代码) | 中高档(Sonnet/GPT-4o-mini) | 有明确计划后,执行不需要最强模型 |
| Summarize (压缩历史) | 低档(Haiku/GPT-4o-mini) | 摘要不需要强推理 |
| Verify (跑测试+检查) | 低档 | 主要是工具调用,模型只读结果 |

**用户可配置**:在 `.nexus/config.toml` 里指定每阶段的模型,或用 `auto` 让 Nexus 自己选。

#### 3.4.3 降级与重试

- **能力降级**:高档模型不可用(限流/宕机)→ 自动降一档,并提示用户。
- **工具格式适配**:不同 provider 的 tool calling 格式不同(OpenAI function calling vs Anthropic tool_use),路由层统一转换。Vercel AI SDK 已处理大半,边界情况自己补。
- **重试策略**:指数退避,最多 3 次,区分可重试错误(网络/限流)和不可重试错误(参数错/内容违规)。

#### 3.4.4 成本追踪

每次调用记录 token 数和估算成本,会话结束显示总花费。这是用户信任的关键——"这次重构花了 $0.43"比"改完了"更有安全感。

---

### 3.5 流式 TUI 与审批体验

这是 MVP 的首要交付,但记住:UI 是皮,工具是骨。

#### 3.5.1 TUI 布局

```
┌─ Nexus ───────────────────────────────────  claude-sonnet-4 · $0.12 ─┐
│                                                                          │
│  ◆ 用户                                                                  │
│  把 utils/logger.ts 改成支持结构化日志                                    │
│                                                                          │
│  ◐ Nexus (思考中...)                                          ▓▓▓▓░░ 3/7 │
│  我来先看一下当前的 logger 实现...                                        │
│                                                                          │
│  ┌─ 📄 read_file ────────────────────────────────────────────┐          │
│  │ src/utils/logger.ts (45 行)                                │          │
│  └────────────────────────────────────────────────────────────┘          │
│                                                                          │
│  ┌─ ✏️ edit_file ────────────────────── [审批] [拒绝] [查看 diff] ┐      │
│  │ src/utils/logger.ts                                           │      │
│  │ @@ -12,7 +12,12 @@                                            │      │
│  │ -export function log(msg: string) {                           │      │
│  │ +export interface LogEntry {                                  │      │
│  │ +  level: 'info' | 'warn' | 'error';                         │      │
│  │ +  message: string;                                          │      │
│  │ +  meta?: Record<string, unknown>;                           │      │
│  │ +}                                                            │      │
│  │ +export function log(entry: LogEntry) {                       │      │
│  └───────────────────────────────────────────────────────────────┘      │
│                                                                          │
│  > _                                                                     │
│  [Enter 发送] [Ctrl+C 中断] [Ctrl+Z 撤销] [/ 命令]                       │
└──────────────────────────────────────────────────────────────────────────┘
```

#### 3.5.2 关键交互设计

- **流式打字机**:LLM 输出实时渲染,配合 Ink 的 `<Text>` 组件。
- **工具调用卡片**:每个工具调用渲染成独立卡片,显示工具名、参数摘要、状态(待审批/执行中/完成/失败)。
- **Diff 内联高亮**:edit 的变更以 git diff 格式内联展示,绿增红删。
- **审批三选项**:批准 / 拒绝(可附原因) / 查看 diff(展开完整变更)。支持"批准本次"和"本会话自动批准此类"。
- **进度条**:todos 实时渲染,让用户看到"做到哪一步了"。
- **中断与撤销**:
  - `Ctrl+C`:中断当前 LLM 调用或工具执行。
  - `Ctrl+Z` / `/undo`:回滚到上一个 git checkpoint。
- **斜杠命令**:`/model` 切模型、`/cost` 查花费、`/history` 看历史、`/clear` 清上下文。

#### 3.5.3 审批策略(颗粒度决定体验)

```
权限模式 (用户可切):
  ask        — 每个写操作都问 (默认)
  auto-edit  — edit 自动批准,bash 仍问
  auto-all   — 全部自动 (危险命令仍强制问)
  yolo       — 全部自动,含危险命令 (自负责任)
```

**危险命令无论什么模式都强制审批**——这是硬底线,`yolo` 模式也至少给一个"你确定?"的二次确认。

---

### 3.6 检查点与回滚 (Git Checkpoint)

继承 Aider 的核心设计:

- **每个 edit 后自动 commit**:Nexus 在 `.nexus/checkpoints` 分支(或 stash)上自动提交,commit message 描述改了什么。
- **结构化历史**:不只存 git commit,还存"这是第几步、对应哪个 todo、LLM 的理由是什么"。
- **回滚 UI**:`/undo` 回一步,`/jump <step>` 跳到任意历史步。UI 可渲染时间线。
- **退出时清理**:会话正常结束,询问用户是否合并 checkpoints 到工作分支。

这让"agent 犯错"从灾难变成"按一下 undo"。

---

## 4. 数据流与协议

### 4.1 一次完整任务的时序

```
用户                TUI              Orchestrator        Router        Tools(MCP)
 │                   │                   │                 │              │
 │─ 输入任务 ───────▶│                   │                 │              │
 │                   │─ submit() ───────▶│                 │              │
 │                   │                   │─ 进入 Plan 阶段  │              │
 │                   │                   │  组装 L1 上下文  │              │
 │                   │                   │─ plan 请求 ────▶│              │
 │                   │                   │                 │─ 调 LLM ────▶│(provider)
 │                   │                   │◀── plan 流 ─────│              │
 │                   │◀── 流式渲染 ──────│                 │              │
 │                   │                   │  (Plan 中调 read/grep)          │
 │                   │                   │──────────────────────────────▶│
 │                   │                   │◀─── 文件内容 ──────────────────│
 │                   │                   │─ 生成 todos     │              │
 │◀── 展示计划 ──────│                   │                 │              │
 │─ 批准/修改 ──────▶│                   │                 │              │
 │                   │─ approve() ──────▶│                 │              │
 │                   │                   │─ 进入 Execute   │              │
 │                   │                   │  ReAct loop:    │              │
 │                   │                   │  ┌─ exec 请求 ──▶│              │
 │                   │                   │  │              │─ 调 LLM      │
 │                   │                   │  │◀── tool_call ─│              │
 │                   │                   │  │  权限检查      │              │
 │                   │◀── 审批卡片 ──────│  │              │              │
 │                   │─ approve ────────▶│  │              │              │
 │                   │                   │──│───────────────────────────▶│(edit)
 │                   │                   │◀─│──────── diff ──────────────│
 │                   │                   │  │  git checkpoint             │
 │                   │                   │  │  喂回 LLM ───▶│(下一轮)     │
 │                   │                   │  └───────────────              │
 │                   │                   │  (loop 直到无 tool_call)        │
 │                   │                   │─ 验证 (跑测试)                 │
 │                   │◀── 最终结果 ──────│                 │              │
 │◀── 展示结果 ──────│                   │                 │              │
```

### 4.2 内部消息格式

TUI ↔ Orchestrator 之间用类型化的事件流(非 IPC,同进程):

```typescript
type NexusEvent =
  | { type: 'user_input'; text: string }
  | { type: 'llm_start'; phase: 'plan' | 'execute' }
  | { type: 'llm_chunk'; text: string }           // 流式 token
  | { type: 'tool_call'; tool: string; params: any; callId: string }
  | { type: 'tool_approval_request'; callId: string; diff?: string }
  | { type: 'tool_result'; callId: string; result: any; error?: string }
  | { type: 'todo_update'; todos: Todo[] }
  | { type: 'checkpoint'; step: number; message: string }
  | { type: 'cost_update'; inputTokens: number; outputTokens: number; cost: number }
  | { type: 'done'; summary: string }
  | { type: 'error'; message: string; recoverable: boolean };
```

### 4.3 MCP 工具协议

每个工具实现 MCP Server 的 `tools/list` 和 `tools/call`。Nexus 内部工具用 in-process transport(零开销),外部 MCP Server 用 stdio transport。

```json
// tools/list 响应示例
{
  "tools": [
    {
      "name": "edit_file",
      "description": "精准替换文件中的字符串。old_string 必须在文件中唯一匹配。",
      "inputSchema": {
        "type": "object",
        "properties": {
          "path": { "type": "string" },
          "old_string": { "type": "string", "description": "要替换的原文,必须唯一匹配" },
          "new_string": { "type": "string" }
        },
        "required": ["path", "old_string", "new_string"]
      }
    }
  ]
}
```

---

## 5. 目录结构(规划)

```
nexus/
├── package.json
├── tsconfig.json
├── bunfig.toml
├── README.md
├── DESIGN.md                  ← 本文档
├── .nexus/
│   ├── rules.toml             ← 项目约定(示例)
│   └── config.toml            ← Nexus 配置
├── src/
│   ├── index.ts               ← 入口
│   ├── cli/
│   │   ├── args.ts            ← 命令行参数解析
│   │   └── commands/          ← /model /cost 等斜杠命令
│   ├── tui/
│   │   ├── App.tsx            ← Ink 根组件
│   │   ├── components/
│   │   │   ├── MessageList.tsx
│   │   │   ├── ToolCard.tsx
│   │   │   ├── DiffView.tsx
│   │   │   ├── ApprovalPrompt.tsx
│   │   │   ├── TodoProgress.tsx
│   │   │   └── InputBox.tsx
│   │   └── theme.ts
│   ├── agent/
│   │   ├── Orchestrator.ts    ← Agent loop 核心
│   │   ├── Planner.ts         ← Plan 阶段
│   │   ├── Executor.ts        ← Execute 阶段
│   │   ├── SubAgent.ts        ← 子 Agent 分派
│   │   └── types.ts           ← NexusEvent 等类型
│   ├── context/
│   │   ├── Assembler.ts       ← 上下文组装
│   │   ├── Compressor.ts      ← 历史压缩
│   │   ├── TokenBudget.ts     ← Token 预算
│   │   ├── CodeGraph.ts       ← 代码图谱 (v1.1)
│   │   ├── SemanticSearch.ts  ← 语义检索 (v1.1)
│   │   └── RulesLoader.ts     ← .nexus/rules.toml
│   ├── router/
│   │   ├── ModelRouter.ts     ← 模型路由
│   │   ├── providers/         ← 各 provider 适配
│   │   └── CostTracker.ts
│   ├── tools/
│   │   ├── registry.ts        ← MCP 工具注册
│   │   ├── readFile.ts
│   │   ├── editFile.ts
│   │   ├── bash.ts
│   │   ├── grep.ts
│   │   └── external.ts        ← 外部 MCP Server 接入
│   ├── sandbox/
│   │   ├── CommandGuard.ts    ← 危险命令检测
│   │   └── Checkpoint.ts      ← Git 检查点
│   └── storage/
│       ├── db.ts              ← SQLite
│       └── migrations/
├── tests/
│   ├── unit/
│   ├── integration/
│   └── eval/                  ← Eval harness (SWE-bench 风格小任务)
└── packages/
    └── nexus-mcp-server/      ← 可独立发布的 MCP Server 包
```

---

## 6. 分阶段路线图

### Phase 0:骨架搭建(1 周)

**目标**:能跑通最小 agent loop,不追求 UI。

- [ ] Bun + TS + Ink 项目初始化
- [ ] Vercel AI SDK 接入一个 provider(先 Claude)
- [ ] 手写一个最简 ReAct loop(无 plan 阶段、无子 agent)
- [ ] `read_file` + `bash` 两个工具(不经 MCP,直接函数调用)
- [ ] 终端能输入输出,流式打印 LLM 响应

**验收**:在终端说"读一下 package.json 并告诉我用了哪些依赖",agent 能调 read_file 并回答。

### Phase 1:MVP —— 流式 TUI + 核心工具(2-3 周)

**这是首个面向用户的交付,UI 和工具可靠性绑在一起。**

- [ ] Ink TUI:消息列表、流式渲染、输入框
- [ ] 四个核心工具(read/edit/bash/grep),走 MCP 接口
- [ ] `edit_file` 的唯一匹配校验 + 原子写
- [ ] `bash` 的危险命令检测 + 超时 + 输出截断
- [ ] 工具调用卡片 + 审批 UX(批准/拒绝/看 diff)
- [ ] 权限模式(ask / auto-edit / auto-all)
- [ ] Git checkpoint + `/undo`
- [ ] 基础斜杠命令(/model /cost /clear)
- [ ] 成本追踪显示

**验收**:在真实项目里说"把 X 函数重命名并更新所有调用处",agent 能 plan → 审批 → 执行 → 跑测试 → undo 如果出错。**这一步过不了,不进 Phase 2。**

### Phase 2:上下文工程 + 多模型(2 周)

- [ ] `.nexus/rules.toml` 加载与注入
- [ ] 项目骨架树自动生成(L1 上下文)
- [ ] 上下文压缩策略(历史摘要 + 工具结果分级)
- [ ] Token 预算管理
- [ ] 多 provider 路由(加 OpenAI、Ollama)
- [ ] 分阶段模型路由(plan/execute/summarize 用不同模型)
- [ ] 降级与重试

**验收**:长会话(20+ 轮)不爆窗口;切到本地 Ollama 能跑;总成本比 Phase 1 降 30%+。

### Phase 3:子 Agent 编排(2 周)

- [ ] `dispatch_subagent` 工具
- [ ] 子 Agent 独立上下文 + 结果回传
- [ ] 写权限继承与授权
- [ ] 深度限制(1 层)
- [ ] UI 渲染子 Agent 进度

**验收**:给一个跨 10+ 文件的重构任务,主 agent 能正确分派、子 agent 并行执行、主 agent 汇总。

### Phase 4:语义检索 + Go 引擎评估(3-4 周)

- [ ] tree-sitter 代码骨架提取
- [ ] 本地 embedding + SQLite 索引
- [ ] `semantic_search` 工具
- [ ] 增量索引
- [ ] **评估**:实测是否需要 Go 引擎(看 bash/grep 的 P95 延迟 + 是否需要真沙箱)
- [ ] 若需要:抽离 bash 到 Go MCP Server

**验收**:语义检索召回率 > grep;Go 抽离后 agent loop 零改动验证通过。

### 持续进行:Eval Harness

从 Phase 1 就建,每 phase 都跑:
- 10-20 个 SWE-bench 风格小任务(单文件改、多文件改、修 bug、加测试)
- 每次改动都跑,记录通过率
- 没有这个就是盲人摸象,不知道改没改好

---

## 7. 关键决策记录(ADR 摘要)

| # | 决策 | 理由 | 何时反悔 |
|---|------|------|---------|
| 1 | TS 单体起步,不引入 Go | LLM 延迟主导,IPC 成本高 | 见 2.2 三个触发信号 |
| 2 | 工具层 MCP 原生 | 生态接入 + 反向挂载 + 未来抽离 | 不反悔 |
| 3 | Plan/Execute 双阶段 | 单 loop 大任务必翻车 | 极简任务可跳过 plan(优化) |
| 4 | edit 强制唯一匹配 | 防幻觉覆盖 | 不反悔 |
| 5 | 危险命令强制审批 | 安全底线 | 不反悔 |
| 6 | 子 Agent 限一层 | 防递归爆炸 | 若证明两层有用再放开 |
| 7 | embedding 跑本地 | 隐私底线 | 不反悔 |
| 8 | Bun 而非 Node | 启动快、单二进制 | 生态不兼容时回退 Node |

---

## 8. 避坑指南(踩过的和预见到的)

1. **流式 + tool calling 的边界**:不同 provider 流式返回 tool_call 的方式不同(有的分块、有的整块)。Vercel AI SDK 处理了大部分,但要在 Phase 1 早期用真实 provider 测透,别等到后面才发现解析 bug。

2. **Ink 的全屏 vs 行模式**:Ink 默认行模式(像日志),全屏模式(像 vim)要用 `useFullscreen`。审批卡片需要全屏交互,但流式输出适合行模式。混用是坑,Phase 1 早期定好。

3. **Windows 路径与换行符**:你是 Windows 环境,agent 生成的路径可能是 `src\utils\index.ts` 或 `src/utils/index.ts`。内部统一 POSIX,出口再转。bash 工具在 Windows 上要考虑 Git Bash / PowerShell / cmd 的差异——**MVP 锁定 Git Bash**(你当前 shell 就是)。

4. **大文件读取消耗**:agent 想读 `package-lock.json` 或 min.js,直接塞进 prompt 会 token 爆炸。read_file 默认截断(>2000 行给头尾),并在结果里提示"文件过长,已截断,用 grep 查具体内容"。

5. **僵尸进程**:bash 超时后 kill 不干净,子进程留在后台吃 CPU。用进程组 kill(Windows 上用 `taskkill /T`)。这是未来 Go 化的最大理由之一。

6. **MCP SDK 版本动荡**:MCP 协议还在演进,SDK breaking change 偶尔有。锁定版本,升级时跑 eval。

7. **成本失控**:auto-all 模式下 agent 可能疯狂调高档模型。设每会话成本上限,超了暂停问用户。

8. **Eval 不能只数通过率**:agent 改对了但绕路(改了无关文件)也是问题。eval 要看 diff 干净度。

---

## 9. 待讨论的开放问题

这些我还没定,想听你的想法:

1. **Nexus 的"人格"**:Claude Code 偏简洁专业,Aider 偏话痨解释。Nexus 默认语气你想偏哪种?(我倾向专业简洁,关键决策才解释。)

2. **会话持久化范围**:会话历史存本地 SQLite,要不要支持"恢复上次会话"?跨项目会话呢?

3. **多语言支持优先级**:MVP 先聚焦 TS/JS 项目(你自己用),还是一开始就要 Python/Go 通用?(我建议先 TS/JS,吃自己的狗粮。)

4. **商业化路径**:纯开源?开源+托管?这影响架构(是否要做服务端)。

5. **与 IDE 的关系**:v1 不做插件,但要不要预留 LSP 接口,未来 IDE 能挂?

---

## 下一步

这份设计是讨论稿,不是最终方案。建议你重点看:
- **第 2 节架构**和 **ADR 表**:确认架构起点决策
- **第 3.1 节 Agent loop** 和 **3.2.3 edit 可靠性**:这是技术风险最高的地方
- **第 6 节路线图**:Phase 1 的验收标准决定 MVP 边界
- **第 9 节开放问题**:给我反馈

你拍板后,我从 Phase 0 的骨架开始落地。或者你想先深挖某个模块(比如 edit 的可靠性、子 Agent 编排、上下文压缩算法),我可以单独出详细设计。

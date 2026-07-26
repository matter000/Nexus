# 贡献指南

感谢你对 Nexus 的关注！本文档说明如何参与项目开发。

## 开发环境

### 前置要求

- [Bun](https://bun.sh) >= 1.1.0（唯一支持的运行时，不兼容 Node.js）
- [Git](https://git-scm.com) >= 2.30
- [ripgrep](https://github.com/BurntSushi/ripgrep)（可选，grep 工具加速）

### 初始化

```bash
git clone https://github.com/matter000/Nexus.git
cd Nexus
bun install
```

### 常用命令

```bash
bun run dev          # 开发模式（文件变更自动重启）
bun run lint         # 类型检查（tsc --noEmit）
bun test             # 运行所有测试
bun run test:unit    # 仅单元测试
bun run test:integration  # 仅集成测试
bun run build        # 构建
```

提交前请确保 `bun run lint` 和 `bun test` 均通过。

## 代码规范

### 技术栈约定

- **运行时**：Bun（使用 `bun:sqlite`、`bun:test` 等内置能力，不引入 Node.js polyfill）
- **语言**：TypeScript strict 模式，禁止 `any`（测试文件的 `mock.module` 绕过除外）
- **校验**：工具入参用 Zod schema 校验，定义在 `src/tools/schemas.ts`
- **配置**：TOML 格式（`smol-toml`），不引入 JSON/YAML 配置文件
- **依赖**：尽量用 Bun 内置能力，新增三方依赖需说明必要性

### 分支与提交

- 从 `main` 创建分支，命名遵循 `<type>/<scope>` 格式：
  - `fix/provider-subagent-dispatch`（bug 修复）
  - `feat/semantic-search`（新功能）
  - `chore/engineering-infra`（工程基础设施）
  - `refactor/context-layer`（重构）
- 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/)：
  - `fix: 修复 Provider 适配器不感知 secrets 配置`
  - `feat: 新增语义检索工具`
  - `docs: 重写 README 安装说明`
  - `chore: 移除 package-lock.json`
  - `refactor: 整理目录结构`
- 一个分支聚焦一件事，混合多种改动的 PR 拆分为多个

### 测试

- 新功能或 bug 修复必须附带测试
- 推荐先写失败测试复现问题（TDD），再改代码让测试通过
- 单元测试放 `tests/unit/`，集成测试放 `tests/integration/`
- 测试文件与被测模块同名：`src/router/ModelRouter.ts` → `tests/unit/router.test.ts`

## 添加新工具

1. 在 `src/tools/` 创建工具文件（参考 `createFile.ts`）
2. 在 `src/tools/schemas.ts` 添加 Zod 校验 schema
3. 在 `src/tools/registry.ts` 的 `createToolRegistry()` 中注册工具
4. 在 `src/tui/theme.ts` 添加标签颜色（可选）
5. 在 `tests/unit/` 或 `tests/integration/tools.test.ts` 添加测试
6. 更新 `tests/integration/newTools.test.ts` 的工具数量断言

工具定义结构：

```typescript
const definition: ToolDefinition = {
  name: 'my_tool',
  description: '工具说明，LLM 会看到',
  inputSchema: { type: 'object', properties: { /* ... */ }, required: [] },
  requiresApproval: false,  // 写操作设为 true
  phase: 'execute',         // 'plan' | 'execute' | 'both'
}
```

安全检查由 `ToolRegistry.execute()` 统一处理（路径遍历 + SSRF），工具自身无需重复实现。

## 项目结构

```
src/
├── agent/     # Agent 核心（Orchestrator, Planner, Executor, SubAgent, ReActLoop）
├── cli/       # CLI 参数解析 + 斜杠命令
├── context/   # 上下文工程（Assembler, CodeGraph, Compressor, SemanticSearch, TokenBudget）
├── core/      # EventBus 事件总线
├── harness/   # 评估引擎
├── router/    # 模型路由 + 成本追踪 + Provider 适配
├── sandbox/   # 沙箱（CommandGuard, Checkpoint, SandboxEngine）
├── storage/   # SQLite 存储层
├── tools/     # 内置工具 + ToolRegistry
├── tui/       # TUI 组件（Ink + React）
└── utils/     # 工具函数
```

详细架构设计见 `docs/DESIGN.md`。

## 报告 Bug

- 使用 GitHub Issues
- 描述复现步骤、期望行为、实际行为
- 附上 `.nexus/debug.jsonl` 中的相关日志（注意删除 API Key 等敏感信息）

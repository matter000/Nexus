# Nexus 云端调度（Cloud Scheduling）

> 让 Nexus 任务在本地关机、合盖、断网时照常运行——把 loops.toml 式的自动化任务"搬上" GitHub Actions。
> 本文档对应模板：[`.github/workflows/nexus-cloud-automation.yml`](../.github/workflows/nexus-cloud-automation.yml)（默认不启用，按本文启用）。
> 更新日期：2026-08-09。**云端调度不改动 Nexus 运行时代码**，复用已有 `--non-interactive --output json` CLI 入口（`src/cli/args.ts`）。

## 1. 概念：本地调度 vs 云端调度

Nexus 的本地调度（`/loop`、`/loops` + `.nexus/loops.toml` 心跳）与云端调度互补：

| 维度 | 本地 /loops（已有） | 云端调度（本模板） |
|------|--------------------|-------------------|
| 运行位置 | 你的电脑、你的终端会话 | GitHub Actions 托管环境 |
| 触发 | 会话内心跳（最小 1m） | workflow_dispatch 手动 / cron 定时 |
| 关机/合盖 | 不运行 | 照常运行 |
| 审批 | 支持（人在环中） | 无审批（--non-interactive 全自动） |
| 数据面 | 本地文件、私有代码 | 已推送仓库的代码 |
| 成本 | 本地计算 + API Key | API Key + GitHub Actions 免费额度（约 2000 分钟/月） |
| 典型场景 | 交互式值班任务 | CI 失败自动修复、每日巡检、定时报告 |

## 2. loops.toml 语义 → workflow 映射

本地 `loops.toml`（`src/agent/LoopConfigLoader.ts`）与云端模板的对应关系：

| loops.toml 字段 | 云端映射 | 说明 |
|-----------------|---------|------|
| `[loops.<name>].schedule` | workflow `schedule.cron` | 本地是分钟间隔（`10m`/`1h`），云端是 cron 表达式（UTC） |
| `[loops.<name>].prompt` | `.nexus/cloud-tasks/<name>.prompt` 文件 | 任务指令与 workflow 解耦：改 prompt 文件即换任务，无需改 workflow |
| `[loops.<name>].gates` | 无需配置 | `--non-interactive` 执行自动走证据门禁（lint/typecheck/test）与修复循环 |
| `[loops.<name>].max_cost` | 会话 `max_session_cost`（默认 $5） | 云端任务成本由 `[limits] max_session_cost` 兜底，也可在 prompt 中约束 |
| `[loops.<name>].worktree` | 不支持 | 云端天然隔离环境，无需 worktree |
| `[loops.<name>].enabled` | 注释/取消注释 `schedule` | 云端启用 = 取消 cron 注释；停用 = 重新注释或禁用 workflow |

## 3. 快速启用（5 步）

1. **配置 API Key**：仓库 Settings → Secrets and variables → Actions → New repository secret，添加 `NEXUS_API_KEY`（值 = DeepSeek/Anthropic/OpenAI Key；模板默认注入 `DEEPSEEK_API_KEY` 环境变量，如用其他 Provider 修改模板 `env` 段）
2. **创建任务文件**：新建 `.nexus/cloud-tasks/ci-daily.prompt`，写入任务描述（见下方示例），提交推送到 main
3. **复制模板 workflow**：把 `.github/workflows/nexus-cloud-automation.yml` 的 `schedule` 取消注释并改成你的 cron（如 `'0 2 * * *'` = 每日 02:00 UTC）
4. **手动试跑**：Actions 页 → Nexus Cloud Automation (template) → Run workflow，确认任务成功
5. **查看结果**：任务输出在 workflow 日志；loop-state 变更会以 `[skip ci]` 提交写回仓库

### 示例任务：每日 CI 修复

`.nexus/cloud-tasks/ci-daily.prompt`：

```
检查 GitHub Actions 的 CI 状态（quality job）。如果 CI 失败，定位失败原因并修复代码，
运行 bun run lint 与相关测试确认修复，然后提交修复（commit message 以 "fix(ci):" 开头）
并推送。如果 CI 已通过，无需任何改动，直接报告"CI 正常"。
```

## 4. 防失忆与停止

- **状态写回**：模板的 "Commit loop state" 步骤把 `.nexus/loop-state*.md` 提交回仓库——每轮任务从上一轮进度继续（与本地 `/loop` 同机制，`src/agent/LoopState.ts`）
- **停止循环**：改 `.nexus/loop-state*.md` 中的 `stop_requested` 标记，或在 GitHub 禁用 workflow
- **避免死循环**：任务 prompt 应写明"如果已经做过/已正常，直接报告"，配合 `max_session_cost` 成本兜底

## 5. 多任务扩展

**方式 A：复制 job**——把 `run-task` job 整体复制一份，改 `.prompt` 文件名与 job id。

**方式 B：matrix**——一个 job 跑多个任务：

```yaml
jobs:
  run-tasks:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        task: [ci-daily, dependency-scan, docs-check]
    steps:
      # ... checkout / setup-bun / bun install 同上 ...
      - name: Run Nexus task
        run: bun run src/index.ts --non-interactive --output json "$(cat .nexus/cloud-tasks/${{ matrix.task }}.prompt)"
```

## 6. 安全与成本

- **Key 安全**：API Key 只存 GitHub Secrets，不会出现在代码或日志；模板中 `DEEPSEEK_API_KEY` 仅为示例映射，按实际 Provider 调整
- **权限最小化**：模板使用 `permissions: contents: write`（提交 loop-state 所需）；如需开 PR 再加 `pull-requests: write`
- **成本控制**：云端任务自动受 `max_session_cost`（默认 $5/会话）约束；CI 免费额度对每天 1-2 次的小任务绰绰有余
- **数据边界**：云端只能访问已推送的仓库内容；本地未提交的代码不会参与

## 7. 已知限制

- cron 最小粒度 5 分钟（GitHub Actions 限制），秒级/分钟级任务仍用本地 `/loops`
- 云端无法读取本地 secrets.toml 与私有文件，任务依赖的凭据需经 GitHub Secrets
- 国内网络访问 GitHub Actions 运行环境不受影响（执行在 GitHub 侧），但任务内联网请求按 GitHub 出口策略执行

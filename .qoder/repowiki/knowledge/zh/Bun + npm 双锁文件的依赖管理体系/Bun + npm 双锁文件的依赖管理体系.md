---
kind: dependency_management
name: Bun + npm 双锁文件的依赖管理体系
category: dependency_management
scope:
    - '**'
source_files:
    - package.json
    - bun.lock
    - package-lock.json
    - bunfig.toml
    - packages/nexus-mcp-server/package.json
---

## 1. 使用的系统与工具
- 包管理器：以 Bun 为主（bunfig.toml、bun.lock），同时保留 package.json 与 package-lock.json，形成“Bun 运行 + npm 兼容”的双轨方案。
- 工作区结构：根目录为单包 workspace，packages/nexus-mcp-server 作为独立子包发布，共享根级依赖声明。
- 运行时约束：通过 engines.bun >= 1.1.0 强制要求使用 Bun 运行。

## 2. 关键文件与位置
- package.json：顶层依赖声明、脚本、bin 入口、TypeScript/React 类型等 devDependencies。
- bun.lock：Bun 的锁定文件，记录所有已解析包的精确版本与镜像地址（npmmirror）。
- package-lock.json：npm 锁文件，用于 CI 或需要 npm 兼容的场景。
- bunfig.toml：Bun 安装与测试行为配置（peer 依赖处理、超时等）。
- packages/nexus-mcp-server/package.json：MCP Server 子包，仅依赖 @modelcontextprotocol/sdk，保持最小化。

## 3. 架构与约定
- 依赖分类清晰：生产依赖集中在 dependencies（AI SDK、SQLite、TUI 组件、Zod 校验等），开发依赖集中在 devDependencies（TS、类型定义、lint 脚本）。
- 版本策略：全部采用 ^ 语义化版本范围，配合 lockfile 保证可重现构建；未使用固定到次版本或补丁版本。
- Peer 依赖处理：bunfig.toml 中 [install] peer = false，Bun 自动将 peer 依赖降级为普通依赖，避免 peer 冲突。
- 私有源/镜像：从 bun.lock 可见所有包均从 https://registry.npmmirror.com 拉取，说明团队统一使用国内镜像加速下载。
- 子包隔离：MCP Server 子包只声明自身所需的最小依赖，不重复引入根级 AI SDK 等重型包，减少体积。

## 4. 开发者应遵循的规则
1. 新增依赖时：在根 package.json 的对应字段添加，提交后同步更新 bun.lock（推荐用 bun install）；如需兼容 npm 环境，也更新 package-lock.json。
2. 不要手动编辑 lockfile：始终通过包管理器命令变更依赖，确保 sha512 与元数据一致。
3. 子包依赖最小化：仅在子包 package.json 中声明该包真正需要的依赖，避免把根级依赖透传到子包。
4. 保持 engines 约束：升级 Bun 大版本时需同步调整 engines.bun 范围并验证构建。
5. 镜像一致性：所有成员使用同一镜像源（npmmirror），避免跨源导致的锁文件不一致。
6. Peer 依赖谨慎使用：当前项目关闭了 peer 依赖安装，若引入新库需评估是否仍适用此策略。
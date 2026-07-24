---
kind: build_system
name: 基于 Bun 的单仓构建与脚本体系
category: build_system
scope:
    - '**'
source_files:
    - package.json
    - bunfig.toml
    - tsconfig.json
---

本项目采用纯 Bun + TypeScript 的轻量构建方案，未引入 Makefile、Dockerfile 或 CI 流水线等外部构建系统，所有构建、测试、打包逻辑均集中在仓库根目录的几个配置文件中。

1. 运行时与包管理
   - 使用 Bun 作为运行时、包管理器与任务运行器（engines.bun >= 1.1.0），通过 bun.lock 锁定依赖版本。
   - package.json 中声明入口 src/index.ts，并通过 bin.nexus 将源码直接注册为 CLI 命令，无需额外打包即可全局安装。

2. TypeScript 编译与类型检查
   - tsconfig.json 以 ESNext + bundler 解析模式为目标，启用严格模式、JSX transform、sourceMap 与 declaration 输出；路径别名 @/* → ./src/* 统一模块引用。
   - 类型检查通过 npm run lint 执行 tsc --noEmit，不产出生成文件，仅做静态校验。

3. 构建产物
   - build 脚本调用 bun build src/index.ts --outdir dist --target bun，将单入口打包为针对 Bun 运行时的独立可执行文件，输出到 dist/。
   - 开发模式通过 dev 脚本配合 --watch 实现热重载。

4. 测试体系
   - 全部测试由 bun test 驱动，按目录拆分为单元测试（tests/unit/）与集成测试（tests/integration/），并提供 test:unit、test:integration 子脚本。
   - bunfig.toml 中设置测试超时 30s、禁用 peer 依赖安装、强制使用 Bun 运行器。

5. 发布与分发约定
   - 项目未包含 Dockerfile、CI 工作流或 release 脚本；当前分发方式依赖 npm 包名 nexus 及 bin 字段，用户可通过 npm i -g nexus 直接安装 CLI。
   - 版本号遵循语义化版本（0.1.0），但未见自动化发布流程。

开发者应遵循的约定：
- 新增 CLI 功能时保持入口在 src/index.ts，确保 bun build 能正确打包。
- 新增测试文件放入 tests/unit/ 或 tests/integration/，并优先使用 bun test 运行。
- 依赖变更需更新 bun.lock，避免引入非 Bun 兼容的 native 模块。
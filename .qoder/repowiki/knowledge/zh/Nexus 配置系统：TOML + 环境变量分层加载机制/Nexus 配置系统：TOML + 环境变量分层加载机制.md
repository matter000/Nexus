---
kind: configuration_system
name: Nexus 配置系统：TOML + 环境变量分层加载机制
category: configuration_system
scope:
    - '**'
source_files:
    - src/config.ts
    - src/config-secrets.ts
    - src/agent/types.ts
    - .nexus/config.toml
    - .nexus/rules.toml
    - bunfig.toml
---

## 1. 系统概述
Nexus 采用「项目级 TOML 配置 + 全局 Secrets 文件 + 环境变量」三层叠加的配置体系，核心由 src/config.ts（应用配置）与 src/config-secrets.ts（密钥管理）两个模块实现，使用 smol-toml 解析 TOML，通过 structuredClone 合并默认值。

## 2. 关键文件与职责
- src/config.ts — 加载 .nexus/config.toml，合并内置 DEFAULT_CONFIG，输出 NexusConfig 类型对象
- src/config-secrets.ts — 管理 API Key 的持久化与读取，支持全局 ~/.nexus/secrets.toml 与项目级 .nexus/secrets.toml 回退
- src/agent/types.ts — 定义 NexusConfig、ProviderConfig、ProjectRules 等所有配置结构体
- .nexus/config.toml — 项目级运行时配置（模型路由、权限模式、成本限制、上下文预算、checkpoint 策略）
- .nexus/rules.toml — 项目规则（语言、测试命令、代码风格、硬约束、常驻上下文）
- bunfig.toml — Bun 构建器自身配置（测试超时、peer install、运行器）
- package.json — 声明依赖 smol-toml、zod，并暴露 CLI bin 入口

## 3. 架构与约定
### 3.1 配置来源优先级（从高到低）
1. 环境变量 — 如 ANTHROPIC_API_KEY、OPENAI_API_KEY、DEEPSEEK_API_KEY、CUSTOM_API_KEY
2. 全局 secrets 文件 — ~/.nexus/secrets.toml（用户级共享）
3. 项目级 secrets 文件 — <project>/.nexus/secrets.toml（兼容旧版本）
4. 项目级 config.toml — <project>/.nexus/config.toml（业务配置）
5. 内置默认值 — DEFAULT_CONFIG 中定义的兜底值

### 3.2 配置结构分层
- 应用配置 (NexusConfig)：按 models / permissions / limits / context / checkpoint 五个域组织，每个域在 mergeConfig 中独立合并，字段名采用 snake_case → camelCase 映射（如 max_session_cost → maxSessionCost）
- Secrets 配置 (SecretsConfig)：扁平 providers 表 + 可选 defaultProvider / defaultModel 选择
- 项目规则 (ProjectRules)：独立于运行时配置，用于指导 Agent 生成代码的风格与约束

### 3.3 密钥获取流程
getEffectiveApiKey(providerName, envVarName, secrets)
  ├─ process.env[envVarName] ? 返回环境变量
  └─ secrets.providers[providerName].apiKey ? 返回 secrets 文件
     └─ undefined
- hasAnyApiKey() 一次性检测是否有任何 provider 可用
- getProviderStatus() 返回各 provider 的可用性状态及来源（env | secrets | none），供 TUI 展示
- maskApiKey() 提供脱敏显示

### 3.4 配置文件位置策略
- 应用配置：项目根下 .nexus/config.toml，不存在则静默回退到默认值
- 密钥存储：优先写入全局 ~/.nexus/secrets.toml，读取时先全局后项目级（兼容旧版）
- 项目规则：.nexus/rules.toml，被 src/context/RulesLoader.ts 消费

## 4. 开发者应遵循的规则
- 新增配置项：先在 types.ts 的 NexusConfig 接口中声明，再在 config.ts 的 DEFAULT_CONFIG 和 mergeConfig 中同步添加默认值与解析逻辑
- 新增 Provider：在 DEFAULT_CONFIG.models.providers 中添加默认条目，并在 config-secrets.ts 的 getProviderStatus 列表中加入对应定义
- 敏感信息永不写入 config.toml：API Key 一律走环境变量或 secrets.toml；saveSecrets 会主动跳过空 key
- 字段命名约定：TOML 侧用 snake_case，JS 侧用 camelCase，合并时需显式映射
- 向后兼容：对已有字段做增量合并（structuredClone(DEFAULT_CONFIG) 后再覆盖），禁止直接替换整个配置对象
- 全局 vs 项目级：用户偏好（默认 provider/model）存全局，项目特定设置存项目级，避免污染他人环境
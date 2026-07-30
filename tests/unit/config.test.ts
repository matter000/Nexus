import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadConfig } from '../../src/config'

describe('Config Loader', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'nexus-config-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  async function writeConfigToml(content: string) {
    const nexusDir = join(tempDir, '.nexus')
    const { mkdir } = await import('fs/promises')
    await mkdir(nexusDir, { recursive: true })
    await writeFile(join(nexusDir, 'config.toml'), content, 'utf-8')
  }

  it('返回合理默认配置（无配置文件时）', async () => {
    const config = await loadConfig(tempDir)

    expect(config.models.planner).toBe('auto')
    expect(config.models.executor).toBe('auto')
    expect(config.models.summarizer).toBe('auto')
    expect(config.models.verifier).toBe('auto')
    expect(config.permissions.mode).toBe('ask')
    expect(config.limits.maxSessionCost).toBe(5.0)
    expect(config.limits.bashTimeout).toBe(30)
    expect(config.limits.maxReadLines).toBe(2000)
    expect(config.limits.maxIterations).toBe(50)
    expect(config.limits.maxOutputBytes).toBe(102400)
    expect(config.context.budgetRatio).toBe(0.8)
    expect(config.context.recentTurnsKeep).toBe(5)
    expect(config.checkpoint.autoCheckpoint).toBe(true)
    expect(config.checkpoint.branch).toBe('nexus/checkpoints')
  })

  it('正确解析 TOML 配置文件', async () => {
    await writeConfigToml(`
[models]
planner = "claude-3-opus"
executor = "gpt-4o"

[permissions]
mode = "yolo"

[limits]
max_iterations = 100
max_session_cost = 10.0
bash_timeout = 60

[context]
budget_ratio = 0.9
recent_turns_keep = 10

[checkpoint]
auto_checkpoint = false
branch = "my-checkpoints"
`)
    const config = await loadConfig(tempDir)

    expect(config.models.planner).toBe('claude-3-opus')
    expect(config.models.executor).toBe('gpt-4o')
    expect(config.permissions.mode).toBe('yolo')
    expect(config.limits.maxIterations).toBe(100)
    expect(config.limits.maxSessionCost).toBe(10.0)
    expect(config.limits.bashTimeout).toBe(60)
    expect(config.context.budgetRatio).toBe(0.9)
    expect(config.context.recentTurnsKeep).toBe(10)
    expect(config.checkpoint.autoCheckpoint).toBe(false)
    expect(config.checkpoint.branch).toBe('my-checkpoints')
  })

  it('models 包含 planner/executor/summarizer/verifier 角色配置', async () => {
    const config = await loadConfig(tempDir)

    expect('planner' in config.models).toBe(true)
    expect('executor' in config.models).toBe(true)
    expect('summarizer' in config.models).toBe(true)
    expect('verifier' in config.models).toBe(true)
    expect(typeof config.models.planner).toBe('string')
    expect(typeof config.models.executor).toBe('string')
    expect(typeof config.models.summarizer).toBe('string')
    expect(typeof config.models.verifier).toBe('string')
  })

  it('permissions.mode 支持四种权限模式', async () => {
    const validModes = ['ask', 'auto-edit', 'auto-all', 'yolo'] as const

    for (const mode of validModes) {
      await writeConfigToml(`
[permissions]
mode = "${mode}"
`)
      const config = await loadConfig(tempDir)
      expect(config.permissions.mode).toBe(mode)
    }
  })

  it('limits 包含所有限制字段且可被覆盖', async () => {
    await writeConfigToml(`
[limits]
max_session_cost = 99.9
bash_timeout = 120
max_read_lines = 5000
max_iterations = 200
max_output_bytes = 204800
`)
    const config = await loadConfig(tempDir)

    expect(config.limits.maxSessionCost).toBe(99.9)
    expect(config.limits.bashTimeout).toBe(120)
    expect(config.limits.maxReadLines).toBe(5000)
    expect(config.limits.maxIterations).toBe(200)
    expect(config.limits.maxOutputBytes).toBe(204800)
  })

  it('部分配置与默认配置深层合并（未指定字段保留默认值）', async () => {
    await writeConfigToml(`
[limits]
max_iterations = 10

[permissions]
mode = "auto-edit"
`)
    const config = await loadConfig(tempDir)

    // 用户指定的字段被覆盖
    expect(config.limits.maxIterations).toBe(10)
    expect(config.permissions.mode).toBe('auto-edit')

    // 未指定的字段保留默认值（深层合并，非整体覆盖）
    expect(config.limits.maxSessionCost).toBe(5.0)
    expect(config.limits.bashTimeout).toBe(30)
    expect(config.limits.maxReadLines).toBe(2000)
    expect(config.limits.maxOutputBytes).toBe(102400)
    expect(config.models.planner).toBe('auto')
    expect(config.context.budgetRatio).toBe(0.8)
    expect(config.checkpoint.autoCheckpoint).toBe(true)
  })

  it('providers 配置可被 TOML 覆盖', async () => {
    await writeConfigToml(`
[models.providers.openai]
api_key_env = "MY_OPENAI_KEY"
default_model = "gpt-4-turbo"
`)
    const config = await loadConfig(tempDir)

    expect(config.models.providers.openai.apiKeyEnv).toBe('MY_OPENAI_KEY')
    expect(config.models.providers.openai.defaultModel).toBe('gpt-4-turbo')
  })

  it('cost_overrides 解析为模型成本覆盖', async () => {
    await writeConfigToml(`
[models.cost_overrides."my-custom-model"]
cost_per_1k_input = 0.001
cost_per_1k_output = 0.005
`)
    const config = await loadConfig(tempDir)

    expect(config.models.costOverrides).toBeDefined()
    expect(config.models.costOverrides?.['my-custom-model']).toEqual({
      costPer1kInput: 0.001,
      costPer1kOutput: 0.005,
    })
  })

  it('cost_overrides 忽略字段不完整的条目', async () => {
    await writeConfigToml(`
[models.cost_overrides."bad-model"]
cost_per_1k_input = 0.001
`)
    const config = await loadConfig(tempDir)

    // 缺少 cost_per_1k_output，该条目应被忽略
    expect(config.models.costOverrides?.['bad-model']).toBeUndefined()
  })
})

/**
 * API 配置面板组件
 * 交互式配置 Provider、API Key、Base URL 和模型名称
 * 支持首次启动引导和 /config 命令触发
 *
 * 交互流程:
 *   1. 选择 Provider（↑↓ 循环导航，Enter 确认）
 *   2. 输入 API Key（密码模式，Enter 确认）
 *   3. 输入 Base URL（自由文本，Enter 确认，非 Custom 可留空跳过）
 *   4. 输入模型名称（自由文本，Enter 确认，非 Custom 可留空跳过）
 */

import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { theme } from '../theme'
import type { SecretsConfig } from '../../config-secrets'
import { getProviderStatus, maskApiKey } from '../../config-secrets'

type ConfigStep = 'select_provider' | 'input_key' | 'input_base_url' | 'input_model' | 'done'

interface ApiConfigPanelProps {
  secrets: SecretsConfig
  onSave: (secrets: SecretsConfig) => Promise<void>
  onClose: () => void
  /** 是否为首次启动引导模式 */
  isFirstRun?: boolean
}

interface ProviderDef {
  name: string
  label: string
  envVar: string
  defaultBaseUrl: string
  defaultModel: string
}

const PROVIDER_LIST: ProviderDef[] = [
  { name: 'anthropic', label: 'Anthropic', envVar: 'ANTHROPIC_API_KEY', defaultBaseUrl: 'https://api.anthropic.com', defaultModel: 'claude-sonnet-4-20250514' },
  { name: 'openai', label: 'OpenAI', envVar: 'OPENAI_API_KEY', defaultBaseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o' },
  { name: 'deepseek', label: 'DeepSeek', envVar: 'DEEPSEEK_API_KEY', defaultBaseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-chat' },
  { name: 'custom', label: 'Custom (OpenAI 兼容)', envVar: 'CUSTOM_API_KEY', defaultBaseUrl: '', defaultModel: '' },
]

export function ApiConfigPanel({ secrets, onSave, onClose, isFirstRun = false }: ApiConfigPanelProps) {
  const [step, setStep] = useState<ConfigStep>('select_provider')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [inputValue, setInputValue] = useState('')
  const [selectedProvider, setSelectedProvider] = useState<ProviderDef | null>(null)
  const [pendingKey, setPendingKey] = useState('')
  const [pendingBaseUrl, setPendingBaseUrl] = useState('')
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  const providerStatus = getProviderStatus(secrets)

  // ─── useInput: 在所有条件分支之前调用，遵守 React Hooks 规则 ───────────────
  useInput((input, key) => {
    if (key.escape) {
      if (isFirstRun && step !== 'done') return // 首次引导不允许跳过
      onClose()
      return
    }

    switch (step) {
      case 'select_provider':
        handleSelectProvider(input, key)
        break
      case 'input_key':
      case 'input_base_url':
      case 'input_model':
        handleTextInput(input, key)
        break
      case 'done':
        if (key.return) onClose()
        break
    }
  })

  function handleSelectProvider(
    input: string,
    key: { upArrow?: boolean; downArrow?: boolean; return?: boolean },
  ) {
    if (key.upArrow) {
      // ↑ 循环导航：到顶部时跳到最后一个
      setSelectedIndex((i) => (i - 1 + PROVIDER_LIST.length) % PROVIDER_LIST.length)
    } else if (key.downArrow) {
      // ↓ 循环导航：到底部时跳到第一个
      setSelectedIndex((i) => (i + 1) % PROVIDER_LIST.length)
    } else if (key.return) {
      const provider = PROVIDER_LIST[selectedIndex]
      setSelectedProvider(provider)
      setInputValue('')
      setError('')
      setStep('input_key')
    }
  }

  function handleTextInput(
    input: string,
    key: { return?: boolean; backspace?: boolean; delete?: boolean },
  ) {
    if (key.return) {
      submitCurrentStep()
      return
    }
    if (key.backspace || key.delete) {
      setInputValue((v) => v.slice(0, -1))
      return
    }
    if (input) {
      setInputValue((v) => v + input)
    }
  }

  async function submitCurrentStep() {
    if (step === 'input_key') {
      if (!inputValue.trim()) {
        setError('API Key 不能为空')
        return
      }
      setPendingKey(inputValue.trim())
      setInputValue('')
      setError('')
      setStep('input_base_url')
    } else if (step === 'input_base_url') {
      const baseUrl = inputValue.trim()
      // Custom provider 必须提供 Base URL
      if (!baseUrl && selectedProvider?.name === 'custom') {
        setError('Base URL 不能为空（自定义 Provider 必须指定端点）')
        return
      }
      setPendingBaseUrl(baseUrl)
      setInputValue('')
      setError('')
      setStep('input_model')
    } else if (step === 'input_model') {
      const model = inputValue.trim()
      // Custom provider 必须提供模型名
      if (!model && selectedProvider?.name === 'custom') {
        setError('模型名称不能为空（自定义 Provider 必须指定模型）')
        return
      }
      await finalizeSave(pendingKey, pendingBaseUrl, model)
    }
  }

  async function finalizeSave(apiKey: string, baseUrl: string, model: string) {
    if (!selectedProvider) return

    const newSecrets: SecretsConfig = {
      ...secrets,
      providers: {
        ...secrets.providers,
        [selectedProvider.name]: {
          apiKey,
          ...(baseUrl ? { baseUrl } : {}),
          ...(model ? { defaultModel: model } : {}),
        },
      },
      defaultProvider: selectedProvider.name,
      ...(model ? { defaultModel: model } : {}),
    }

    try {
      await onSave(newSecrets)
      setSaved(true)
      setStep('done')
    } catch (err) {
      setError(`保存失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ─── 渲染 ─────────────────────────────────────────────────────────────────

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.colors.primary} paddingX={1}>
      <Box>
        <Text bold color={theme.colors.primary}>
          {isFirstRun ? '🔑 首次配置 - 选择你的 LLM Provider' : '⚙️ API 配置'}
        </Text>
      </Box>

      {error ? (
        <Box marginTop={1}>
          <Text color={theme.colors.error}>✗ {error}</Text>
        </Box>
      ) : null}

      {step === 'select_provider' && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.colors.muted}>↑↓ 选择 · Enter 确认 · Esc 关闭</Text>
          <Box flexDirection="column" marginTop={1}>
            {PROVIDER_LIST.map((p, i) => {
              const status = providerStatus.find((s) => s.name === p.name)
              const isSelected = i === selectedIndex
              const keyStatus = status?.hasKey
                ? ` ✓ 已配置(${status.source === 'env' ? '环境变量' : '本地'})`
                : ' ○ 未配置'
              return (
                <Box key={p.name}>
                  <Text color={isSelected ? theme.colors.primary : undefined} bold={isSelected}>
                    {isSelected ? '▶ ' : '  '}
                  </Text>
                  <Text color={isSelected ? theme.colors.primary : undefined}>
                    {p.label}
                  </Text>
                  <Text color={status?.hasKey ? theme.colors.success : theme.colors.muted}>
                    {keyStatus}
                  </Text>
                </Box>
              )
            })}
          </Box>
        </Box>
      )}

      {step === 'input_key' && selectedProvider && (
        <Box flexDirection="column" marginTop={1}>
          <Text>输入 <Text bold>{selectedProvider.label}</Text> 的 API Key:</Text>
          <Box marginTop={1}>
            <Text color={theme.colors.primary}>{'> '}</Text>
            <Text>{inputValue ? '•'.repeat(inputValue.length) : ''}</Text>
            <Text color={theme.colors.primary}>▌</Text>
          </Box>
          <Text color={theme.colors.muted} dimColor>
            支持粘贴长密钥，输入时显示 •••••• 遮蔽
          </Text>
        </Box>
      )}

      {step === 'input_base_url' && selectedProvider && (
        <Box flexDirection="column" marginTop={1}>
          <Text>Base URL{selectedProvider.name !== 'custom' ? ' (留空使用默认)' : ''}:</Text>
          <Box marginTop={1}>
            <Text color={theme.colors.primary}>{'> '}</Text>
            <Text>{inputValue || ''}</Text>
            <Text color={theme.colors.primary}>▌</Text>
          </Box>
          <Text color={theme.colors.muted} dimColor>
            默认: {selectedProvider.defaultBaseUrl || '(自定义端点)'}
            {selectedProvider.name !== 'custom' ? ' · 直接 Enter 使用默认' : ''}
          </Text>
        </Box>
      )}

      {step === 'input_model' && selectedProvider && (
        <Box flexDirection="column" marginTop={1}>
          <Text>模型名称{selectedProvider.name !== 'custom' ? ' (留空使用默认)' : ''}:</Text>
          <Box marginTop={1}>
            <Text color={theme.colors.primary}>{'> '}</Text>
            <Text>{inputValue || ''}</Text>
            <Text color={theme.colors.primary}>▌</Text>
          </Box>
          <Text color={theme.colors.muted} dimColor>
            例如: {selectedProvider.defaultModel || 'gpt-4o, claude-sonnet-4, deepseek-chat'}
            {selectedProvider.name !== 'custom' ? ' · 直接 Enter 使用默认' : ''}
          </Text>
        </Box>
      )}

      {step === 'done' && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.colors.success} bold>✓ 配置已保存到 .nexus/secrets.toml</Text>
          <Text color={theme.colors.muted}>
            Provider: {selectedProvider?.label} · Key: {maskApiKey(pendingKey)}
            {pendingBaseUrl ? ` · URL: ${pendingBaseUrl}` : ''}
          </Text>
          <Box marginTop={1}>
            <Text color={theme.colors.muted}>按 Enter 继续...</Text>
          </Box>
        </Box>
      )}
    </Box>
  )
}

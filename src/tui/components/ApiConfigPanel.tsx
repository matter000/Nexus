/**
 * API 配置面板组件
 * 交互式配置 Provider 和 API Key
 * 支持首次启动引导和 /config 命令触发
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

const PROVIDER_LIST = [
  { name: 'anthropic', label: 'Anthropic (Claude)', envVar: 'ANTHROPIC_API_KEY', needsBaseUrl: false },
  { name: 'openai', label: 'OpenAI (GPT)', envVar: 'OPENAI_API_KEY', needsBaseUrl: false },
  { name: 'deepseek', label: 'DeepSeek', envVar: 'DEEPSEEK_API_KEY', needsBaseUrl: false },
  { name: 'custom', label: '自定义 (Moonshot/智谱/硅基流动等)', envVar: 'CUSTOM_API_KEY', needsBaseUrl: true },
]

export function ApiConfigPanel({ secrets, onSave, onClose, isFirstRun = false }: ApiConfigPanelProps) {
  const [step, setStep] = useState<ConfigStep>('select_provider')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [inputValue, setInputValue] = useState('')
  const [selectedProvider, setSelectedProvider] = useState<typeof PROVIDER_LIST[0] | null>(null)
  const [pendingKey, setPendingKey] = useState('')
  const [pendingBaseUrl, setPendingBaseUrl] = useState('')
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  const providerStatus = getProviderStatus(secrets)

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

  function handleSelectProvider(input: string, key: { upArrow?: boolean; downArrow?: boolean; return?: boolean }) {
    if (key.upArrow) {
      setSelectedIndex((i) => (i - 1 + PROVIDER_LIST.length) % PROVIDER_LIST.length)
    } else if (key.downArrow) {
      setSelectedIndex((i) => (i + 1) % PROVIDER_LIST.length)
    } else if (key.return) {
      const provider = PROVIDER_LIST[selectedIndex]
      setSelectedProvider(provider)
      setInputValue('')
      setError('')
      setStep('input_key')
    }
  }

  function handleTextInput(input: string, key: { return?: boolean; backspace?: boolean; delete?: boolean }) {
    if (key.return) {
      submitCurrentStep()
      return
    }
    if (key.backspace || key.delete) {
      setInputValue((v) => v.slice(0, -1))
      return
    }
    if (input && !key.return) {
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

      if (selectedProvider?.needsBaseUrl) {
        setStep('input_base_url')
      } else {
        await finalizeSave(inputValue.trim(), '', '')
      }
    } else if (step === 'input_base_url') {
      if (!inputValue.trim()) {
        setError('Base URL 不能为空（如 https://api.moonshot.cn/v1）')
        return
      }
      setPendingBaseUrl(inputValue.trim())
      setInputValue('')
      setError('')
      setStep('input_model')
    } else if (step === 'input_model') {
      await finalizeSave(pendingKey, pendingBaseUrl, inputValue.trim())
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
                    {isSelected ? '▸ ' : '  '}
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
            获取地址: {selectedProvider.name === 'anthropic' ? 'console.anthropic.com' :
              selectedProvider.name === 'openai' ? 'platform.openai.com' :
              selectedProvider.name === 'deepseek' ? 'platform.deepseek.com' : '厂商控制台'}
          </Text>
        </Box>
      )}

      {step === 'input_base_url' && (
        <Box flexDirection="column" marginTop={1}>
          <Text>输入 API Base URL (OpenAI 兼容端点):</Text>
          <Box marginTop={1}>
            <Text color={theme.colors.primary}>{'> '}</Text>
            <Text>{inputValue}</Text>
            <Text color={theme.colors.primary}>▌</Text>
          </Box>
          <Text color={theme.colors.muted} dimColor>
            例: https://api.moonshot.cn/v1 · https://open.bigmodel.cn/api/paas/v4 · https://api.siliconflow.cn/v1
          </Text>
        </Box>
      )}

      {step === 'input_model' && (
        <Box flexDirection="column" marginTop={1}>
          <Text>输入默认模型名称 (可选,直接 Enter 跳过):</Text>
          <Box marginTop={1}>
            <Text color={theme.colors.primary}>{'> '}</Text>
            <Text>{inputValue}</Text>
            <Text color={theme.colors.primary}>▌</Text>
          </Box>
          <Text color={theme.colors.muted} dimColor>
            例: moonshot-v1-8k · glm-4 · deepseek-ai/DeepSeek-V3
          </Text>
        </Box>
      )}

      {step === 'done' && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.colors.success} bold>✓ 配置已保存到 .nexus/secrets.toml</Text>
          <Text color={theme.colors.muted}>
            Provider: {selectedProvider?.label} · Key: {maskApiKey(pendingKey)}
          </Text>
          <Box marginTop={1}>
            <Text color={theme.colors.muted}>按 Enter 继续...</Text>
          </Box>
        </Box>
      )}
    </Box>
  )
}

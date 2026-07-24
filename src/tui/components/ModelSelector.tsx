/**
 * 交互式模型选择器组件
 * 由 /model（无参数）斜杠命令触发
 *
 * 交互流程:
 *   1. 选择模型（↑↓ 循环导航）
 *      - 所有模型均由用户添加（无内置预设），Enter 切换；按 d 删除
 *      - 列表为空时仅显示"➕ 添加新模型"
 *      - 末尾"➕ 添加新模型" → 进入分步输入
 *   2. 添加新模型分步：
 *      兼容性(openai/anthropic) → Base URL → 模型名称 → API Key（密码遮蔽）
 *      全部保存到 secrets.providers 下的命名键，并切换到新模型
 */

import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { theme } from '../theme'
import type { SecretsConfig, CustomModelEntry } from '../../config-secrets'
import {
  getCustomModelEntries,
  maskApiKey,
} from '../../config-secrets'

type SelectorStep =
  | 'select_model'
  | 'select_compatibility'
  | 'input_base_url'
  | 'input_model_name'
  | 'input_api_key'
  | 'confirm_delete'
  | 'done'

type Compatibility = 'openai' | 'anthropic'

interface ModelSelectorProps {
  secrets: SecretsConfig
  /** 当前正在使用的模型名（用于标注 ← 当前） */
  currentModel: string
  /** 选中某个已配置模型后立即切换 */
  onSelectModel: (modelName: string) => void
  /** 添加新模型完成后的保存与切换（selectModel 为新模型名） */
  onSaveSecrets: (newSecrets: SecretsConfig, selectModel: string) => Promise<void>
  /** 删除自定义条目后的保存与 reinit（若删的是当前模型，reinit 会自动回退 auto） */
  onDeleteSecrets: (newSecrets: SecretsConfig) => Promise<void>
  onClose: () => void
}

const COMPATIBILITY_OPTIONS: Array<{ value: Compatibility; label: string; hint: string }> = [
  { value: 'openai', label: 'OpenAI 兼容', hint: 'gpt-4o / deepseek-chat / 多数第三方端点' },
  { value: 'anthropic', label: 'Anthropic 兼容', hint: 'claude-sonnet-4 / Anthropic 代理端点' },
]

interface CustomEntry {
  type: 'custom'
  entry: CustomModelEntry
  current: boolean
}

interface AddNewEntry {
  type: 'add_new'
}

type ListEntry = CustomEntry | AddNewEntry

/** 生成不冲突的自定义条目键名 */
function generateCustomKey(compatibility: Compatibility, secrets: SecretsConfig): string {
  const prefix = `custom-${compatibility}`
  let idx = 1
  while (secrets.providers[`${prefix}-${idx}`]) idx++
  return `${prefix}-${idx}`
}

export function ModelSelector({
  secrets,
  currentModel,
  onSelectModel,
  onSaveSecrets,
  onDeleteSecrets,
  onClose,
}: ModelSelectorProps) {
  const [step, setStep] = useState<SelectorStep>('select_model')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [inputValue, setInputValue] = useState('')
  const [compatIndex, setCompatIndex] = useState(0)
  const [pendingCompat, setPendingCompat] = useState<Compatibility>('openai')
  const [pendingBaseUrl, setPendingBaseUrl] = useState('')
  const [pendingModel, setPendingModel] = useState('')
  const [pendingKey, setPendingKey] = useState('')
  const [pendingDelete, setPendingDelete] = useState<CustomModelEntry | null>(null)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  // 构建选项列表：所有用户添加的自定义条目 + "➕ 添加新模型"
  const customEntries = getCustomModelEntries(secrets)
  const entries: ListEntry[] = [
    ...customEntries.map((entry): CustomEntry => ({
      type: 'custom',
      entry,
      current: !!entry.defaultModel && entry.defaultModel === currentModel,
    })),
    { type: 'add_new' },
  ]

  // ─── useInput: 在所有条件分支之前调用，遵守 React Hooks 规则 ───────────────
  useInput((input, key) => {
    if (key.escape) {
      if (step === 'select_model') {
        onClose()
        return
      }
      // 子步骤 Esc 返回上级
      if (step === 'confirm_delete') {
        setPendingDelete(null)
        setError('')
        setStep('select_model')
        return
      }
      setError('')
      setInputValue('')
      setStep('select_model')
      return
    }

    switch (step) {
      case 'select_model':
        handleSelectModel(input, key)
        break
      case 'select_compatibility':
        handleSelectCompatibility(input, key)
        break
      case 'input_base_url':
      case 'input_model_name':
      case 'input_api_key':
        handleTextInput(input, key)
        break
      case 'confirm_delete':
        handleConfirmDelete(input, key)
        break
      case 'done':
        if (key.return) onClose()
        break
    }
  })

  function handleSelectModel(
    input: string,
    key: { upArrow?: boolean; downArrow?: boolean; return?: boolean },
  ) {
    if (key.upArrow) {
      setSelectedIndex((i) => (i - 1 + entries.length) % entries.length)
    } else if (key.downArrow) {
      setSelectedIndex((i) => (i + 1) % entries.length)
    } else if (key.return) {
      const entry = entries[selectedIndex]
      if (!entry) return
      if (entry.type === 'add_new') {
        setInputValue('')
        setError('')
        setPendingBaseUrl('')
        setPendingModel('')
        setPendingKey('')
        setCompatIndex(0)
        setStep('select_compatibility')
      } else {
        // 自定义条目（所有模型均由用户添加）
        if (!entry.entry.defaultModel) {
          setError('该条目未配置模型名')
          return
        }
        setError('')
        onSelectModel(entry.entry.defaultModel)
      }
    } else if (input === 'd' || input === 'D') {
      // 删除当前选中的自定义条目
      const entry = entries[selectedIndex]
      if (entry && entry.type === 'custom') {
        setPendingDelete(entry.entry)
        setError('')
        setStep('confirm_delete')
      }
    }
  }

  function handleSelectCompatibility(
    input: string,
    key: { upArrow?: boolean; downArrow?: boolean; return?: boolean },
  ) {
    if (key.upArrow) {
      setCompatIndex((i) => (i - 1 + COMPATIBILITY_OPTIONS.length) % COMPATIBILITY_OPTIONS.length)
    } else if (key.downArrow) {
      setCompatIndex((i) => (i + 1) % COMPATIBILITY_OPTIONS.length)
    } else if (key.return) {
      setPendingCompat(COMPATIBILITY_OPTIONS[compatIndex].value)
      setInputValue('')
      setError('')
      setStep('input_base_url')
    }
  }

  function handleTextInput(
    input: string,
    key: { return?: boolean; backspace?: boolean; delete?: boolean; ctrl?: boolean; meta?: boolean },
  ) {
    if (key.ctrl || key.meta) return

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

  function handleConfirmDelete(
    input: string,
    key: { return?: boolean },
  ) {
    if (key.return || input === 'y' || input === 'Y') {
      confirmDelete()
    } else if (input === 'n' || input === 'N') {
      setPendingDelete(null)
      setError('')
      setStep('select_model')
    }
  }

  async function submitCurrentStep() {
    if (step === 'input_base_url') {
      const baseUrl = inputValue.trim()
      if (!baseUrl) {
        setError('Base URL 不能为空（自定义 Provider 必须指定端点）')
        return
      }
      setPendingBaseUrl(baseUrl)
      setInputValue('')
      setError('')
      setStep('input_model_name')
    } else if (step === 'input_model_name') {
      const model = inputValue.trim()
      if (!model) {
        setError('模型名称不能为空（自定义 Provider 必须指定模型）')
        return
      }
      setPendingModel(model)
      setInputValue('')
      setError('')
      setStep('input_api_key')
    } else if (step === 'input_api_key') {
      const apiKey = inputValue.trim()
      if (!apiKey) {
        setError('API Key 不能为空')
        return
      }
      setPendingKey(apiKey)
      setInputValue('')
      setError('')
      await finalizeSave(pendingCompat, pendingBaseUrl, pendingModel, apiKey)
    }
  }

  async function finalizeSave(
    compatibility: Compatibility,
    baseUrl: string,
    model: string,
    apiKey: string,
  ) {
    const key = generateCustomKey(compatibility, secrets)
    const newSecrets: SecretsConfig = {
      ...secrets,
      providers: {
        ...secrets.providers,
        [key]: {
          apiKey,
          baseUrl,
          defaultModel: model,
          compatibility,
        },
      },
      defaultProvider: key,
      defaultModel: model,
    }

    try {
      await onSaveSecrets(newSecrets, model)
      setSaved(true)
      setStep('done')
    } catch (err) {
      setError(`保存失败: ${err instanceof Error ? err.message : String(err)}`)
      setStep('input_base_url')
      setInputValue('')
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return
    const key = pendingDelete.key
    const newProviders = { ...secrets.providers }
    delete newProviders[key]
    const newSecrets: SecretsConfig = {
      ...secrets,
      providers: newProviders,
      // 若默认指向被删条目，清除默认
      ...(secrets.defaultProvider === key ? { defaultProvider: undefined } : {}),
      ...(secrets.defaultModel === pendingDelete.defaultModel ? { defaultModel: undefined } : {}),
    }
    try {
      await onDeleteSecrets(newSecrets)
      setPendingDelete(null)
      setError('')
      setSaved(false)
      // 调整 selectedIndex 防越界
      setSelectedIndex((i) => Math.max(0, i - 1))
      setStep('select_model')
    } catch (err) {
      setError(`删除失败: ${err instanceof Error ? err.message : String(err)}`)
      setPendingDelete(null)
      setStep('select_model')
    }
  }

  // ─── 渲染 ─────────────────────────────────────────────────────────────────

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.colors.primary} paddingX={1}>
      <Box>
        <Text bold color={theme.colors.primary}>
          [AI] 模型选择
        </Text>
      </Box>

      {error ? (
        <Box marginTop={1}>
          <Text color={theme.colors.error}>✗ {error}</Text>
        </Box>
      ) : null}

      {step === 'select_model' && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.colors.muted}>
            ↑↓ 选择 · Enter 确认 · d 删除自定义 · Esc 关闭 · 当前: {currentModel}
          </Text>
          <Box flexDirection="column" marginTop={1}>
            {entries.map((entry, i) => {
              const isSelected = i === selectedIndex
              if (entry.type === 'add_new') {
                return (
                  <Box key="add_new">
                    <Text color={isSelected ? theme.colors.primary : undefined} bold={isSelected}>
                      {isSelected ? '▶ ' : '  '}
                    </Text>
                    <Text color={isSelected ? theme.colors.primary : theme.colors.accent}>
                      [+] 添加新模型
                    </Text>
                  </Box>
                )
              }
              // 自定义条目（所有模型均由用户添加）
              const e = entry.entry
              return (
                <Box key={e.key}>
                  <Text color={isSelected ? theme.colors.primary : undefined} bold={isSelected}>
                    {isSelected ? '▶ ' : '  '}
                  </Text>
                  <Text color={isSelected ? theme.colors.primary : undefined}>
                    {e.label}
                  </Text>
                  <Text color={theme.colors.muted}>
                    {' '}— {e.defaultModel || '(未设置)'} [{e.compatibility}]
                  </Text>
                  {entry.current ? (
                    <Text color={theme.colors.success}> ← 当前</Text>
                  ) : null}
                  <Text color={theme.colors.muted} dimColor> [DEL] 可删</Text>
                </Box>
              )
            })}
          </Box>
          <Box marginTop={1}>
            <Text color={theme.colors.muted} dimColor>
              选择已配置模型立即切换 · 选"添加新模型"配置 OpenAI/Anthropic 兼容端点
            </Text>
          </Box>
        </Box>
      )}

      {step === 'select_compatibility' && (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            步骤 1/4 — 选择 <Text bold>兼容模式</Text>:
          </Text>
          <Box flexDirection="column" marginTop={1}>
            {COMPATIBILITY_OPTIONS.map((opt, i) => {
              const isSelected = i === compatIndex
              return (
                <Box key={opt.value} flexDirection="column">
                  <Box>
                    <Text color={isSelected ? theme.colors.primary : undefined} bold={isSelected}>
                      {isSelected ? '▶ ' : '  '}
                    </Text>
                    <Text color={isSelected ? theme.colors.primary : undefined}>
                      {opt.label}
                    </Text>
                  </Box>
                  <Text color={theme.colors.muted} dimColor>
                    {'    '}{opt.hint}
                  </Text>
                </Box>
              )
            })}
          </Box>
          <Text color={theme.colors.muted} dimColor>
            ↑↓ 选择 · Enter 确认 · Esc 返回
          </Text>
        </Box>
      )}

      {step === 'input_base_url' && (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            步骤 2/4 — 输入 <Text bold>Base URL</Text>（{pendingCompat === 'anthropic' ? 'Anthropic' : 'OpenAI'} 兼容端点）:
          </Text>
          <Box marginTop={1}>
            <Text color={theme.colors.primary}>{'> '}</Text>
            <Text>{inputValue || ''}</Text>
            <Text color={theme.colors.primary}>▌</Text>
          </Box>
          <Text color={theme.colors.muted} dimColor>
            {pendingCompat === 'anthropic'
              ? '例如: https://api.anthropic.com · https://my-anthropic-proxy.com'
              : '例如: https://api.openai.com/v1 · https://api.deepseek.com'}
            {' · Esc 返回'}
          </Text>
        </Box>
      )}

      {step === 'input_model_name' && (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            步骤 3/4 — 输入 <Text bold>模型名称</Text>:
          </Text>
          <Box marginTop={1}>
            <Text color={theme.colors.primary}>{'> '}</Text>
            <Text>{inputValue || ''}</Text>
            <Text color={theme.colors.primary}>▌</Text>
          </Box>
          <Text color={theme.colors.muted} dimColor>
            {pendingCompat === 'anthropic'
              ? '例如: claude-sonnet-4-20250514 · claude-haiku-3-5'
              : '例如: gpt-4o · deepseek-chat · qwen-plus'}
            {' · Esc 返回'}
          </Text>
        </Box>
      )}

      {step === 'input_api_key' && (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            步骤 4/4 — 输入 <Text bold>API Key</Text>（密码模式遮蔽）:
          </Text>
          <Box marginTop={1}>
            <Text color={theme.colors.primary}>{'> '}</Text>
            <Text>{inputValue ? '•'.repeat(inputValue.length) : ''}</Text>
            <Text color={theme.colors.primary}>▌</Text>
          </Box>
          <Text color={theme.colors.muted} dimColor>
            支持粘贴长密钥，输入时显示 •••••• 遮蔽 · Esc 返回
          </Text>
        </Box>
      )}

      {step === 'confirm_delete' && pendingDelete && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.colors.warning}>
            [!] 确认删除自定义模型？
          </Text>
          <Box marginTop={1}>
            <Text>
              名称: <Text bold>{pendingDelete.label}</Text>
            </Text>
          </Box>
          <Text>
            模型: {pendingDelete.defaultModel || '(未设置)'} · 兼容: {pendingDelete.compatibility}
          </Text>
          {pendingDelete.defaultModel === currentModel ? (
            <Text color={theme.colors.muted}>
              注意：删除的是当前使用模型，将自动回退到 auto 选择
            </Text>
          ) : null}
          <Box marginTop={1}>
            <Text color={theme.colors.muted}>
              按 y/Enter 确认删除 · n/Esc 取消
            </Text>
          </Box>
        </Box>
      )}

      {step === 'done' && saved && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.colors.success} bold>✓ 配置已保存并切换到新模型</Text>
          <Text color={theme.colors.muted}>
            模型: {pendingModel} · 兼容: {pendingCompat} · Base URL: {pendingBaseUrl} · Key: {maskApiKey(pendingKey)}
          </Text>
          <Box marginTop={1}>
            <Text color={theme.colors.muted}>按 Enter 继续...</Text>
          </Box>
        </Box>
      )}
    </Box>
  )
}

/**
 * 快捷键/命令帮助浮层 — 纯展示，输入由 App.tsx useInput 统一处理（? 打开 / Esc 关闭）
 */
import { Box, Text } from 'ink'
import React from 'react'
import { theme } from '../theme'

/** 快捷键分组 */
const SHORTCUTS: Array<{ keys: string; desc: string }> = [
  { keys: 'Ctrl+C', desc: '中断当前操作（再按一次退出）' },
  { keys: 'Shift+Tab', desc: '轮换权限模式（询问→自动编辑→全自动→无限制）' },
  { keys: 'T', desc: '展开/折叠全部工具卡片' },
  { keys: 'Ctrl+R', desc: '搜索输入历史' },
  { keys: '↑ / ↓', desc: '历史回溯 / 补全选择' },
  { keys: 'Alt+Enter', desc: '输入框换行' },
  { keys: '!', desc: '快捷 shell 命令（!ls）' },
  { keys: '?', desc: '打开/关闭本帮助' },
]

/** 常用命令分组 */
const COMMANDS: Array<{ cmd: string; desc: string }> = [
  { cmd: '/model', desc: '切换模型' },
  { cmd: '/config', desc: 'API 配置' },
  { cmd: '/goal', desc: '目标驱动循环' },
  { cmd: '/loop', desc: '节拍循环' },
  { cmd: '/loops', desc: '本地 Automations' },
  { cmd: '/cost', desc: '会话花费' },
  { cmd: '/undo', desc: '回滚检查点' },
  { cmd: '/resume', desc: '恢复会话（交互式列表）' },
  { cmd: '/export', desc: '导出会话' },
  { cmd: '/memory', desc: '学习记忆' },
  { cmd: '/help', desc: '全部命令（分组）' },
]

export function HelpOverlay() {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.colors.warning}
      paddingX={2}
      paddingY={1}
      marginBottom={1}
    >
      <Box marginBottom={1}>
        <Text color={theme.colors.warning} bold>
          ⌨ 快捷键
        </Text>
      </Box>
      {SHORTCUTS.map((s) => (
        <Box key={s.keys}>
          <Text color={theme.colors.accent} bold>
            {s.keys.padEnd(12)}
          </Text>
          <Text color={theme.colors.fg}> {s.desc}</Text>
        </Box>
      ))}
      <Box marginTop={1} marginBottom={1}>
        <Text color={theme.colors.warning} bold>
          ⚡ 常用命令
        </Text>
      </Box>
      {COMMANDS.map((c) => (
        <Box key={c.cmd}>
          <Text color={theme.colors.primary} bold>
            {c.cmd.padEnd(10)}
          </Text>
          <Text color={theme.colors.fg}> {c.desc}</Text>
        </Box>
      ))}
      <Box marginTop={1}>
        <Text color={theme.colors.muted} dimColor italic>
          [Esc 或 ? 关闭]
        </Text>
      </Box>
    </Box>
  )
}

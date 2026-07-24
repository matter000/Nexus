/**
 * TUI 主题定义
 */

export const theme = {
  colors: {
    primary: 'cyan',
    secondary: 'green',
    accent: 'magenta',
    warning: 'yellow',
    error: 'red',
    muted: 'gray',
    success: 'green',
    border: 'gray',
    user: 'blue',
    assistant: 'cyan',
    tool: 'yellow',
  },
  symbols: {
    user: '◆',
    assistant: '◐',
    tool: '┌─',
    toolEnd: '└─',
    approval: '⚠️',
    success: '✓',
    error: '✗',
    pending: '○',
    inProgress: '▶',
    complete: '✓',
    spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  },
  labels: {
    read_file: '📄 read_file',
    edit_file: '✏️ edit_file',
    bash: '⚡ bash',
    grep: '🔍 grep',
  },
} as const

export type Theme = typeof theme

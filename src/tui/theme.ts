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
  /** Logo pixel art palette — spider blue */
  logo: {
    spider: '#0E76B0',  // spider blue — pure single color silhouette
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
    glob: '📂 glob',
    fetch_url: '🌐 fetch_url',
    search_symbol: '🔍 search_symbol',
    list_directory: '📁 list_directory',
    update_todo: '📋 update_todo',
    semantic_search: '🧠 semantic_search',
    dispatch_subagent: '🤖 dispatch_subagent',
  },
} as const

export type Theme = typeof theme

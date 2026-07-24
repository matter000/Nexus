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
  /** Logo pixel art palette — electric blue / neon cyan / dark navy */
  logo: {
    pin: '#4A90D9',    // steel blue — chip pins/legs
    body: '#0088FF',   // electric blue — chip body border
    trace: '#0066CC',  // medium blue — circuit traces
    glow: '#00FFFF',   // neon cyan — glowing "N" core
    node: '#00E5FF',   // bright cyan — endpoint glow nodes
    bg: '#0A0E1A',     // dark navy — background (not rendered, terminal bg)
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

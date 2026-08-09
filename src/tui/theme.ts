/**
 * TUI 主题定义
 *
 * 配色与 Nexus 终端样式设计稿对齐（深色终端方案）：
 *   seed-bg #0B0E14 · seed-surface #11151D · seed-fg #E6E9EF
 *   seed-primary #4DA3FF（品牌主色）· seed-accent #E8B04B（复古琥珀点缀）
 *   语义色：ok #3FB950 · warn #D29922 · danger #F47174
 */

export const theme = {
  colors: {
    /** 品牌主色（蜘蛛蓝） */
    primary: '#4DA3FF',
    /** 次级强调，与 success 一致 */
    secondary: '#3FB950',
    /** 复古琥珀点缀（少量使用） */
    accent: '#E8B04B',
    /** 警示（审批/等待） */
    warning: '#D29922',
    /** 危险/报错 */
    error: '#F47174',
    /** 次要文本（fg 56% 派生） */
    muted: '#878C98',
    /** 成功/完成 */
    success: '#3FB950',
    /** 弱边框 */
    border: '#3A4150',
    /** 强前景文本 */
    fg: '#E6E9EF',
    /** 用户消息 */
    user: '#E6E9EF',
    /** assistant（品牌蓝） */
    assistant: '#4DA3FF',
    /** 工具名 */
    tool: '#E6E9EF',
  },
  /** Logo pixel art palette — node graph mark */
  logo: {
    mark: '#4DA3FF', // brand primary — pure single color silhouette
  },
  /** 面背景（输入框等容器内衬，对应设计稿 seed-surface） */
  surfaces: {
    field: '#11151D',
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
    lsp: '🧭 lsp',
    list_directory: '📁 list_directory',
    update_todo: '📋 update_todo',
    update_notes: '📝 update_notes',
    semantic_search: '🧠 semantic_search',
    dispatch_subagent: '🤖 dispatch_subagent',
    dispatch_agent: '🤖 dispatch_agent',
    dispatch_subagents: '🤖 dispatch_subagents',
    dispatch_agents: '🤖 dispatch_agents',
    run_pipeline: '🔗 run_pipeline',
    team_task_list: '📌 team_task_list',
    team_task_claim: '📌 team_task_claim',
    send_message: '✉️ send_message',
    read_messages: '✉️ read_messages',
    create_file: '✨ create_file',
    web_search: '🌐 web_search',
    git_status: '🌱 git_status',
    git_commit: '🌱 git_commit',
    git_push: '🌱 git_push',
    git_merge: '🌱 git_merge',
    submit_plan: '🗺️ submit_plan',
    load_skill: '🎯 load_skill',
  },
} as const

export type Theme = typeof theme

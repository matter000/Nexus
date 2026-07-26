/**
 * 危险命令检测
 * 正则黑名单 + 启发式规则,命中则强制审批(即便 yolo 模式)
 */

export interface DangerAssessment {
  dangerous: boolean
  reason: string
  level: 'safe' | 'caution' | 'dangerous'
}

/** 危险命令模式列表 */
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // 文件系统破坏
  { pattern: /rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/(\s|$)/, reason: '删除根目录' },
  { pattern: /rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?~\/?(\s|$)/, reason: '删除用户主目录' },
  { pattern: /rm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+\//, reason: '递归强制删除根路径' },
  { pattern: /rm\s+-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*\s+\//, reason: '递归强制删除根路径' },

  // 磁盘/分区操作
  { pattern: /\bdd\b.*of=\/dev\//, reason: '直接写入块设备' },
  { pattern: /\bmkfs\b/, reason: '格式化文件系统' },
  { pattern: /\bshred\b/, reason: '安全擦除文件(不可恢复)' },
  { pattern: /\bfdisk\b/, reason: '磁盘分区操作' },

  // Fork 炸弹
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: 'Fork 炸弹' },
  { pattern: /\bfork\s*bomb/i, reason: '可能的 Fork 炸弹' },

  // 管道执行(远程代码执行)
  { pattern: /curl\s+.*\|\s*(bash|sh|zsh)/, reason: '从网络下载并直接执行脚本' },
  { pattern: /wget\s+.*\|\s*(bash|sh|zsh)/, reason: '从网络下载并直接执行脚本' },
  { pattern: /curl\s+.*\|\s*sudo\s+(bash|sh)/, reason: '从网络下载并以 root 执行' },

  // 权限提升
  { pattern: /sudo\s+rm\s+-[a-zA-Z]*r/, reason: '以 root 递归删除' },
  { pattern: /chmod\s+(-R\s+)?777\s+\//, reason: '对根目录设置全开权限' },

  // 系统关键文件
  { pattern: />\s*\/etc\/(passwd|shadow|fstab)/, reason: '覆写系统关键文件' },
  { pattern: />\s*\/boot\//, reason: '覆写引导分区' },

  // Windows 危险操作
  { pattern: /format\s+[a-zA-Z]:/i, reason: '格式化磁盘分区' },
  { pattern: /del\s+\/[sfq]+\s+[a-zA-Z]:\\/i, reason: '递归删除整个驱动器' },
  { pattern: /Remove-Item\s+.*-Recurse.*-Force.*[a-zA-Z]:\\/i, reason: 'PowerShell 递归强制删除' },
  { pattern: /rd\s+\/s\s+\/q\s+[a-zA-Z]:\\/i, reason: '递归删除整个驱动器' },

  // Git 破坏性操作
  { pattern: /git\s+push\s+.*--force.*\s+(main|master)/, reason: '强制推送到主分支' },
  { pattern: /git\s+reset\s+--hard/, reason: 'Git 硬重置(丢失未提交更改)' },

  // 环境变量/密钥泄露
  { pattern: /echo\s+.*\$(API_KEY|SECRET|TOKEN|PASSWORD)/i, reason: '可能泄露敏感环境变量' },
]

/** 需要额外注意但不一定危险的命令 */
const CAUTION_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /rm\s+-/, reason: '删除操作' },
  { pattern: /git\s+push/, reason: 'Git 推送' },
  { pattern: /npm\s+publish/, reason: '发布 npm 包' },
  { pattern: /docker\s+rm/, reason: '删除 Docker 容器' },
  { pattern: /kill\s+-9/, reason: '强制杀进程' },
  { pattern: />\s*\//, reason: '覆写绝对路径文件' },
]

/**
 * 去除 shell 命令中的引号，还原实际执行的命令字符串。
 * 处理：单引号（保留内容去引号）、双引号（处理内嵌转义）、空引号拼接。
 * 目的是让黑名单正则匹配到被引号拆分的危险命令（如 r""m -rf / → rm -rf /）。
 */
export function resolveQuotes(command: string): string {
  // 1. 处理反斜杠续行
  let result = command.replace(/\\\n/g, '')

  // 2. 处理双引号：保留内容，将 \" 还原为 "
  //    双引号内支持转义字符，如 "file\"name" → file"name
  result = result.replace(/"((?:[^"\\]|\\.)*)"/g, (_m, inner: string) =>
    inner.replace(/\\"/g, '"'),
  )

  // 3. 处理单引号：保留内容去引号（内部不处理转义）
  result = result.replace(/'[^']*'/g, (m) => m.slice(1, -1))

  // 4. 去除连续空引号（连接字面量如 r""m → rm，c""url → curl）
  result = result.replace(/""/g, '').replace(/''/g, '')

  return result
}

/**
 * 检测命令是否危险
 * 返回危险等级和原因
 */
export function isDangerousCommand(command: string): DangerAssessment {
  // 先解析引号，再对解析后的命令做模式匹配
  const normalized = resolveQuotes(command).trim()

  // 检查危险模式
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(normalized)) {
      return { dangerous: true, reason, level: 'dangerous' }
    }
  }

  // 检查 caution 模式
  for (const { pattern, reason } of CAUTION_PATTERNS) {
    if (pattern.test(normalized)) {
      return { dangerous: false, reason, level: 'caution' }
    }
  }

  return { dangerous: false, reason: '', level: 'safe' }
}

/**
 * 判断命令是否需要强制审批(无论权限模式)
 * 只有 level === 'dangerous' 的命令才强制审批
 */
export function requiresForcedApproval(command: string): boolean {
  return isDangerousCommand(command).level === 'dangerous'
}

/**
 * Harness Engine — 评估任务类型定义
 */

/** 任务类别 */
export type TaskCategory =
  | 'single-file'
  | 'multi-file'
  | 'bug-fix'
  | 'add-test'
  | 'refactor'
  | 'create-file'

/** 任务难度 */
export type TaskDifficulty = 'easy' | 'medium' | 'hard'

/** 验证规则 */
export type ValidateRule =
  | { type: 'file_exists'; path: string }
  | { type: 'file_not_exists'; path: string }
  | { type: 'file_contains'; path: string; pattern: string }
  | { type: 'file_not_contains'; path: string; pattern: string }
  | { type: 'bash_pass'; command: string }
  | { type: 'bash_output_contains'; command: string; pattern: string }
  /** diff 干净度：工作目录内不得出现 allowed 列表之外的文件（防 agent 改动任务范围外内容） */
  | { type: 'no_extra_files'; allowed: string[] }

/** 初始文件定义 */
export interface InitialFile {
  path: string
  content: string
}

/** 评估任务定义 */
export interface EvalTask {
  id: string
  name: string
  category: TaskCategory
  difficulty: TaskDifficulty
  description: string
  initialFiles: InitialFile[]
  userRequest: string
  validate: ValidateRule[]
}

/** 单个任务的执行结果 */
export interface EvalResult {
  taskId: string
  taskName: string
  category: TaskCategory
  difficulty: TaskDifficulty
  pass: boolean
  /** 验证失败时的原因说明 */
  reason?: string
  /** 通过/失败的规则数 */
  rulesPassed: number
  rulesTotal: number
  /** 执行耗时（ms） */
  durationMs: number
  /** 执行成本（USD） */
  cost: number
  /** agent 消耗的迭代步数（LLM 调用轮次，runner 未上报时为 undefined） */
  steps?: number
  /** 峰值上下文利用率（prompt token / 窗口，0~1；runner 未上报时为 undefined） */
  peakContextUtilization?: number
  /** diff 干净度违规：任务含 no_extra_files 规则且未通过（改了任务范围外的文件） */
  extraFilesViolation?: boolean
  /** agent 的返回文本 */
  output?: string
}

/** 评估报告 */
export interface EvalReport {
  mode: 'mock' | 'real'
  tasksTotal: number
  tasksPassed: number
  tasksFailed: number
  totalCost: number
  totalDurationMs: number
  /** 平均迭代步数（仅统计上报了 steps 的任务；无上报时为 undefined） */
  avgSteps?: number
  /** 平均峰值上下文利用率（仅统计上报了的任务；无上报时为 undefined） */
  avgPeakUtilization?: number
  /** diff 干净度违规任务数（改了任务范围外文件，防"改对但绕路"） */
  extraFilesViolations: number
  results: EvalResult[]
  timestamp: number
}

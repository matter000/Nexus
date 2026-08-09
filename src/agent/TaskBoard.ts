/**
 * TaskBoard - 共享任务板（Agent Teams 风格协作）
 *
 * 会话级内存任务板：主 Agent 批准计划后把 todos 灌入，子 Agent 可通过
 * team_task_list/team_task_claim 工具查看全局与认领任务，实现"围绕共享
 * 任务列表协作"（Claude Code Agent Teams 三件套之一）。
 *
 * 单进程事件循环内同步操作天然原子（claim 不会出现双重认领）。
 */

export type BoardTaskStatus = 'pending' | 'claimed' | 'done'

export interface BoardTask {
  id: string
  content: string
  status: BoardTaskStatus
  /** 认领者 agentId（主 Agent 为 'lead'） */
  claimedBy?: string
  /** 完成时的结果摘要 */
  result?: string
}

export class TaskBoard {
  private tasks: BoardTask[] = []

  /** 从 todos 灌入任务板（重复 id 覆盖状态，保留已认领信息） */
  syncFromTodos(todos: Array<{ id: string; content: string; status: string }>): void {
    for (const todo of todos) {
      const existing = this.tasks.find((t) => t.id === todo.id)
      const status: BoardTaskStatus =
        todo.status === 'complete' ? 'done' : todo.status === 'in_progress' ? 'claimed' : 'pending'
      if (existing) {
        existing.content = todo.content
        // 已认领/完成的状态不被 todo 同步降级（todo 的 in_progress 可能是编排自动标记）
        if (existing.status === 'pending') existing.status = status
      } else {
        this.tasks.push({ id: todo.id, content: todo.content, status })
      }
    }
  }

  /** 追加单条任务（update_todo add 同步用） */
  add(id: string, content: string): void {
    if (this.tasks.some((t) => t.id === id)) return
    this.tasks.push({ id, content, status: 'pending' })
  }

  /** 更新任务内容（update_todo update 同步用） */
  updateContent(id: string, content: string): void {
    const task = this.tasks.find((t) => t.id === id)
    if (task) task.content = content
  }

  /** 移除任务（update_todo cancelled 同步用） */
  remove(id: string): void {
    this.tasks = this.tasks.filter((t) => t.id !== id)
  }

  /**
   * 原子认领一条 pending 任务：指定 id 时认领该条，缺省时认领第一条 pending。
   * 成功返回任务，失败（已被他人认领/不存在）返回 null。
   */
  claim(agentId: string, taskId?: string): BoardTask | null {
    const task = taskId
      ? this.tasks.find((t) => t.id === taskId)
      : this.tasks.find((t) => t.status === 'pending')
    if (!task || task.status !== 'pending') return null
    task.status = 'claimed'
    task.claimedBy = agentId
    return task
  }

  /** 标记任务完成（仅认领者可完成；缺省 result 为空） */
  complete(taskId: string, agentId: string, result?: string): boolean {
    const task = this.tasks.find((t) => t.id === taskId)
    if (!task || task.status !== 'claimed' || task.claimedBy !== agentId) return false
    task.status = 'done'
    task.result = result
    return true
  }

  /** 列出全部任务（team_task_list 用） */
  list(): BoardTask[] {
    return this.tasks.map((t) => ({ ...t }))
  }

  /** 格式化为可读文本（注入上下文/工具返回） */
  format(): string {
    if (this.tasks.length === 0) return '(任务板为空)'
    return this.tasks
      .map((t) => {
        const icon = t.status === 'done' ? '✓' : t.status === 'claimed' ? '▶' : '○'
        const claimNote = t.claimedBy ? ` [认领: ${t.claimedBy}]` : ''
        return `${icon} #${t.id} ${t.content}${claimNote}`
      })
      .join('\n')
  }

  clear(): void {
    this.tasks = []
  }
}

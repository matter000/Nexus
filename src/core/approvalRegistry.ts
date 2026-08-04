/**
 * 审批 resolver 注册表
 * 管理工具审批与计划审批的 resolve 函数，按 callId 索引，支持并发审批。
 * 独立成模块以避免入口（index.ts）与 TUI 组件之间的循环依赖，
 * 替代此前基于 globalThis 单槽 + 模块级变量的方案。
 */

/** 工具审批结果：true 批准 / false 拒绝 */
export type ToolApprovalResolve = (approved: boolean) => void

/** 计划审批结果：'approve' | 'reject' | 反馈文本 */
export type PlanApprovalResult = 'approve' | 'reject' | string
export type PlanApprovalResolve = (result: PlanApprovalResult) => void

const toolApprovalResolvers = new Map<string, ToolApprovalResolve>()
const planApprovalResolvers = new Map<string, PlanApprovalResolve>()

let approvalCounter = 0

/** 生成唯一 callId */
export function nextApprovalCallId(): string {
  return `approval-${Date.now()}-${++approvalCounter}`
}

/** 注册工具审批 resolver（由 requestApproval 在创建 Promise 时调用） */
export function registerToolApproval(callId: string, resolve: ToolApprovalResolve): void {
  toolApprovalResolvers.set(callId, resolve)
}

/** 注册计划审批 resolver（由 requestPlanApproval 在创建 Promise 时调用） */
export function registerPlanApproval(callId: string, resolve: PlanApprovalResolve): void {
  planApprovalResolvers.set(callId, resolve)
}

/** 通过 callId 获取并移除工具审批 resolver（TUI 响应审批时调用） */
export function takeToolApprovalResolve(callId: string): ToolApprovalResolve | null {
  const r = toolApprovalResolvers.get(callId) ?? null
  if (r) toolApprovalResolvers.delete(callId)
  return r
}

/** 通过 callId 获取并移除计划审批 resolver（TUI 响应审批时调用） */
export function takePlanApprovalResolve(callId: string): PlanApprovalResolve | null {
  const r = planApprovalResolvers.get(callId) ?? null
  if (r) planApprovalResolvers.delete(callId)
  return r
}

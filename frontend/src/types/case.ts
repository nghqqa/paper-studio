/** 项目状态与列表视角基础类型（与 backend/app/domain/cases.py 对应） */

import type { Role } from '@/lib/types'

export type CaseStatus =
  | 'intake'
  | 'drafting'
  | 'review'
  | 'client_review'
  | 'final'
  | 'filed'
  | 'oa'
  | 'granted'
  | 'rejected'
  | 'closed'

/** 当前用户视角的列表状态：归档 / 回收站属于个人列表视角 */
export type ListState = 'active' | 'archived' | 'trashed'

export const CASE_STATUSES: readonly CaseStatus[] = [
  'intake',
  'drafting',
  'review',
  'client_review',
  'final',
  'filed',
  'oa',
  'granted',
  'rejected',
  'closed',
]

export const STATUS_LABEL: Record<CaseStatus, string> = {
  intake: '接案',
  drafting: '撰写',
  review: '内审',
  client_review: '外部审阅',
  final: '定稿',
  filed: '已提交',
  oa: '返修中',
  granted: '已录用',
  rejected: '未通过',
  closed: '已归档',
}

/** 状态徽章语义档 */
export const STATUS_TONE: Record<CaseStatus, 'neutral' | 'info' | 'warning' | 'primary' | 'destructive'> = {
  intake: 'neutral',
  drafting: 'info',
  review: 'warning',
  client_review: 'warning',
  final: 'primary',
  filed: 'primary',
  oa: 'destructive',
  granted: 'primary',
  rejected: 'destructive',
  closed: 'neutral',
}

export interface CaseSummary {
  version: number
  case_no: string
  status: CaseStatus
  owner_user_id: string | null
  archived: boolean
}

/** 头像 / 姓名展示所需的最少用户字段（GET /api/projects 每行 owner） */
export interface UserBrief {
  user_id: string
  email: string
  display_name: string
  avatar_color?: string
}

/** GET /api/projects 行内协作者 */
export interface Collaborator extends UserBrief {
  role: Role
  online: boolean
  last_seen: string | null
}

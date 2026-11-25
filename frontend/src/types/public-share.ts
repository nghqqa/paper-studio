import type { CaseStatus } from './case'
import type { Comment, CommentAnchor } from '@/lib/types'

/** 外部公开审阅 API 契约（与 backend/app/schemas.py 逐字段对应） */

export type PublicShareScope = 'read' | 'comment' | 'confirm'

export interface PublicShareLink {
  token: string
  pid: string
  scope: PublicShareScope
  baseline?: string
  /** 允许下载（缺省 false） */
  allow_download: boolean
  expires_at: number | null
  revoked: boolean
  created_by: { id: string; display_name: string }
  created_at: number
  /** 访问记录条数 */
  visits: number
  last_visit_at: number | null
}

export interface PublicShareLinkIn {
  scope: PublicShareScope
  ttl_days: number | null
  allow_download?: boolean
}

/** `GET /api/public/{token}/meta` */
export interface PublicShareMeta {
  org_name: string
  title: string
  case_no: string | null
  status: CaseStatus
  version: number
  sha: string
  scope: PublicShareScope
  baseline?: string
  pending_revisions?: number
  sub_except?: string[]
  allow_download: boolean
  /** 协作者设置：禁复制 ⇒ 审阅页拦截 copy；禁批注 ⇒ 无「有意见」入口 */
  allow_copy: boolean
  allow_comment: boolean
  expires_at: number | null
  /** 已有确认（最新一条） */
  confirmation: Confirmation | null
  pdf_ready: boolean
  source_format?: 'markdown' | 'structured' | 'latex' | 'docx'
  document_type?: 'patent' | 'paper'
  layout_supported?: boolean
}

export interface Confirmation {
  version: number
  sha: string
  name: string
  note: string | null
  confirmed_at: number
}

export interface PublicCommentIn {
  anchor: CommentAnchor
  body: string
  /** 访客姓名（localStorage 记一次） */
  guest_name: string
}

export interface PublicConfirmIn {
  name: string
  note?: string
}

/** 与后端 schemas 公开端点字段上限一致 */
export const PUBLIC_COMMENT_BODY_MAX = 4000
export const PUBLIC_CONFIRM_NOTE_MAX = 2000
export const GUEST_NAME_MAX = 64

export type PublicComment = Comment & { guest?: boolean }

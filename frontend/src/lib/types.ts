import type { Collaborator, ListState, UserBrief } from '@/types/case'

/** Paper-only submission metadata. */
export interface PaperSubmission {
  venue?: string
  field?: string
  rank?: string
  deadline?: string
  stage?: string
  keywords?: string
}

export interface ProjectSummary {
  id: string
  title: string
  submission?: PaperSubmission
  source_format?: 'markdown' | 'latex' | 'structured' | 'docx'
  /** 最后修改时间（Unix 秒） */
  mtime: number
  /** 负责人账号；无 owner / auth=off / 账号已删 ⇒ null */
  owner?: UserBrief | null
  /** ACL 成员（列表头像）；auth=off ⇒ [] */
  collaborators?: Collaborator[]
  /** 最近一次提交的作者；无历史 ⇒ null */
  last_modified_by?: string | null
  /** 当前用户在本项目的角色；off ⇒ null */
  my_role?: Role | null
  /** 当前用户视角：进行中 / 已归档 / 回收站 */
  list_state?: ListState
}

export interface Settings {
  ai_enabled?: boolean
  source_format?: 'markdown' | 'latex' | 'structured' | 'docx'
  latex?: { main: string; engine: string; title?: string }
  document_type?: 'patent' | 'paper'
  title?: string
  submission?: PaperSubmission
  blind_terms?: string[]
  citation_style?: string
}

export interface ProjectDetail extends ProjectSummary {
  /** AUTH=on 时当前用户在本项目的角色（superuser ⇒ owner）；off ⇒ null */
  role?: Role | null
  figs?: string[]
  settings: Settings
  has_settings_file?: boolean
  content?: string
}

/** 成员角色：owner > agent > editor > reviewer（只能提批注） > viewer */
export type Role = 'owner' | 'agent' | 'editor' | 'reviewer' | 'viewer'
export const ROLE_RANK: Record<Role, number> = { viewer: 0, reviewer: 1, editor: 2, agent: 3, owner: 4 }
export const ROLE_LABEL: Record<Role, string> = { owner: '所有者', agent: '负责人', editor: '编辑者', reviewer: '审阅者', viewer: '查看者' }

export interface User {
  id: string
  email: string
  display_name: string
  is_superuser: boolean
  /** 展示用头衔 */
  title?: string
  /** 头像色名（'' = 未选，按名字派生） */
  avatar_color?: string
}

export interface Member {
  user_id: string
  email: string
  display_name: string
  avatar_color?: string
  role: Role
}

export interface ShareAccept {
  user_id: string
  email: string
  display_name: string
  avatar_color?: string
  accepted_at: string
}

export interface ShareLink {
  token: string
  role: Exclude<Role, 'owner'>
  /** ISO 时间；null = 永久 */
  expires_at: string | null
  /** `<origin>/#/share/<token>` */
  url: string
  created_at: string
  accepted_by: ShareAccept[]
}

/** 与后端 comments.CommentIn/ReplyIn.body max_length=4000 一致 */
export const COMMENT_BODY_MAX = 4000

export interface CommentAnchor {
  block_id: string
  line: number
  quote: string
  stale?: boolean
  line_start?: number
  line_end?: number
  file?: string
}

export interface CommentAuthor {
  id: string | null
  name: string
}

export interface CommentReply {
  id: string
  body: string
  author: CommentAuthor
  created_at: number
}

export interface Comment {
  id: string
  anchor: CommentAnchor
  body: string
  author: CommentAuthor
  created_at: number
  updated_at: number
  resolved: boolean
  replies: CommentReply[]
  source?: 'human' | 'ai' | 'client'
}

export interface Health {
  ok: boolean
  soffice?: boolean
  soffice_bin?: string
  projects_dir?: string
  unoserver?: boolean
  unoserver_url?: string
  pdf_backend?: 'unoserver' | 'cli' | null
}

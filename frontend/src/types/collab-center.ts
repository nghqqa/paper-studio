import type { Member, Role } from '@/lib/types'

/** 协作者中心 API 契约 */

export type AccessUser = Omit<Member, 'role'> & { role: Role | null }

/** GET /projects/{pid}/access → viewed[] */
export interface AccessRow {
  user: AccessUser
  first_seen: string
  last_seen: string
  count: number
  online: boolean
}

/** GET /projects/{pid}/access → not_viewed[]：有资格却没打开过的人 */
export interface NotViewedRow {
  user: AccessUser | null
  email: string
  via: 'member' | 'link' | 'invite'
}

export interface AccessReport {
  viewed: AccessRow[]
  not_viewed: NotViewedRow[]
}

/** pending_invites 行 */
export interface Invite {
  email: string
  role: Exclude<Role, 'owner'>
  invited_by: string
  created_at: string
}

/** GET/PUT /projects/{pid}/collab-settings */
export interface CollabSettings {
  allow_download: boolean
  allow_copy: boolean
  allow_comment: boolean
}

export const DEFAULT_COLLAB_SETTINGS: CollabSettings = { allow_download: true, allow_copy: true, allow_comment: true }

export type CollabCenterTab = 'members' | 'links' | 'access' | 'settings'
export const COLLAB_CENTER_TABS: { id: CollabCenterTab; label: string }[] = [
  { id: 'members', label: '协作者' },
  { id: 'links', label: '链接' },
  { id: 'access', label: '访问记录' },
  { id: 'settings', label: '设置' },
]

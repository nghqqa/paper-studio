import { P, req } from './net'
import type { Member, Role, ShareLink } from '../types'
import type { AccessReport, CollabSettings, Invite } from '@/types/collab-center'

export const collabApi = {
  members: (id: string) => req<Member[]>(`${P(id)}/members`),
  setMember: (id: string, email: string, role: Role) =>
    req<Member[]>(`${P(id)}/members`, { method: 'PUT', body: JSON.stringify({ email, role }) }),
  removeMember: (id: string, userId: string) =>
    req<Member[]>(`${P(id)}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' }),
  shareLinks: (id: string) => req<ShareLink[]>(`${P(id)}/share`),
  createShareLink: (id: string, role: Exclude<Role, 'owner'>, expires_in_days: number | null) =>
    req<ShareLink>(`${P(id)}/share`, { method: 'POST', body: JSON.stringify({ role, expires_in_days }) }),
  revokeShareLink: (id: string, token: string) =>
    req<ShareLink[]>(`${P(id)}/share/${encodeURIComponent(token)}`, { method: 'DELETE' }),
  setMemberRole: (id: string, userId: string, role: Role) =>
    req<Member[]>(`${P(id)}/members/${encodeURIComponent(userId)}`, { method: 'PUT', body: JSON.stringify({ role }) }),
  access: (id: string) => req<AccessReport>(`${P(id)}/access`),
  collabSettings: (id: string) => req<CollabSettings>(`${P(id)}/collab-settings`),
  saveCollabSettings: (id: string, patch: Partial<CollabSettings>) =>
    req<CollabSettings>(`${P(id)}/collab-settings`, { method: 'PUT', body: JSON.stringify(patch) }),
  invites: (id: string) => req<Invite[]>(`${P(id)}/invites`),
  invite: (id: string, email: string, role: Exclude<Role, 'owner'>) =>
    req<Invite | { member: Member }>(`${P(id)}/invites`, { method: 'POST', body: JSON.stringify({ email, role }) }),
  setInviteRole: (id: string, email: string, role: Exclude<Role, 'owner'>) =>
    req<Invite>(`${P(id)}/invites/${encodeURIComponent(email)}`, { method: 'PUT', body: JSON.stringify({ role }) }),
  revokeInvite: (id: string, email: string) =>
    req<Invite[]>(`${P(id)}/invites/${encodeURIComponent(email)}`, { method: 'DELETE' }),
  acceptShare: (token: string) =>
    req<{ pid: string; role: Role }>(`/api/share/${encodeURIComponent(token)}/accept`, { method: 'POST' }),
}

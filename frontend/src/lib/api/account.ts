import { REQ_TIMEOUT_MS, netFetch, qs, req, handle } from './net'
import type { User } from '../types'
import type { AdminUser, AdminUserIn, MeIn, Org } from '@/types/account'
import type { AiUsageSummary, OrgAuditQuery, OrgAuditResponse, OrgSettings, OrgSettingsUpdatePatch } from '@/types/org'

export interface DoctorCheck {
  id: string
  name: string
  status: 'ok' | 'warn' | 'error' | 'off'
  summary: string
  hint: string
}

export interface DoctorReport {
  overall: 'ok' | 'warn' | 'error'
  checked_at: number
  product: string
  demo_mode: boolean
  checks: DoctorCheck[]
}

export interface DataHealthReport {
  checked_at: number
  project_count: number
  formats: Record<string, number>
  storage: {
    projects_bytes: number
    build_cache_bytes: number
    shared_assets_bytes: number
    db_bytes: number
    total_bytes: number
  }
  db: { exists: boolean; ok: boolean; message: string; bytes: number }
  disk: { total_bytes: number; used_bytes: number; free_bytes: number }
  corrupt_settings: { pid: string; error: string }[]
  top_projects: { pid: string; title: string; total_bytes: number; cache_bytes: number }[]
}

export const accountApi = {
  me: () => req<User | undefined>('/api/users/me'),
  register: (email: string, password: string, display_name = '', invite_code = '') =>
    req<User>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, display_name, ...(invite_code ? { invite_code } : {}) }),
    }),
  login: async (email: string, password: string) => {
    const r = await netFetch('/api/auth/cookie/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: email, password }).toString(),
      signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
    })
    await handle<void>(r)
  },
  logout: () => req<void>('/api/auth/cookie/logout', { method: 'POST' }),
  demoLogin: () => req<void>('/api/auth/demo-login', { method: 'POST' }),
  putMe: (body: MeIn) => req<User>('/api/users/me', { method: 'PUT', body: JSON.stringify(body) }),
  adminUsers: () => req<AdminUser[]>('/api/admin/users'),
  updateAdminUser: (userId: string, patch: AdminUserIn) =>
    req<AdminUser>(`/api/admin/users/${encodeURIComponent(userId)}`, { method: 'PUT', body: JSON.stringify(patch) }),
  org: () => req<Org>('/api/admin/org'),
  putOrg: (body: Org) => req<Org>('/api/admin/org', { method: 'PUT', body: JSON.stringify(body) }),
  doctor: () => req<DoctorReport>('/api/admin/doctor'),
  dataHealth: () => req<DataHealthReport>('/api/admin/data/health'),
  dataBackupUrl: (includeProjects = false) =>
    `/api/admin/data/backup?include_projects=${includeProjects ? 'true' : 'false'}`,
  orgAudit: (q: OrgAuditQuery = {}, signal?: AbortSignal) => req<OrgAuditResponse>(`/api/admin/audit${qs(q)}`, { signal }),
  orgAuditCsvUrl: (q: OrgAuditQuery = {}) => `/api/admin/audit.csv${qs(q)}`,
  orgSettings: () => req<OrgSettings>('/api/admin/settings'),
  putOrgSettings: (patch: OrgSettingsUpdatePatch) =>
    req<OrgSettings>('/api/admin/settings', { method: 'PUT', body: JSON.stringify(patch) }),
  testAiProvider: (body: { base_url: string; api_key: string; model: string }) =>
    req<{ ok: boolean; models?: string[]; error?: string }>('/api/admin/settings/ai-provider/test', { method: 'POST', body: JSON.stringify(body) }),
  orgAiUsage: (signal?: AbortSignal) => req<AiUsageSummary>('/api/admin/ai-usage', { signal }),
  resetAiUsage: (uid: string) =>
    req<{ ok: true; removed: boolean }>(`/api/admin/ai-usage/${encodeURIComponent(uid)}/reset`, { method: 'POST', body: JSON.stringify({}) }),
}

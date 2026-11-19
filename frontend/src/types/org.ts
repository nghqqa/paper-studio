/** 机构审计 / 设置 / AI 用量 API 契约（docs/plan/21-w5-spec.md §4；与 backend/app/schemas.py 逐字段对应） */
/* ---------- 机构审计 / 设置 / AI 用量（notify-audit-backend / agent-core-backend） ---------- */

export type OrgAuditKind =
  | 'template.created' | 'template.removed' | 'template.restored' | 'template.updated' | 'template.replaced'
  | 'auth.login' | 'case.created' | 'case.deleted' | 'case.status' | 'member.changed' | 'admin.user' | 'share.created' | 'share.revoked' | 'share.confirmed'
  | 'export.downloaded' | 'ai.sent' | 'deliver.filed'
  | 'oa.round' | 'deadline.done' | 'deadline.undone' | 'deadline.override' | 'deadline.nudge' | 'comment.assign'

export interface OrgAuditEvent {
  id: string
  ts: number
  kind: OrgAuditKind
  actor: { id: string; display_name: string } | null
  pid: string | null
  data: Record<string, unknown>
}

export interface OrgAuditQuery {
  actor?: string
  pid?: string
  /** ISO 日期 */
  from?: string
  to?: string
  kind?: OrgAuditKind
  limit?: number
}

export interface OrgAuditResponse {
  items: OrgAuditEvent[]
  total: number
}

/** 机构级设置（org.json 扩展）；`ai_enabled=false` → 所有 /ai /agent 403 ai_disabled_by_org */
export interface OrgSettings {
  ai_enabled: boolean
  /** 新建案卷默认协作设置（projects.py 创建钩子读取） */
  default_collab: { editor_mode: 'edit' | 'review'; allow_viewer_comment: boolean }
  smtp: { host: string; port: number; user: string; from: string; enabled: boolean } | null
  /** 每案日预算（tokens，默认 200k） */
  ai_daily_tokens: number
  /** 每人每日 AI token 上限（v0.6.7，护机构 key；0=不限，缺省关） */
  ai_user_daily_tokens: number
  /** 管理员配置的自定义模型接入（api_key 只写不读） */
  ai_provider: AiProviderInfo | null
}

/** 脱敏后的模型接入信息：api_key 永不回传 */
export interface AiProviderInfo {
  base_url: string
  model_interactive: string
  model_heavy: string
  model_fallback: string
  has_api_key: boolean
  api_key_hint: string
}

export interface AiUsageSummary {
  today_tokens: number
  budget: number
  /** 按案 */
  by_project: { pid: string; title: string; today_tokens: number }[]
  /** 按模型 */
  by_model: { model: string; tokens: number; calls: number }[]
  /** per-user 每日配额上限（0=不限）；by_user 含跨天残留行，展示按 day==今日过滤 */
  user_quota: number
  by_user: { uid: string; day: string; used: number; updated_at: number }[]
}


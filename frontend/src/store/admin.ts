import { api, isNotImplemented } from '@/lib/api'
import type { AiUsageSummary, OrgAuditQuery, OrgSettings, OrgSettingsUpdatePatch } from '@/types/org'
import type { Slice } from './types'

/** 机构审计每页窗口（「加载更多」逐次 +PAGE 扩容，CSV 不受限） */
export const ORG_AUDIT_PAGE = 100

/** 审计筛选 → 列表请求与 CSV 下载共用同一 query */
export const auditCsvUrl = (q: OrgAuditQuery): string => {
  const { limit: _limit, ...rest } = q
  return api.orgAuditCsvUrl(rest)
}

export interface AdminSlice {
  orgSettings: OrgSettings | null
  orgSettingsSaving: boolean
  orgSettingsUnavailable: boolean
  aiDisabledByOrg: boolean

  orgAiUsage: AiUsageSummary | null
  orgAiUsageUnavailable: boolean

  loadOrgSettings(): Promise<void>
  saveOrgSettings(patch: OrgSettingsUpdatePatch): Promise<boolean>
  loadOrgAiUsage(): Promise<void>
  /** 会话边界（logout/expireSession）清平台管理数据，防跨账号残留 */
  resetOrg(): void
}

export const adminSlice: Slice<AdminSlice> = (set, get) => {
  const fail = (e: unknown, key: 'orgSettingsUnavailable' | 'orgAiUsageUnavailable') => {
    const msg = e instanceof Error ? e.message : String(e)
    set({ [key]: isNotImplemented(e) } as Partial<AdminSlice>)
    if (!isNotImplemented(e)) get().toast(msg, 'error')
    return false
  }

  return {
    orgSettings: null,
    orgSettingsSaving: false,
    orgSettingsUnavailable: false,
    aiDisabledByOrg: false,
    orgAiUsage: null,
    orgAiUsageUnavailable: false,

    loadOrgSettings: async () => {
      try {
        const orgSettings = await api.orgSettings()
        set({
          orgSettings,
          orgSettingsUnavailable: false,
          aiDisabledByOrg: orgSettings.ai_enabled === false,
        })
      } catch (e) {
        fail(e, 'orgSettingsUnavailable')
      }
    },

    saveOrgSettings: async (patch) => {
      set({ orgSettingsSaving: true })
      try {
        const orgSettings = await api.putOrgSettings(patch)
        set({
          orgSettings,
          aiDisabledByOrg: orgSettings.ai_enabled === false,
        })
        if (patch.registration) {
          void get().fetchMeta?.()
        }
        get().toast('设置已保存', 'success')
        return true
      } catch (e) {
        return fail(e, 'orgSettingsUnavailable')
      } finally {
        set({ orgSettingsSaving: false })
      }
    },

    resetOrg: () =>
      set({
        orgSettings: null,
        orgSettingsSaving: false,
        orgSettingsUnavailable: false,
        aiDisabledByOrg: false,
        orgAiUsage: null,
        orgAiUsageUnavailable: false,
      }),

    loadOrgAiUsage: async () => {
      try {
        set({ orgAiUsage: await api.orgAiUsage(), orgAiUsageUnavailable: false })
      } catch (e) {
        fail(e, 'orgAiUsageUnavailable')
      }
    },
  }
}

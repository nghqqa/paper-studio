import { useEffect, useState } from 'react'
import { Bot, Building2, LayoutTemplate, ScrollText, Stethoscope, Users } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { SubNav, useHashTab, type SubNavItem } from '@/components/account/SubNav'
import { PageChrome } from '@/components/shell/PageChrome'
import { EmptyState } from '@/components/ui/empty-state'
import { useIsDesktop } from '@/hooks/useMisc'
import { api } from '@/lib/api'
import { useStudio } from '@/store'
import { cn } from '@/lib/utils'
import type { Org } from '@/types/account'
import { AiPanel } from './AiPanel'
import { AuditPanel } from './AuditPanel'
import { DoctorPanel } from './DoctorPanel'
import { MemberTable } from './MemberTable'
import { OrgPanel } from './OrgPanel'
import { PaperTemplatesPanel } from './PaperTemplatesPanel'

export type AdminTab = 'members' | 'org' | 'audit' | 'ai' | 'templates' | 'doctor'
export const ADMIN_TABS: readonly AdminTab[] = ['members', 'org', 'audit', 'ai', 'templates', 'doctor']

const NAV: readonly SubNavItem<AdminTab>[] = [
  { value: 'members', label: '成员', icon: <Users aria-hidden />, href: '#/admin?tab=members', 'data-testid': 'admin-tab-members' },
  { value: 'org', label: '团队设置', icon: <Building2 aria-hidden />, href: '#/admin?tab=org', 'data-testid': 'admin-tab-org' },
  { value: 'audit', label: '审计', icon: <ScrollText aria-hidden />, href: '#/admin?tab=audit', 'data-testid': 'admin-tab-audit' },
  { value: 'ai', label: 'AI', icon: <Bot aria-hidden />, href: '#/admin?tab=ai', 'data-testid': 'admin-tab-ai' },
  { value: 'templates', label: '论文模板', icon: <LayoutTemplate aria-hidden />, href: '#/admin?tab=templates', 'data-testid': 'admin-tab-templates' },
  { value: 'doctor', label: '系统诊断', icon: <Stethoscope aria-hidden />, href: '#/admin?tab=doctor', 'data-testid': 'admin-tab-doctor' },
]

const TITLE: Record<AdminTab, { h: string; p: string }> = {
  members: { h: '成员', p: '管理团队成员的展示信息、管理员角色和账号状态。' },
  org: { h: '团队设置', p: '管理团队名称与论文协作说明。' },
  audit: { h: '操作记录', p: '查看登录、论文项目、模板和协作操作，可按条件筛选与导出 CSV。' },
  ai: { h: 'AI 接入', p: '配置团队可用的 AI 服务、外发开关与用量预算。' },
  templates: { h: '论文模板库', p: '管理 Word 和 LaTeX 完整模板。添加后供全平台新建项目使用。' },
  doctor: { h: '系统诊断', p: '一键体检部署环境、编译工具链、ONLYOFFICE 连通性与安全配置。' },
}

export function AdminPage() {
  const isDesktop = useIsDesktop()
  const status = useStudio((s) => s.authStatus)
  const user = useStudio((s) => s.user)
  const rows = useStudio((s) => s.adminUsers)
  const loading = useStudio((s) => s.adminLoading)
  const unavailable = useStudio((s) => s.adminUnavailable)
  const error = useStudio((s) => s.adminError)
  const org = useStudio((s) => s.org)
  const loadAdmin = useStudio((s) => s.loadAdmin)
  const updateAdminUser = useStudio((s) => s.updateAdminUser)
  const saveOrg = useStudio((s) => s.saveOrg)
  const [offOrg, setOffOrg] = useState<Org | null>(null)
  const tab = useHashTab(ADMIN_TABS, 'members')
  const setTab = (t: AdminTab) => {
    window.location.hash = `#/admin?tab=${t}`
  }

  const authed = status === 'authed' && !!user
  const allowed = status === 'off' || (authed && user.is_superuser)

  useEffect(() => {
    if (!allowed) return
    if (status === 'authed') void loadAdmin()
    else if (status === 'off') void api.org().then(setOffOrg, () => setOffOrg({ name: '' }))
  }, [allowed, status, loadAdmin])

  const orgShown = org ?? (status === 'off' ? offOrg : null)

  return (
    <PageChrome name="admin" title="平台管理" description="管理成员、论文模板与平台设置。" backHref="#/" backLabel="返回项目">
      {!allowed ? (
        <EmptyState
          icon={Building2}
          title={status === 'unknown' ? '正在加载账号…' : '平台管理仅管理员可用'}
          reason={status === 'unknown' ? undefined : '请联系机构管理员为你开通权限。'}
          className="mx-auto max-w-form"
          role="status"
          data-testid="admin-forbidden"
        />
      ) : (
        <div className={isDesktop ? 'flex items-start gap-10' : 'grid gap-section-m'} data-testid="admin-card" data-tab={tab}>
          <SubNav items={NAV} value={tab} onValueChange={setTab} aria-label="平台管理" className={isDesktop ? 'sticky top-0 w-settings-nav' : undefined} />
          <div className={cn('grid min-w-0 flex-1 gap-6', tab !== 'members' && tab !== 'audit' && tab !== 'templates' && 'max-w-form')}>
            <header>
              <h2 className="text-xl font-semibold text-fg-strong" data-testid="admin-section-title">
                {TITLE[tab].h}
              </h2>
              <p className="mt-1 text-sm text-fg-muted">{TITLE[tab].p}</p>
            </header>

            {tab === 'members' && (
              <div className="grid gap-6" data-testid="admin-members-panel">
                {status === 'off' ? (
                  <Alert variant="info" role="status" data-testid="admin-auth-off">
                    <AlertDescription>账号系统尚未启用。成员和模板管理需要使用平台管理员登录。</AlertDescription>
                  </Alert>
                ) : (
                  <section aria-labelledby="admin-members-h" className="grid gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 id="admin-members-h" className="text-base font-semibold text-fg-strong">
                        成员
                      </h3>
                      {rows.length > 0 && <span className="text-xs tabular-nums text-fg-muted">{rows.length} 人</span>}
                      <p className="ml-auto text-xs text-fg-muted">在论文项目的「协作」中邀请合作者</p>
                    </div>
                    <MemberTable rows={rows} selfId={user?.id ?? null} loading={loading} unavailable={unavailable} error={error} onUpdate={(id, patch) => void updateAdminUser(id, patch)} mobile={!isDesktop} />
                  </section>
                )}
              </div>
            )}

            {tab === 'org' && <OrgPanel org={orgShown} orgUnavailable={status === 'authed' && unavailable} onSaveName={saveOrg} />}
            {tab === 'audit' && <AuditPanel />}
            {tab === 'ai' && <AiPanel />}
            {tab === 'templates' && <PaperTemplatesPanel mobile={!isDesktop} />}
            {tab === 'doctor' && <DoctorPanel />}
          </div>
        </div>
      )}
    </PageChrome>
  )
}

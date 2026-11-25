import { Bot, Building2, ChevronRight, ShieldCheck, UserRound } from 'lucide-react'
import { PageChrome } from '@/components/shell/PageChrome'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { useIsDesktop } from '@/hooks/useMisc'
import { useStudio } from '@/store'
import { AppearanceSection } from './AppearanceSection'
import { PasswordForm } from './PasswordForm'
import { ProfileForm } from './ProfileForm'
import { SubNav, useHashTab, type SubNavItem } from './SubNav'
import { UserAiPanel } from './UserAiPanel'

export type AccountTab = 'profile' | 'security' | 'ai'
export const ACCOUNT_TABS: readonly AccountTab[] = ['profile', 'security', 'ai']

const NAV: readonly SubNavItem<AccountTab>[] = [
  { value: 'profile', label: '资料', icon: <UserRound aria-hidden />, href: '#/account?tab=profile', 'data-testid': 'account-tab-profile' },
  { value: 'security', label: '安全', icon: <ShieldCheck aria-hidden />, href: '#/account?tab=security', 'data-testid': 'account-tab-security' },
  { value: 'ai', label: 'AI 接入', icon: <Bot aria-hidden />, href: '#/account?tab=ai', 'data-testid': 'account-tab-ai' },
]

const TITLE: Record<AccountTab, { h: string; p: string }> = {
  profile: { h: '资料', p: '显示名、头衔与头像色会出现在成员列表与批注署名；外观设置只影响本浏览器。' },
  security: { h: '安全', p: '修改登录密码；改密后所有设备（含本会话）需重新登录。' },
  ai: { h: 'AI 接入', p: '配置你自己的 OpenAI 兼容模型接入；优先于团队配置，未配置时回退团队接入。' },
}

/**
 * `#/account?tab=profile|security|ai`：左二级导航 200 + 表单列 640；375 Segmented 横滑 + 单列。
 * auth=off ⇒ 「账号系统未启用」；anon 由 App 导向登录页。超管在头部有「平台管理」入口。
 */
export function AccountPage() {
  const status = useStudio((s) => s.authStatus)
  const user = useStudio((s) => s.user)
  const saving = useStudio((s) => s.meSaving)
  const unavailable = useStudio((s) => s.meUnavailable)
  const saveMe = useStudio((s) => s.saveMe)
  const authError = useStudio((s) => s.authError)
  const loadMe = useStudio((s) => s.loadMe)
  const desktop = useIsDesktop()
  const tab = useHashTab(ACCOUNT_TABS, 'profile')
  const setTab = (t: AccountTab) => {
    window.location.hash = `#/account?tab=${t}`
  }

  const actions = user?.is_superuser ? (
    <Button asChild variant="secondary" size="md">
      <a href="#/admin" data-testid="account-admin-link">
        <Building2 aria-hidden /> 平台管理
      </a>
    </Button>
  ) : null

  return (
    <PageChrome name="account" title="账户" description={user ? user.email : undefined} actions={desktop ? actions : undefined}>
      {status === 'off' ? (
        <EmptyState icon={ShieldCheck} title="账号系统未启用" reason="本部署未开启账号系统（PAPER_STUDIO_AUTH=off），没有个人资料可编辑。" className="mx-auto max-w-form" data-testid="account-auth-off" />
      ) : !user && authError ? (
        <EmptyState
          icon={ShieldCheck}
          title="账号信息加载失败"
          reason={authError}
          action={<Button onClick={() => void loadMe()}>重试</Button>}
          className="mx-auto max-w-form"
          data-testid="account-auth-error"
        />
      ) : !user ? (
        <div className="mx-auto grid max-w-form gap-3" role="status" aria-label="正在加载账号" data-testid="account-loading">
          <Skeleton className="h-md-control w-1/3" />
          <Skeleton className="h-lg-control" />
          <Skeleton className="h-lg-control" />
        </div>
      ) : (
        <div className={desktop ? 'flex items-start gap-10' : 'grid gap-section-m'} data-testid="account-card" data-tab={tab}>
          <SubNav
            items={NAV}
            value={tab}
            onValueChange={setTab}
            aria-label="账户设置"
            className={desktop ? 'sticky top-0 w-settings-nav' : undefined}
          />
          <div className="grid min-w-0 max-w-form flex-1 gap-6">
            <header>
              <h2 className="text-xl font-semibold text-fg-strong" data-testid="account-section-title">
                {TITLE[tab].h}
              </h2>
              <p className="mt-1 text-sm text-fg-muted">{TITLE[tab].p}</p>
            </header>
            {tab === 'profile' && (
              <>
                <ProfileForm key={`${user.display_name}|${user.title ?? ''}|${user.avatar_color ?? ''}`} user={user} saving={saving} unavailable={unavailable} onSave={saveMe} mobile={!desktop} />
                <AppearanceSection mobile={!desktop} />
              </>
            )}
            {tab === 'security' && <PasswordForm saving={saving} unavailable={unavailable} onSave={saveMe} />}
            {tab === 'ai' && <UserAiPanel />}
            {!desktop && user.is_superuser && (
              <a
                href="#/admin"
                className="flex h-md-control items-center gap-2 border-t border-border text-sm text-fg hover:text-link"
                data-testid="account-admin-link"
              >
                <Building2 className="size-4 text-fg-icon" aria-hidden />
                平台管理
                <ChevronRight className="ml-auto size-4 text-fg-subtle" aria-hidden />
              </a>
            )}
          </div>
        </div>
      )}
    </PageChrome>
  )
}

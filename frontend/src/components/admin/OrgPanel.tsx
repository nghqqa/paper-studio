import { useEffect, useId, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Segmented } from '@/components/ui/segmented'
import { useStudio } from '@/store'
import type { Org } from '@/types/account'
import type { RegistrationMode } from '@/types/org'
import { OrgForm } from './OrgForm'

export interface OrgPanelProps {
  org: Org | null
  orgUnavailable: boolean
  onSaveName(name: string): Promise<boolean>
}

const REG_MODE_OPTIONS: { value: RegistrationMode; label: string; 'data-testid': string }[] = [
  { value: 'open', label: '开放注册', 'data-testid': 'reg-mode-open' },
  { value: 'invite_only', label: '仅限邀请', 'data-testid': 'reg-mode-invite_only' },
  { value: 'closed', label: '关闭自助注册', 'data-testid': 'reg-mode-closed' },
]

export function OrgPanel({ org, orgUnavailable, onSaveName }: OrgPanelProps) {
  const uid = useId()
  const authStatus = useStudio((s) => s.authStatus)
  const settings = useStudio((s) => s.orgSettings)
  const settingsUnavailable = useStudio((s) => s.orgSettingsUnavailable)
  const saving = useStudio((s) => s.orgSettingsSaving)
  const loadOrgSettings = useStudio((s) => s.loadOrgSettings)
  const saveOrgSettings = useStudio((s) => s.saveOrgSettings)

  useEffect(() => {
    if (authStatus === 'authed' && !orgUnavailable && settings === null) {
      void loadOrgSettings()
    }
  }, [authStatus, orgUnavailable, settings, loadOrgSettings])

  const reg = settings?.registration
  const regKey = reg ? `${reg.mode}|${reg.invite_code_hint}|${reg.allowed_domains.join(',')}` : 'init'

  const [mode, setMode] = useState<RegistrationMode>(reg?.mode ?? 'open')
  const [inviteCode, setInviteCode] = useState('')
  const [clearInviteCode, setClearInviteCode] = useState(false)
  const [domainsText, setDomainsText] = useState((reg?.allowed_domains ?? []).join(', '))

  useEffect(() => {
    if (!reg) return
    setMode(reg.mode)
    setDomainsText(reg.allowed_domains.join(', '))
    setInviteCode('')
    setClearInviteCode(false)
  }, [regKey, reg])

  const onSaveReg = async (e: FormEvent) => {
    e.preventDefault()
    const allowed_domains = domainsText
      .split(/[,;\s]+/)
      .map((s) => s.trim().replace(/^[@.]+/, '').toLowerCase())
      .filter(Boolean)
    const patch: { mode: RegistrationMode; allowed_domains: string[]; invite_code?: string } = {
      mode,
      allowed_domains,
    }
    if (clearInviteCode) patch.invite_code = ''
    else if (inviteCode.trim()) patch.invite_code = inviteCode.trim()
    const ok = await saveOrgSettings({ registration: patch })
    if (ok) {
      setInviteCode('')
      setClearInviteCode(false)
    }
  }

  return (
    <div className="grid gap-6" data-testid="admin-org-panel">
      <section className="grid gap-2">
        <h3 className="text-sm font-semibold">团队或机构名称</h3>
        <OrgForm key={org?.name ?? ''} org={org} unavailable={orgUnavailable} onSave={onSaveName} />
      </section>

      {authStatus !== 'off' && !orgUnavailable && !settingsUnavailable && (
        <section className="grid gap-3 border-t border-border pt-5" data-testid="admin-registration-section">
          <div>
            <h3 className="text-sm font-semibold text-fg-strong">注册访问控制</h3>
            <p className="mt-1 text-xs text-fg-muted">
              控制公网部署时谁可以注册新账号；受邀邮箱仍可凭成员邀请加入项目。
            </p>
          </div>
          <form onSubmit={(e) => void onSaveReg(e)} className="grid gap-4">
            <div className="grid gap-1.5">
              <span className="text-xs font-medium text-fg">注册策略</span>
              <Segmented
                value={mode}
                onValueChange={setMode}
                options={REG_MODE_OPTIONS}
                aria-label="注册策略"
                size="sm"
              />
            </div>

            {mode === 'invite_only' && (
              <div className="grid gap-1.5">
                <Label htmlFor={`${uid}-invite-code`}>站点邀请码</Label>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    id={`${uid}-invite-code`}
                    type="text"
                    maxLength={128}
                    value={inviteCode}
                    placeholder={
                      reg?.has_invite_code && !clearInviteCode
                        ? `已配置（${reg.invite_code_hint}），留空保持不变`
                        : '输入新邀请码（如 LAB-2026）'
                    }
                    onChange={(e) => {
                      setInviteCode(e.target.value)
                      setClearInviteCode(false)
                    }}
                    className="min-w-0 flex-1"
                    data-testid="reg-invite-code"
                  />
                  {reg?.has_invite_code && !clearInviteCode && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setInviteCode('')
                        setClearInviteCode(true)
                      }}
                      data-testid="reg-clear-invite"
                    >
                      清除邀请码
                    </Button>
                  )}
                </div>
                {clearInviteCode && (
                  <p className="text-xs text-warn-fg">保存后将清空当前邀请码，届时仅限管理员后台预先邀请的邮箱可注册。</p>
                )}
              </div>
            )}

            <div className="grid gap-1.5">
              <Label htmlFor={`${uid}-allowed-domains`}>允许注册的邮箱域名白名单（可选，逗号分隔）</Label>
              <Input
                id={`${uid}-allowed-domains`}
                type="text"
                value={domainsText}
                placeholder="例：edu.cn, tsinghua.edu.cn（留空表示不限制域名）"
                onChange={(e) => setDomainsText(e.target.value)}
                data-testid="reg-allowed-domains"
              />
            </div>

            <div>
              <Button type="submit" variant="outline" disabled={saving} data-testid="reg-save">
                {saving ? '保存中…' : '保存注册策略'}
              </Button>
            </div>
          </form>
        </section>
      )}

      <p className="text-sm leading-6 text-fg-muted">
        论文项目可分别邀请合作者，并设置编辑、审阅或只读权限。成员的展示头衔不会自动改变项目权限。
      </p>
    </div>
  )
}

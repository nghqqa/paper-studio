import { lazy, Suspense, useEffect, useState, type FormEvent } from 'react'
import { fmtTokens, fmtWhen } from '@/lib/format'
import { Construction, RotateCcw, TriangleAlert } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { EmptyState , NOT_IMPLEMENTED_TITLE } from '@/components/ui/empty-state'
import { Field, FieldControl, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { useStudio } from '@/store'
import type { OrgSettings } from '@/types/org'

const AiUsageChart = lazy(() => import('./AiUsageChart'))


export function validateBudget(raw: string): string | undefined {
  if (raw.trim() === '') return '请填写日预算'
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) return '须为不小于 0 的整数（token）'
  return undefined
}

/**
 * AI tab（21 §4.6 / R-AI-01 / R-AI-09）：机构级开关（关闭 → 全机构所有案卷禁用外发，案级开关 disabled）·
 * 模型路由只读 · 今日用量 Chart（lazy，Recharts 只在此 tab 加载）· 日预算 → PUT /api/admin/settings.ai_daily_tokens。
 * 「本月用量」需要 AiUsageSummary 增加月度字段，见 integration_requests。
 */
export function AiPanel() {
  const settings = useStudio((s) => s.orgSettings)
  const paper = useStudio((s) => s.product === 'paper')
  const unavailable = useStudio((s) => s.orgSettingsUnavailable)
  const saving = useStudio((s) => s.orgSettingsSaving)
  const loadOrgSettings = useStudio((s) => s.loadOrgSettings)
  const saveOrgSettings = useStudio((s) => s.saveOrgSettings)
  const usage = useStudio((s) => s.orgAiUsage)
  const usageUnavailable = useStudio((s) => s.orgAiUsageUnavailable)
  const loadOrgAiUsage = useStudio((s) => s.loadOrgAiUsage)

  useEffect(() => {
    void loadOrgSettings()
    void loadOrgAiUsage()
  }, [loadOrgSettings, loadOrgAiUsage])

  const [budget, setBudget] = useState('')
  const [budgetError, setBudgetError] = useState<string | undefined>()
  // v0.3 模型接入：管理员配置自定义 API（OpenAI 兼容）
  const [provider, setProvider] = useState({ base_url: '', api_key: '', model_interactive: '', model_heavy: '', model_fallback: '' })
  const [providerSaving, setProviderSaving] = useState(false)
  const [providerMsg, setProviderMsg] = useState<{ text: string; err: boolean } | null>(null)
  useEffect(() => {
    if (!settings?.ai_provider) return
    setProvider((cur) => ({
      base_url: settings.ai_provider!.base_url,
      model_interactive: settings.ai_provider!.model_interactive,
      model_heavy: settings.ai_provider!.model_heavy,
      model_fallback: settings.ai_provider!.model_fallback,
      api_key: cur.api_key, // 密钥不回显：留空=保留已存值
    }))
  }, [settings])


  const saveProvider = async (e: FormEvent) => {
    e.preventDefault()
    setProviderSaving(true); setProviderMsg(null)
    try {
      const key = provider.api_key === '__SAVED__' ? '__SAVED__' : provider.api_key
      // PATCH 的 ai_provider 允许携带 api_key（后端 AiProviderIn），与脱敏回显类型不同
      // heavy/fallback 留空时自动沿用 interactive（用户只填一个模型名的场景）
      const interactive = provider.model_interactive || provider.model_heavy || provider.model_fallback
      await api.putOrgSettings({ ai_provider: {
        ...provider,
        api_key: key,
        model_heavy: provider.model_heavy || interactive,
        model_fallback: provider.model_fallback || interactive,
      } as unknown as OrgSettings['ai_provider'] })
      setProvider((cur) => ({ ...cur, api_key: '' }))
      await loadOrgSettings()
      setProviderMsg({ text: '模型接入已保存', err: false })
    } catch (err) {
      setProviderMsg({ text: err instanceof Error ? err.message : String(err), err: true })
    } finally {
      setProviderSaving(false)
    }
  }

  const testProvider = async () => {
    setProviderSaving(true); setProviderMsg(null)
    try {
      const key = provider.api_key === '' && settings?.ai_provider?.has_api_key ? '__SAVED__' : provider.api_key
      const r = await api.testAiProvider({ base_url: provider.base_url, api_key: key, model: provider.model_interactive })
      setProviderMsg(r.ok
        ? { text: `连接成功（模型 ${(r.models ?? []).length} 个）`, err: false }
        : { text: r.error || '连接失败', err: true })
    } catch (err) {
      setProviderMsg({ text: err instanceof Error ? err.message : String(err), err: true })
    } finally {
      setProviderSaving(false)
    }
  }
  useEffect(() => {
    if (settings) setBudget(String(settings.ai_daily_tokens))
  }, [settings])

  // ---- per-user 每日限额（v0.6.7）：护机构 key；BYOK 不占额度 ----
  const [userQuota, setUserQuota] = useState('')
  const [userQuotaError, setUserQuotaError] = useState<string | undefined>()
  const [resetBusy, setResetBusy] = useState<string | null>(null)
  useEffect(() => {
    if (settings) setUserQuota(String(settings.ai_user_daily_tokens ?? 0))
  }, [settings])
  const today = new Date()
  const dayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const usersList = useStudio((s) => s.adminUsers)
  const emailOf = (uid: string) => usersList.find((u) => u.id === uid)?.email ?? null
  const todayUsers = (usage?.by_user ?? []).filter((r) => r.day === dayStr && r.used > 0)

  const onUserQuota = (e: FormEvent) => {
    e.preventDefault()
    const err = validateBudget(userQuota)
    setUserQuotaError(err)
    if (err) return
    void saveOrgSettings({ ai_user_daily_tokens: Number(userQuota) })
  }
  const userQuotaDirty = settings && userQuota !== String(settings.ai_user_daily_tokens ?? 0)
  const [quotaMsg, setQuotaMsg] = useState<{ text: string; err: boolean } | null>(null)
  const resetUser = async (uid: string) => {
    setResetBusy(uid)
    setQuotaMsg(null)
    try {
      await api.resetAiUsage(uid)
      await loadOrgAiUsage()
      setQuotaMsg({ text: '已重置该用户今日用量', err: false })
    } catch (err) {
      setQuotaMsg({ text: `重置失败：${err instanceof Error ? err.message : String(err)}`, err: true })
    } finally {
      setResetBusy(null)
    }
  }

  if (unavailable) {
    return <EmptyState icon={Construction} title={NOT_IMPLEMENTED_TITLE} reason="机构 AI 设置接口（GET/PUT /api/admin/settings）尚未提供（501）。" data-testid="admin-ai-unavailable" />
  }
  if (!settings) {
    return (
      <div className="grid max-w-form gap-3" aria-busy data-testid="admin-ai-loading">
        <Skeleton className="h-md-control" />
        <Skeleton className="h-24" />
      </div>
    )
  }

  const enabled = settings.ai_enabled
  const onToggle = (v: boolean) => void saveOrgSettings({ ai_enabled: v })
  const onBudget = (e: FormEvent) => {
    e.preventDefault()
    const err = validateBudget(budget)
    setBudgetError(err)
    if (err) return
    void saveOrgSettings({ ai_daily_tokens: Number(budget) })
  }
  const budgetDirty = budget !== String(settings.ai_daily_tokens)
  const pct = usage && usage.budget > 0 ? Math.min(100, Math.round((usage.today_tokens / usage.budget) * 100)) : 0

  return (
    <div className="grid max-w-form gap-6" data-testid="admin-ai-panel">
      <section aria-labelledby="admin-ai-switch-h" className="grid gap-3">
        <h3 id="admin-ai-switch-h" className="text-sm font-semibold">{paper ? '团队级 AI 开关' : '机构级 AI 开关'}</h3>
        <div className="flex items-center justify-between gap-3 rounded-md border bg-panel px-3 py-2">
          <div className="min-w-0">
            <Label htmlFor="org-ai-enabled" className="text-sm">{paper ? '允许向 AI 服务外发论文项目内容' : '允许向 AI 服务外发案卷内容'}</Label>
            <p className="text-xs text-fg-muted">{paper ? '关闭后所有论文项目的 AI 智能体与 MCP 语义工具都停止外发；各项目的「AI 外发」开关变为不可用。' : '关闭后所有案卷的 AI 智能体与 MCP 语义工具都停止外发；各案的案级开关变为不可用。'}</p>
          </div>
          <Switch id="org-ai-enabled" checked={enabled} disabled={saving} onCheckedChange={onToggle} data-testid="org-ai-enabled" />
        </div>
        {!enabled && (
          <Alert variant="warn" data-testid="org-ai-disabled-alert">
            <TriangleAlert aria-hidden />
            <AlertTitle>{paper ? 'AI 已对全团队关闭' : 'AI 已对全机构关闭'}</AlertTitle>
            <AlertDescription>{paper ? '此设置对团队内所有成员与所有论文项目生效；各项目「AI 外发」开关将显示为禁用，直到这里重新开启。' : '此设置对机构内所有成员与所有案卷生效；案级「AI 外发」开关将显示为禁用，直到这里重新开启。'}</AlertDescription>
          </Alert>
        )}
      </section>

      <section aria-labelledby="admin-ai-provider-h" className="grid gap-2">
        <form className="grid gap-2" onSubmit={(e) => void saveProvider(e)} data-testid="ai-provider-form">
          <h3 id="admin-ai-provider-h" className="text-sm font-semibold">模型接入</h3>
          <p className="text-xs text-fg-muted">填写 OpenAI 兼容接口地址与 API Key；日常任务/长文任务/兜底可填同一模型名。润色等功能使用此接入。</p>
          <div className="grid gap-1">
            <Label htmlFor="ai-provider-url" className="text-xs">API 地址</Label>
            <Input id="ai-provider-url" value={provider.base_url} onChange={(e) => setProvider((c) => ({ ...c, base_url: e.target.value }))} placeholder="https://api.example.com/v1" data-testid="ai-provider-url" />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="ai-provider-key" className="text-xs">API Key {settings.ai_provider?.has_api_key ? `（已保存 ${settings.ai_provider.api_key_hint}，留空保留）` : ''}</Label>
            <Input id="ai-provider-key" type="password" value={provider.api_key} onChange={(e) => setProvider((c) => ({ ...c, api_key: e.target.value }))} placeholder={settings.ai_provider?.has_api_key ? '留空保留已存密钥' : 'sk-…'} data-testid="ai-provider-key" autoComplete="new-password" />
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div className="grid gap-1">
              <Label htmlFor="ai-model-interactive" className="text-xs">日常任务模型</Label>
              <Input id="ai-model-interactive" value={provider.model_interactive} onChange={(e) => setProvider((c) => ({ ...c, model_interactive: e.target.value }))} placeholder="例如 gpt-4o-mini" data-testid="ai-model-interactive" />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="ai-model-heavy" className="text-xs">长文任务模型</Label>
              <Input id="ai-model-heavy" value={provider.model_heavy} onChange={(e) => setProvider((c) => ({ ...c, model_heavy: e.target.value }))} data-testid="ai-model-heavy" placeholder="留空 = 同日常任务模型" />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="ai-model-fallback" className="text-xs">兜底模型</Label>
              <Input id="ai-model-fallback" value={provider.model_fallback} onChange={(e) => setProvider((c) => ({ ...c, model_fallback: e.target.value }))} data-testid="ai-model-fallback" placeholder="留空 = 同日常任务模型" />
            </div>
          </div>
          {providerMsg && <p className={providerMsg.err ? 'text-sm text-danger-fg' : 'text-sm text-ok-fg'} role="status">{providerMsg.text}</p>}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={providerSaving || !provider.base_url || !provider.model_interactive} data-testid="ai-provider-save">保存模型接入</Button>
            <Button type="button" variant="outline" size="sm" disabled={providerSaving || !provider.base_url} onClick={() => void testProvider()} data-testid="ai-provider-test">测试连接</Button>
          </div>
        </form>
      </section>

      <section aria-labelledby="admin-ai-usage-h" className="grid gap-3">
        <h3 id="admin-ai-usage-h" className="text-sm font-semibold">今日用量</h3>
        {usageUnavailable ? (
          <EmptyState icon={Construction} title={NOT_IMPLEMENTED_TITLE} reason="AI 用量接口（GET /api/admin/ai-usage）尚未提供（501）。" size="sm" data-testid="ai-usage-unavailable" />
        ) : !usage ? (
          <Skeleton className="h-48" data-testid="ai-usage-loading" />
        ) : (
          <div className="grid gap-3 rounded-md border bg-panel p-3" data-testid="ai-usage">
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span>
                今日 <strong className="tabular-nums">{fmtTokens(usage.today_tokens)}</strong> token
              </span>
              <span className="text-xs tabular-nums text-fg-muted">预算 {fmtTokens(usage.budget)} · {pct}%</span>
            </div>
            <Progress value={pct} aria-label="今日用量占预算比例" />
            {usage.by_project.length === 0 ? (
              <p className="text-xs text-fg-muted">今日尚无 AI 调用。</p>
            ) : (
              <Suspense fallback={<Skeleton className="h-48" />}>
                <AiUsageChart usage={usage} />
              </Suspense>
            )}
            {usage.by_model.length > 0 && (
              <ul className="flex flex-wrap gap-2 text-xs text-fg-muted" data-testid="ai-usage-by-model">
                {usage.by_model.map((m) => (
                  <li key={m.model} className="rounded-sm bg-sunken px-2 py-0.5 tabular-nums">
                    <code className="font-mono">{m.model}</code> {fmtTokens(m.tokens)} · {m.calls} 次
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <section aria-labelledby="admin-ai-userquota-h" className="grid gap-3">
        <h3 id="admin-ai-userquota-h" className="text-sm font-semibold">每人每日限额</h3>
        <form className="grid gap-3" onSubmit={onUserQuota} noValidate data-testid="ai-user-quota-form">
          <Field error={userQuotaError}>
            <FieldLabel>每人每日 token 上限</FieldLabel>
            <FieldControl>
              <Input type="number" inputMode="numeric" min={0} step={10000} value={userQuota} onChange={(e) => setUserQuota(e.target.value)} className="max-w-48 tabular-nums" data-testid="ai-user-quota" />
            </FieldControl>
            <FieldDescription>
              多账号共用机构 API Key 时按人封顶：达到上限后该用户当日机构通道的 AI 调用被拒（自带 Key 不受影响）。0 表示不限。
            </FieldDescription>
            <FieldError data-testid="ai-user-quota-error" />
          </Field>
          <div>
            <Button type="submit" variant="outline" disabled={!userQuotaDirty || saving} data-testid="ai-user-quota-save">
              {saving ? '保存中…' : '保存限额'}
            </Button>
            {quotaMsg && <span className={quotaMsg.err ? 'ml-2 text-xs text-danger-fg' : 'ml-2 text-xs text-ok-fg'} role="status">{quotaMsg.text}</span>}
          </div>
        </form>
        {todayUsers.length > 0 && (
          <div className="overflow-hidden rounded-md border bg-panel" data-testid="ai-usage-by-user">
            <table className="w-full text-left text-xs">
              <thead className="bg-sunken text-fg-muted">
                <tr>
                  <th className="px-2.5 py-1.5 font-medium">用户</th>
                  <th className="px-2.5 py-1.5 text-right font-medium">今日用量</th>
                  <th className="px-2.5 py-1.5 text-right font-medium">最近调用</th>
                  <th className="px-2.5 py-1.5 font-medium"><span className="sr-only">操作</span></th>
                </tr>
              </thead>
              <tbody>
                {todayUsers.map((r) => (
                  <tr key={r.uid} className="border-t border-line">
                    <td className="max-w-40 truncate px-2.5 py-1.5" title={emailOf(r.uid) ?? r.uid}>
                      {emailOf(r.uid) ?? <code className="font-mono">{r.uid.slice(0, 13)}…</code>}
                    </td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums">
                      {fmtTokens(r.used)}
                      {usage && usage.user_quota > 0 && <span className="text-fg-muted"> / {fmtTokens(usage.user_quota)}</span>}
                    </td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums text-fg-muted">{r.updated_at ? fmtWhen(r.updated_at) : '—'}</td>
                    <td className="px-2.5 py-1.5 text-right">
                      <Button size="xs" variant="ghost" disabled={resetBusy === r.uid} onClick={() => void resetUser(r.uid)} title="清零该用户今日计数（解除封顶）" data-testid={`ai-usage-reset-${r.uid}`}>
                        <RotateCcw aria-hidden className="size-3" />
                        重置
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="admin-ai-budget-h" className="grid gap-3">
        <h3 id="admin-ai-budget-h" className="text-sm font-semibold">日预算</h3>
        <form className="grid gap-3" onSubmit={onBudget} noValidate data-testid="ai-budget-form">
          <Field error={budgetError}>
            <FieldLabel>每日 token 上限</FieldLabel>
            <FieldControl>
              <Input type="number" inputMode="numeric" min={0} step={1000} value={budget} onChange={(e) => setBudget(e.target.value)} className="max-w-48 tabular-nums" data-testid="ai-budget" />
            </FieldControl>
            <FieldDescription>达到上限后当日新的 AI 任务排队到次日；0 表示不限。</FieldDescription>
            <FieldError data-testid="ai-budget-error" />
          </Field>
          <div>
            <Button type="submit" variant="outline" disabled={!budgetDirty || saving} data-testid="ai-budget-save">
              {saving ? '保存中…' : '保存预算'}
            </Button>
          </div>
        </form>
      </section>
    </div>
  )
}

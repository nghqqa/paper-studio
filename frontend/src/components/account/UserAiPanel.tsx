import { useEffect, useState, type FormEvent } from 'react'
import { Bot, Check, Trash2 } from 'lucide-react'
import { aiApi, type MyProviderMasked } from '@/lib/api/ai'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Field, FieldControl, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { useStudio } from '@/store'

/**
 * 账户 · AI 接入（v0.4.2）：用户自带 OpenAI 兼容接入（base_url + key + 模型）。
 * 优先于机构配置，未自配时回退机构接入；机构 ai_enabled 总闸不因此绕过。
 * api_key 只写不读（回显只有尾号提示）；留空 = 保留已存 Key。
 */
export function UserAiPanel() {
  const authStatus = useStudio((s) => s.authStatus)
  const toast = useStudio((s) => s.toast)

  const [loading, setLoading] = useState(true)
  const [provider, setProvider] = useState<MyProviderMasked | null>(null)
  const [orgFallback, setOrgFallback] = useState<MyProviderMasked | null>(null)
  const [effective, setEffective] = useState<'user' | 'org' | 'none'>('none')

  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [modelInteractive, setModelInteractive] = useState('')
  const [modelHeavy, setModelHeavy] = useState('')
  const [modelFallback, setModelFallback] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)

  const refresh = async () => {
    try {
      const r = await aiApi.myProvider()
      setProvider(r.provider)
      setOrgFallback(r.org_fallback)
      setEffective(r.effective)
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (authStatus !== 'authed') return
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authStatus])

  if (authStatus === 'off') {
    return (
      <section data-testid="user-ai-panel" className="max-w-form">
        <EmptyState icon={Bot} title="账号系统未启用" reason="本部署未开启账号系统（PATENT_STUDIO_AUTH=off），AI 接入按机构配置或环境变量生效。" />
      </section>
    )
  }

  const applyMasked = (p: MyProviderMasked | null) => {
    setProvider(p)
    setBaseUrl(p?.base_url ?? '')
    setModelInteractive(p?.model_interactive ?? '')
    setModelHeavy(p?.model_heavy ?? '')
    setModelFallback(p?.model_fallback ?? '')
  }

  const onSave = async (e: FormEvent) => {
    e.preventDefault()
    const trimmedUrl = baseUrl.trim()
    if (!/^https?:\/\//i.test(trimmedUrl)) {
      setError('接口地址必须以 http:// 或 https:// 开头')
      return
    }
    if (!modelInteractive.trim()) {
      setError('请填写交互模型名（如 deepseek-chat、gpt-4o-mini）')
      return
    }
    if (!apiKey.trim() && !(provider?.has_api_key)) {
      setError('请填写 API Key（已配置时留空表示保留原 Key）')
      return
    }
    setSaving(true)
    setError('')
    try {
      const r = await aiApi.saveMyProvider({
        base_url: trimmedUrl,
        api_key: apiKey.trim(),
        model_interactive: modelInteractive.trim(),
        model_heavy: modelHeavy.trim(),
        model_fallback: modelFallback.trim(),
      })
      applyMasked(r.provider)
      setApiKey('')
      setEffective('user')
      toast('AI 接入已保存', 'success')
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const onClear = async () => {
    setConfirmClear(false)
    try {
      await aiApi.clearMyProvider()
      applyMasked(null)
      setApiKey('')
      toast('已清除自己的接入' + (orgFallback ? '，回退机构配置' : ''))
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : '清除失败')
    }
  }

  const effectiveLabel = effective === 'user' ? '你的接入' : effective === 'org' ? '机构接入' : '未配置'

  return (
    <section data-testid="user-ai-panel" aria-busy={loading} className="grid max-w-form gap-5">
      <div>
        <h2 className="text-sm font-semibold">我的模型接入</h2>
        <p className="mt-1 text-xs text-fg-muted">
          配置 OpenAI 兼容接口（/v1/chat/completions）。论文助手的生成/精读、文献 AI 补全、论文润色优先走你自己的接入；
          未配置时回退机构配置。API Key 只保存在服务器、任何页面都不回显明文。
        </p>
      </div>

      <div className="flex items-center gap-2 rounded-md border bg-panel px-2.5 py-2 text-xs" data-testid="user-ai-effective">
        <span className="text-fg-muted">当前生效</span>
        <span className={effective === 'none' ? 'text-warning-foreground' : 'font-medium text-ok'}>
          {loading ? '读取中…' : effectiveLabel}
        </span>
        {effective === 'org' && orgFallback && (
          <span className="min-w-0 truncate text-fg-muted">
            · {orgFallback.base_url} · {orgFallback.model_interactive}（{orgFallback.api_key_hint}）
          </span>
        )}
      </div>

      <form className="grid gap-3" onSubmit={(e) => void onSave(e)} noValidate>
        <Field>
          <FieldLabel>接口地址（base_url）</FieldLabel>
          <FieldControl>
            <Input
              className="font-mono text-xs"
              placeholder="https://api.openai.com/v1"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              data-testid="user-ai-base-url"
            />
          </FieldControl>
          <FieldDescription>OpenAI 兼容服务的根地址（到 /v1）。</FieldDescription>
        </Field>
        <Field>
          <FieldLabel>API Key</FieldLabel>
          <FieldControl>
            <Input
              type="password"
              className="font-mono text-xs"
              placeholder={provider?.has_api_key ? '留空 = 保留已存 Key' : 'sk-…'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              data-testid="user-ai-key"
            />
          </FieldControl>
          {provider?.has_api_key && <FieldDescription>已存 Key 尾号 {provider.api_key_hint}。</FieldDescription>}
        </Field>
        <Field>
          <FieldLabel>交互模型（必填）</FieldLabel>
          <FieldControl>
            <Input
              className="font-mono text-xs"
              placeholder="如 deepseek-chat / gpt-4o-mini"
              value={modelInteractive}
              onChange={(e) => setModelInteractive(e.target.value)}
              data-testid="user-ai-model"
            />
          </FieldControl>
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel>重模型（选填）</FieldLabel>
            <FieldControl>
              <Input className="font-mono text-xs" value={modelHeavy} onChange={(e) => setModelHeavy(e.target.value)} data-testid="user-ai-model-heavy" />
            </FieldControl>
          </Field>
          <Field>
            <FieldLabel>备用模型（选填）</FieldLabel>
            <FieldControl>
              <Input className="font-mono text-xs" value={modelFallback} onChange={(e) => setModelFallback(e.target.value)} data-testid="user-ai-model-fallback" />
            </FieldControl>
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {error && (
            <p role="alert" className="w-full text-xs text-danger" data-testid="user-ai-error">
              {error}
            </p>
          )}
          <Button type="submit" disabled={saving} data-testid="user-ai-save">
            <Check aria-hidden />
            {saving ? '保存中…' : '保存接入'}
          </Button>
          {provider?.has_api_key && !confirmClear && (
            <Button type="button" variant="ghost" className="text-fg-muted hover:text-danger-fg" onClick={() => setConfirmClear(true)} data-testid="user-ai-clear">
              <Trash2 aria-hidden /> 清除自己的接入
            </Button>
          )}
          {confirmClear && (
            <span className="flex items-center gap-1 text-xs" role="group" aria-label="确认清除自己的 AI 接入">
              <span className="text-danger-fg">清除后回退机构配置，确认？</span>
              <Button type="button" variant="danger" size="sm" onClick={() => void onClear()} data-testid="user-ai-clear-confirm">
                确认
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmClear(false)}>
                取消
              </Button>
            </span>
          )}
        </div>
      </form>
    </section>
  )
}

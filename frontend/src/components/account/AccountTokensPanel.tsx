import { useCallback, useEffect, useState } from 'react'
import { Check, Copy, KeyRound, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { patApi, type PatTokenInfo } from '@/lib/api/pat'

function fmtTs(ts: number | null | undefined): string {
  if (!ts) return '—'
  return new Date(ts * 1000).toLocaleString('zh-CN')
}

export function AccountTokensPanel() {
  const [tokens, setTokens] = useState<PatTokenInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [name, setName] = useState('')
  const [expiresDays, setExpiresDays] = useState('')
  const [busy, setBusy] = useState(false)
  const [revealed, setRevealed] = useState<string | null>(null)
  const [copiedKey, setCopiedKey] = useState<'token' | 'mcp' | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setErr('')
    try {
      const r = await patApi.list()
      setTokens(r.tokens)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleCreate = async () => {
    if (!name.trim() || busy) return
    setBusy(true)
    setErr('')
    try {
      const days = expiresDays.trim() ? Number(expiresDays.trim()) : null
      const r = await patApi.create(name.trim(), days && Number.isFinite(days) ? days : null)
      setRevealed(r.token.token)
      setName('')
      setExpiresDays('')
      await refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const handleRevoke = async (id: string) => {
    if (busy) return
    setBusy(true)
    setErr('')
    try {
      await patApi.revoke(id)
      await refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const origin = typeof window !== 'undefined' && window.location.origin ? window.location.origin : 'http://localhost:8000'
  const mcpSnippet = JSON.stringify(
    {
      mcpServers: {
        'paper-studio': {
          url: `${origin}/api/mcp`,
          headers: {
            Authorization: `Bearer ${revealed || '<YOUR_PAT_TOKEN>'}`,
          },
        },
      },
    },
    null,
    2,
  )

  const copyText = async (txt: string, kind: 'token' | 'mcp') => {
    try {
      await navigator.clipboard.writeText(txt)
      setCopiedKey(kind)
      window.setTimeout(() => setCopiedKey(null), 1500)
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="space-y-6 text-sm" data-testid="account-tokens-panel">
      <section className="space-y-3 rounded-lg border border-border bg-panel p-4">
        <h3 className="flex items-center gap-2 font-medium text-fg-strong">
          <KeyRound aria-hidden className="size-4 text-primary" /> 新建个人访问令牌（PAT）
        </h3>
        <p className="text-xs text-fg-muted">
          令牌通过 Authorization: Bearer 调用原生 MCP Server（POST /api/mcp）。所有 AI 写入提案仅进入待审阅队列，不会静默覆盖原稿。
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="令牌用途，如 Claude Code / Cursor"
            className="min-w-48 flex-1 rounded-md border border-border bg-app px-3 py-1.5 text-sm"
            data-testid="pat-name-input"
          />
          <input
            type="number"
            min={1}
            max={3650}
            value={expiresDays}
            onChange={(e) => setExpiresDays(e.target.value)}
            placeholder="有效天数（可选）"
            className="w-36 rounded-md border border-border bg-app px-3 py-1.5 text-sm"
            data-testid="pat-days-input"
          />
          <Button disabled={busy || !name.trim()} onClick={() => void handleCreate()} data-testid="pat-create-btn">
            <Plus aria-hidden /> 生成令牌
          </Button>
        </div>
        {err && <p role="alert" className="text-xs text-danger">{err}</p>}
        {revealed && (
          <div className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs" data-testid="pat-revealed-box">
            <div className="font-medium text-warning">请立即保存该明文令牌（页面关闭或刷新后将不再完整显示）：</div>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 overflow-auto rounded bg-app px-2 py-1 font-mono text-fg-strong" data-testid="pat-revealed-value">
                {revealed}
              </code>
              <Button size="xs" variant="outline" onClick={() => void copyText(revealed, 'token')}>
                {copiedKey === 'token' ? <Check aria-hidden className="size-3" /> : <Copy aria-hidden className="size-3" />}
                {copiedKey === 'token' ? '已复制' : '复制'}
              </Button>
            </div>
          </div>
        )}
      </section>

      <section className="space-y-2 rounded-lg border border-border bg-panel p-4">
        <div className="flex items-center justify-between">
          <h3 className="font-medium text-fg-strong">MCP 客户端接入配置片段</h3>
          <Button size="xs" variant="outline" onClick={() => void copyText(mcpSnippet, 'mcp')}>
            {copiedKey === 'mcp' ? <Check aria-hidden className="size-3" /> : <Copy aria-hidden className="size-3" />}
            {copiedKey === 'mcp' ? '已复制 JSON' : '复制配置'}
          </Button>
        </div>
        <pre className="overflow-auto rounded border border-border bg-app p-2 font-mono text-xs text-fg">{mcpSnippet}</pre>
      </section>

      <section className="space-y-2 rounded-lg border border-border bg-panel p-4">
        <h3 className="font-medium text-fg-strong">已签发令牌</h3>
        {loading && tokens.length === 0 ? (
          <p className="text-xs text-fg-muted">正在加载令牌清单…</p>
        ) : tokens.length === 0 ? (
          <p className="text-xs text-fg-muted">暂无令牌。</p>
        ) : (
          <ul className="divide-y divide-border">
            {tokens.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs" data-testid={`pat-row-${t.id}`}>
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-fg-strong">{t.name}</span>
                    <code className="rounded bg-sunken px-1.5 py-0.5 font-mono text-fg-muted">{t.prefix}…</code>
                    {t.revoked_at && <span className="rounded bg-danger/10 px-1.5 py-0.5 text-danger">已吊销</span>}
                  </div>
                  <div className="text-fg-muted">
                    创建：{fmtTs(t.created_at)} · 最近使用：{fmtTs(t.last_used_at)}
                    {t.expires_at ? ` · 过期：${fmtTs(t.expires_at)}` : ''}
                  </div>
                </div>
                {!t.revoked_at && (
                  <Button
                    size="xs"
                    variant="ghost"
                    className="text-danger"
                    disabled={busy}
                    onClick={() => void handleRevoke(t.id)}
                    data-testid={`pat-revoke-${t.id}`}
                  >
                    <Trash2 aria-hidden className="size-3" /> 吊销
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ApiError } from '@/lib/api/net'

export interface PreflightItemBase {
  rule_id: string
  status: 'pass' | 'warn' | 'unknown'
  evidence: string
  source: string
}

export interface PreflightReportBase {
  ruleset_id: string
  ruleset_version: string
  generated_at: string
  parse_error?: string
  items: PreflightItemBase[]
}

export interface PreflightRulesetOption<TRuleset extends string> {
  id: TRuleset
  label: string
  hint: string
}

/** 状态徽章：通过 / 告警 / 无法判断（unknown 绝不冒充通过）。 */
function StatusBadge({ status }: { status: PreflightItemBase['status'] }) {
  if (status === 'pass') {
    return <span className="rounded bg-ok/10 px-1.5 py-0.5 text-xs text-ok">通过</span>
  }
  if (status === 'warn') {
    return <span className="rounded bg-warning/10 px-1.5 py-0.5 text-xs text-warning">告警</span>
  }
  return <span className="rounded bg-sunken px-1.5 py-0.5 text-xs text-fg-muted">无法判断</span>
}

export interface PreflightPanelProps<TRuleset extends string, TReport extends PreflightReportBase> {
  testIdPrefix: string
  description: string
  notRunText: string
  footerPrefix: string
  rulesets: readonly PreflightRulesetOption<TRuleset>[]
  defaultRuleset: TRuleset
  loadReport: (ruleset: TRuleset) => Promise<{ report: TReport; expired: boolean }>
  runReport: (ruleset: TRuleset) => Promise<{ report: TReport; expired: boolean }>
  canEdit: boolean
  runDisabled?: boolean
  runTitle?: string
  banner?: ReactNode
  expiredText: (report: TReport) => string
  renderMeta: (report: TReport) => ReactNode
  stalenessTrigger?: unknown
  isReportStale?: (report: TReport) => boolean
}

/** 投稿前检查公共面板（只读体检）：LaTeX 与 Word 共用乱序请求防护与统一渲染骨架。 */
export function PreflightPanel<TRuleset extends string, TReport extends PreflightReportBase>({
  testIdPrefix,
  description,
  notRunText,
  footerPrefix,
  rulesets,
  defaultRuleset,
  loadReport,
  runReport,
  canEdit,
  runDisabled = false,
  runTitle,
  banner,
  expiredText,
  renderMeta,
  stalenessTrigger,
  isReportStale,
}: PreflightPanelProps<TRuleset, TReport>) {
  const [ruleset, setRuleset] = useState<TRuleset>(defaultRuleset)
  const [report, setReport] = useState<TReport | null>(null)
  const [expired, setExpired] = useState(false)
  const [notRun, setNotRun] = useState(false)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  // 请求序号：GET/POST 共用——迟到的响应一律丢弃，防止旧 GET 覆盖新 POST
  const seqRef = useRef(0)

  const load = useCallback(async () => {
    const seq = ++seqRef.current
    setLoading(true)
    setError('')
    try {
      const body = await loadReport(ruleset)
      if (seq !== seqRef.current) return
      setReport(body.report)
      setExpired(body.expired)
      setNotRun(false)
    } catch (e) {
      if (seq !== seqRef.current) return
      if (e instanceof ApiError && e.status === 404) {
        setReport(null)
        setNotRun(true)
      } else {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      if (seq === seqRef.current) setLoading(false)
    }
  }, [loadReport, ruleset])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    if (!report || !isReportStale) return
    if (isReportStale(report)) {
      setExpired(true)
      void load()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stalenessTrigger])

  const run = useCallback(async () => {
    const seq = ++seqRef.current
    setRunning(true)
    setError('')
    try {
      const body = await runReport(ruleset)
      if (seq !== seqRef.current) return
      setReport(body.report)
      setExpired(body.expired)
      setNotRun(false)
    } catch (e) {
      if (seq !== seqRef.current) return
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (seq === seqRef.current) { setRunning(false); setLoading(false) }
    }
  }, [ruleset, runReport])

  const hint = rulesets.find((r) => r.id === ruleset)?.hint ?? ''
  const selectId = `${testIdPrefix}-ruleset`

  return (
    <div className="min-h-0 flex-1 overflow-auto px-2 py-2 text-xs" data-testid={`${testIdPrefix}-panel`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="flex items-center gap-1 text-fg-muted">
          <ShieldCheck aria-hidden className="size-3.5" />
          {description}
        </p>
        <Button
          size="xs"
          disabled={!canEdit || running || runDisabled}
          onClick={() => void run()}
          data-testid={`${testIdPrefix}-run`}
          title={runTitle ?? (!canEdit ? '当前账号无编辑权限' : undefined)}
        >
          {running ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : <RefreshCw aria-hidden className="size-3.5" />}
          运行检查
        </Button>
      </div>
      <div className="mb-2 flex items-center gap-1.5">
        <label className="shrink-0 text-fg-muted" htmlFor={selectId}>规则集</label>
        <select
          id={selectId}
          className="min-w-0 flex-1 rounded border border-line bg-panel px-1.5 py-0.5 text-xs"
          value={ruleset}
          onChange={(e) => setRuleset(e.target.value as TRuleset)}
          data-testid={selectId}
        >
          {rulesets.map((r) => (
            <option key={r.id} value={r.id}>{r.label}</option>
          ))}
        </select>
      </div>
      <p className="mb-2 text-fg-muted/80">{hint}</p>
      {banner}
      {error && <p className="mb-2 text-danger-fg" role="alert">{error}</p>}
      {loading && <p className="text-fg-muted"><Loader2 aria-hidden className="mr-1 inline size-3.5 animate-spin" />读取最近报告…</p>}
      {!loading && notRun && (
        <p className="text-fg-muted" data-testid={`${testIdPrefix}-notrun`}>{notRunText}</p>
      )}
      {!loading && report && (
        <div className="space-y-2">
          {expired && (
            <p className="rounded bg-warning/10 px-2 py-1 text-warning" data-testid={`${testIdPrefix}-expired`}>
              {expiredText(report)}
            </p>
          )}
          <div className="rounded border border-border px-2 py-1.5 text-fg-muted" data-testid={`${testIdPrefix}-meta`}>
            {renderMeta(report)}
          </div>
          <ul className="space-y-1.5" data-testid={`${testIdPrefix}-items`}>
            {report.items.map((item) => (
              <li key={item.rule_id} className="rounded border border-border px-2 py-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{item.rule_id}</span>
                  <StatusBadge status={item.status} />
                </div>
                <p className="mt-0.5 text-fg-muted">{item.evidence}</p>
                <p className="mt-0.5 text-fg-muted/70">依据：{item.source}</p>
              </li>
            ))}
          </ul>
          <p className="text-fg-muted/70">{footerPrefix} {report.generated_at}</p>
        </div>
      )}
    </div>
  )
}

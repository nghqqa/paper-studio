import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ApiError } from '@/lib/api/net'
import {
  latexApi,
  type LatexPreflightGet,
  type LatexPreflightItem,
  type LatexPreflightReport,
  type LatexPreflightRuleset,
} from '@/lib/api/latex'

/** 状态徽章：通过 / 告警 / 无法判断（unknown 绝不冒充通过）。 */
function StatusBadge({ status }: { status: LatexPreflightItem['status'] }) {
  if (status === 'pass') {
    return <span className="rounded bg-ok/10 px-1.5 py-0.5 text-xs text-ok">通过</span>
  }
  if (status === 'warn') {
    return <span className="rounded bg-warning/10 px-1.5 py-0.5 text-xs text-warning">告警</span>
  }
  return <span className="rounded bg-sunken px-1.5 py-0.5 text-xs text-fg-muted">无法判断</span>
}

/** 规则集（与后端 domain/latex_preflight.py RULESETS 同名同序）。 */
const RULESETS: { id: LatexPreflightRuleset; label: string; hint: string }[] = [
  {
    id: 'latex-general',
    label: '通用学术检查',
    hint: '通用投稿规范：TODO/FIXME/\\hl/?? 残留、未定义 \\cite/\\ref（工程源码索引对账）、未解决的手动 Issue。只读。',
  },
  {
    id: 'double-blind',
    label: '双盲匿名检查',
    hint: '双盲匿名审查：扫描非注释行的 \\author/\\thanks/\\affiliation/Acknowledgments、资助基金词与屏蔽词；% 注释行跳过。只读。',
  },
]

interface Props {
  pid: string
  canEdit: boolean
}

/** LaTeX 投稿前检查（只读体检）：不改源码、不调外部 AI；报告绑定源码内容指纹，过期如实提示。 */
export function LatexPreflight({ pid, canEdit }: Props) {
  const [ruleset, setRuleset] = useState<LatexPreflightRuleset>('latex-general')
  const [report, setReport] = useState<LatexPreflightReport | null>(null)
  const [expired, setExpired] = useState(false)
  const [notRun, setNotRun] = useState(false)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  // 请求序号：GET/POST 共用——迟到的响应一律丢弃（与 WordPreflightPanel 同款乱序防护）
  const seqRef = useRef(0)

  const load = useCallback(async () => {
    const seq = ++seqRef.current
    setLoading(true)
    setError('')
    try {
      const body: LatexPreflightGet = await latexApi.getPreflight(pid, ruleset)
      if (seq !== seqRef.current) return  // 迟到响应：已有更新的检查结果，忽略
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
  }, [pid, ruleset])

  useEffect(() => { void load() }, [load])

  const run = useCallback(async () => {
    const seq = ++seqRef.current
    setRunning(true)
    setError('')
    try {
      const body = await latexApi.runPreflight(pid, { ruleset })
      if (seq !== seqRef.current) return
      setReport(body.report)
      // 后端写报告前已核对当前源码指纹：过期如实返回（不无条件置 false）
      setExpired(body.expired)
      setNotRun(false)
    } catch (e) {
      if (seq !== seqRef.current) return
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (seq === seqRef.current) { setRunning(false); setLoading(false) }
    }
  }, [pid, ruleset])

  const hint = RULESETS.find((r) => r.id === ruleset)?.hint ?? ''

  return (
    <div className="min-h-0 flex-1 overflow-auto px-2 py-2 text-xs" data-testid="latex-preflight-panel">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="flex items-center gap-1 text-fg-muted">
          <ShieldCheck aria-hidden className="size-3.5" />
          只读投稿前检查；不修改源码、不调用外部 AI。
        </p>
        <Button
          size="xs"
          disabled={!canEdit || running}
          onClick={() => void run()}
          data-testid="latex-preflight-run"
          title={!canEdit ? '当前账号无编辑权限' : undefined}
        >
          {running ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : <RefreshCw aria-hidden className="size-3.5" />}
          运行检查
        </Button>
      </div>
      <div className="mb-2 flex items-center gap-1.5">
        <label className="shrink-0 text-fg-muted" htmlFor="latex-preflight-ruleset">规则集</label>
        <select
          id="latex-preflight-ruleset"
          className="min-w-0 flex-1 rounded border border-line bg-panel px-1.5 py-0.5 text-xs"
          value={ruleset}
          onChange={(e) => setRuleset(e.target.value as LatexPreflightRuleset)}
          data-testid="latex-preflight-ruleset"
        >
          {RULESETS.map((r) => (
            <option key={r.id} value={r.id}>{r.label}</option>
          ))}
        </select>
      </div>
      <p className="mb-2 text-fg-muted/80">{hint}</p>
      {error && <p className="mb-2 text-danger-fg" role="alert">{error}</p>}
      {loading && <p className="text-fg-muted"><Loader2 aria-hidden className="mr-1 inline size-3.5 animate-spin" />读取最近报告…</p>}
      {!loading && notRun && (
        <p className="text-fg-muted" data-testid="latex-preflight-notrun">当前规则集尚未运行检查。运行后会对当前已保存源码生成只读报告。</p>
      )}
      {!loading && report && (
        <div className="space-y-2">
          {expired && (
            <p className="rounded bg-warning/10 px-2 py-1 text-warning" data-testid="latex-preflight-expired">
              源文件已更新：以下报告绑定旧快照指纹，与当前工程不一致——请重新运行检查。
            </p>
          )}
          <div className="rounded border border-border px-2 py-1.5 text-fg-muted" data-testid="latex-preflight-meta">
            规则集 {report.ruleset_id}/{report.ruleset_version} · 扫描 {Object.keys(report.digest).length} 个源文件 · 指纹 {report.digest_sha.slice(0, 12)}
            {report.parse_error && <span className="text-warning">（解析异常：{report.parse_error}）</span>}
          </div>
          <ul className="space-y-1.5" data-testid="latex-preflight-items">
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
          <p className="text-fg-muted/70">报告为只读快照结果；源码变化后请重新运行。生成时间 {report.generated_at}</p>
        </div>
      )}
    </div>
  )
}

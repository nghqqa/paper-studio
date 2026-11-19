import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ApiError } from '@/lib/api/net'
import {
  wordApi,
  type WordPreflightGet,
  type WordPreflightItem,
  type WordPreflightReport,
  type WordPreflightRuleset,
} from '@/lib/api/word'

/** 状态徽章：通过 / 告警 / 无法判断（unknown 绝不冒充通过）。 */
function StatusBadge({ status }: { status: WordPreflightItem['status'] }) {
  if (status === 'pass') {
    return <span className="rounded bg-ok/10 px-1.5 py-0.5 text-xs text-ok">通过</span>
  }
  if (status === 'warn') {
    return <span className="rounded bg-warning/10 px-1.5 py-0.5 text-xs text-warning">告警</span>
  }
  return <span className="rounded bg-sunken px-1.5 py-0.5 text-xs text-fg-muted">无法判断</span>
}

/** 规则集注册表（与后端 domain/word_preflight.py RULESETS 同名同序）。 */
const RULESETS: { id: WordPreflightRuleset; label: string; hint: string }[] = [
  {
    id: 'jcip-preflight',
    label: '中文信息学报（jcip）',
    hint: '依据中文信息学报模板与通用投稿规范的只读检查；不修改正文、不自动接受修订。',
  },
  {
    id: 'cn-general',
    label: '通用中文论文',
    hint: '通用投稿规范：待办/占位残留、未处理修订、未关闭批注、正文引用与文献表对账。只读。',
  },
  {
    id: 'double-blind',
    label: '双盲匿名检查',
    hint: '双盲匿名审查：按项目设置 blind_terms（或运行时传入词表）扫描正文/页眉页脚/文档属性作者与基金残留。只读。',
  },
]

interface Props {
  pid: string
  canEdit: boolean
  saving: boolean
  /** 工作台轮询到的当前已保存快照 SHA——变化即标记旧报告过期并刷新（本轮审查问题 4）。 */
  stateSha?: string | null
  stateVersion?: number | null
}

/** 投稿前检查（多规则集，只读报告）：不改稿、不自动接受修订、不调外部 AI。 */
export function WordPreflightPanel({ pid, canEdit, saving, stateSha, stateVersion }: Props) {
  const [ruleset, setRuleset] = useState<WordPreflightRuleset>('jcip-preflight')
  const [report, setReport] = useState<WordPreflightReport | null>(null)
  const [expired, setExpired] = useState(false)
  const [notRun, setNotRun] = useState(false)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  // 请求序号：GET/POST 共用——迟到的响应一律丢弃，防止旧 GET 覆盖新 POST（本轮审查问题 4）
  const seqRef = useRef(0)

  const load = useCallback(async () => {
    const seq = ++seqRef.current
    setLoading(true)
    setError('')
    try {
      const body: WordPreflightGet = await wordApi.getPreflight(pid, ruleset)
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

  // 工作台保存完成（state SHA 变化）→ 立即标记旧报告过期并刷新当前快照元数据
  useEffect(() => {
    if (!report) return
    const stale = (stateSha != null && report.sha256 !== stateSha)
      || (stateVersion != null && report.version !== stateVersion)
    if (stale) {
      setExpired(true)
      void load()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateSha])

  const run = useCallback(async () => {
    const seq = ++seqRef.current
    setRunning(true)
    setError('')
    try {
      const body = await wordApi.runPreflight(pid, { ruleset })
      if (seq !== seqRef.current) return
      setReport(body.report)
      // 后端写报告时已核对当前快照：过期如实返回（不无条件置 false）
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
    <div className="min-h-0 flex-1 overflow-auto px-2 py-2 text-xs" data-testid="word-preflight-panel">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="flex items-center gap-1 text-fg-muted">
          <ShieldCheck aria-hidden className="size-3.5" />
          只读投稿前检查；不修改正文、不自动接受修订。
        </p>
        <Button
          size="xs"
          disabled={!canEdit || running || saving}
          onClick={() => void run()}
          data-testid="word-preflight-run"
          title={saving ? '文档服务正在回传文件，请等保存完成后再检查' : !canEdit ? '当前账号无编辑权限' : undefined}
        >
          {running ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : <RefreshCw aria-hidden className="size-3.5" />}
          运行检查
        </Button>
      </div>
      <div className="mb-2 flex items-center gap-1.5">
        <label className="shrink-0 text-fg-muted" htmlFor="word-preflight-ruleset">规则集</label>
        <select
          id="word-preflight-ruleset"
          className="min-w-0 flex-1 rounded border border-line bg-panel px-1.5 py-0.5 text-xs"
          value={ruleset}
          onChange={(e) => setRuleset(e.target.value as WordPreflightRuleset)}
          data-testid="word-preflight-ruleset"
        >
          {RULESETS.map((r) => (
            <option key={r.id} value={r.id}>{r.label}</option>
          ))}
        </select>
      </div>
      <p className="mb-2 text-fg-muted/80">{hint}</p>
      {saving && <p className="mb-2 text-fg-muted" data-testid="word-preflight-saving">文档服务正在回传文件——请等保存完成后再运行检查，避免对旧快照出报告。</p>}
      {error && <p className="mb-2 text-danger-fg" role="alert">{error}</p>}
      {loading && <p className="text-fg-muted"><Loader2 aria-hidden className="mr-1 inline size-3.5 animate-spin" />读取最近报告…</p>}
      {!loading && notRun && <p className="text-fg-muted" data-testid="word-preflight-notrun">当前规则集尚未运行检查。运行后会对当前已保存版本生成只读报告。</p>}
      {!loading && report && (
        <div className="space-y-2">
          {expired && (
            <p className="rounded bg-warning/10 px-2 py-1 text-warning" data-testid="word-preflight-expired">
              文档已更新：以下报告对应旧快照（版本 v{report.version}），与当前稿件不一致——请重新运行检查。
            </p>
          )}
          <div className="rounded border border-border px-2 py-1.5 text-fg-muted" data-testid="word-preflight-meta">
            保存版本 v{report.version} · 文件 SHA {report.sha256.slice(0, 12)} · 规则集 {report.ruleset_id}/{report.ruleset_version}
            {report.parse_error && <span className="text-warning">（解析失败：{report.parse_error}）</span>}
          </div>
          <ul className="space-y-1.5" data-testid="word-preflight-items">
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
          <p className="text-fg-muted/70">报告为只读快照结果；正文或保存状态变化后请重新运行。生成时间 {report.generated_at}</p>
        </div>
      )}
    </div>
  )
}

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle, BookOpen, CheckCircle2, ChevronDown, ChevronRight, CircleAlert, Download, Eraser, FilePlus2,
  Loader2, ListOrdered, Plus, Quote, RotateCw, Search, ShieldAlert, ShieldCheck, Sparkles, Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  libraryApi,
  type CitationVerifyItem,
  type CitationVerifyReport,
  type ImportReply,
  type LibraryEntry,
  type LibraryReply,
  type SourceCandidate,
  type ZoteroCollection,
  type ZoteroCredentials,
  type ZoteroGroup,
  type ZoteroImportSource,
  type ZoteroLibraryType,
  type ZoteroRefreshPreview,
} from '@/lib/api/library'
import { latexApi } from '@/lib/api/latex'

/**
 * 文献面板（v0.4）：列表/搜索/多选插入、导入（粘贴/上传）、外部查询（DOI/arXiv/关键词）、
 * 字段确认、编辑、合并去重、诊断、导出。
 * LaTeX 工程：.bib 是事实源——所有写操作经后端 base-sha 锁写回 bib；Word 工程：项目级文献清单。
 */

const errText = (e: unknown): string => {
  const anyErr = e as { message?: string; detail?: { message?: string } }
  return anyErr?.detail?.message || anyErr?.message || String(e)
}

const SOURCE_LABEL_FALLBACK: Record<string, string> = {
  user: '用户提供', bib: 'BibTeX 文件', crossref: 'Crossref', openalex: 'OpenAlex',
  arxiv: 'arXiv', ai_suggested: 'AI 建议（未验证）',
}

/** 引用样式（P1-0-A）：Word 模式可切换；LaTeX 模式不传相关 props，UI 零变化。 */
/** 引用样式（P1-0-A + B3 扩展）：与后端 word_citations.STYLES 白名单一一对应；默认 GB/T。 */
export type CitationStyle = 'gb-t-7714-2015' | 'ieee' | 'springer-lncs' | 'acm' | 'elsevier-vancouver'

export const CITATION_STYLE_LABELS: Record<CitationStyle, string> = {
  'gb-t-7714-2015': 'GB/T 7714-2015（默认）',
  'ieee': 'IEEE',
  'springer-lncs': 'Springer LNCS',
  'acm': 'ACM',
  'elsevier-vancouver': 'Elsevier Vancouver',
}

interface Props {
  pid: string
  canEdit: boolean
  /** @deprecated LaTeX 面板亦不再读取；保留 prop 兼容既有调用 */
  activePath?: string | null
  onInsertCitations: (entries: LibraryEntry[], command: string) => void
  reloadSignal?: number
  /** 文献库发生任何写变更（导入/编辑/删除/合并/改名）后回调——工作台刷新引用补全候选。 */
  onLibraryChanged?: () => void
  /** Word 模式：更新参考文献表（收集文档内引用 → 重渲染 → 插件写回）。 */
  onUpdateBibliography?: () => void
  bibliographyBusy?: boolean
  /** Word 模式：引用格式切换（默认 GB/T 7714-2015；LaTeX 不传 → 不渲染切换器）。 */
  citationStyle?: CitationStyle
  onCitationStyleChange?: (s: CitationStyle) => void
  /** Word 模式：定稿前清理托管标记（移除头/尾可见标记段，保留文献条目）。 */
  onStripBibMarkers?: () => void
  stripBibMarkersBusy?: boolean
  /** Word 模式：服务端按出现顺序重排全文引用编号（P1-0-B）；LaTeX 模式不传，UI 零变化。 */
  onRenumberCitations?: (style?: CitationStyle) => void | Promise<unknown>
  renumberBusy?: boolean
}

type Tab = 'list' | 'import' | 'diagnostics'

export function LibraryPanel({ pid, canEdit, onInsertCitations, reloadSignal = 0, onUpdateBibliography, bibliographyBusy = false, onLibraryChanged, citationStyle, onCitationStyleChange, onStripBibMarkers, stripBibMarkersBusy = false, onRenumberCitations, renumberBusy = false }: Props) {
  const [tab, setTab] = useState<Tab>('list')
  const [lib, setLib] = useState<LibraryReply | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<string | null>(null)
  const [citeCommand, setCiteCommand] = useState('')
  const [verifyReport, setVerifyReport] = useState<CitationVerifyReport | null>(null)
  const [verifyBusy, setVerifyBusy] = useState(false)

  const verifyMap = useMemo(() => {
    const m = new Map<string, CitationVerifyItem>()
    for (const it of verifyReport?.items ?? []) m.set(it.reference_id, it)
    return m
  }, [verifyReport])

  const loadVerifyCache = useCallback(async () => {
    try {
      const r = await libraryApi.getVerify(pid)
      if (r.total > 0) setVerifyReport(r)
    } catch { /* 旧接口无缓存时静默忽略 */ }
  }, [pid])

  const runFactCheck = useCallback(async () => {
    setVerifyBusy(true)
    setError('')
    try {
      const targetIds = selected.size > 0 ? Array.from(selected) : undefined
      const r = await libraryApi.runVerify(pid, targetIds)
      setVerifyReport(r)
      setNotice(
        `真实性核验完成：已核验 ${r.counts.verified} · 偏差 ${r.counts.mismatch} · 未检出 ${r.counts.unverified}`
        + (r.counts.retracted ? ` · 已撤稿 ${r.counts.retracted}` : '')
        + (r.truncated ? `（单次上限 ${r.max_batch} 条）` : ''),
      )
    } catch (e) {
      setError(errText(e))
    } finally {
      setVerifyBusy(false)
    }
  }, [pid, selected])

  const refresh = useCallback(async () => {
    setBusy(true)
    try {
      const reply = await libraryApi.get(pid)
      setLib(reply)
      setCiteCommand((cur) => cur || reply.cite_style?.command || 'cite')
      setError('')
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }, [pid])

  const afterChange = useCallback(async () => {
    await refresh()
    onLibraryChanged?.()
  }, [refresh, onLibraryChanged])


  useEffect(() => {
    void refresh()
    void loadVerifyCache()
  }, [refresh, loadVerifyCache, reloadSignal])

  const entries = lib?.entries ?? []
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return entries
    return entries.filter((e) =>
      e.citation_key.toLowerCase().includes(q)
      || (e.title ?? '').toLowerCase().includes(q)
      || e.authors.join(' ').toLowerCase().includes(q)
      || (e.year ?? '').includes(q))
  }, [entries, query])

  const selectedEntries = useMemo(
    () => entries.filter((e) => selected.has(e.reference_id)),
    [entries, selected],
  )

  const toggleSel = (rid: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(rid)) next.delete(rid)
      else next.add(rid)
      return next
    })
  }

  const insert = () => {
    if (!selectedEntries.length) return
    onInsertCitations(selectedEntries, citeCommand || 'cite')
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="library-panel">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-2 text-xs text-fg-muted">
        <BookOpen aria-hidden className="size-3.5" />
        文献
        <span>{entries.length}</span>
        {lib?.mode === 'bib' && <span className="text-2xs">来源：{lib.bib_files.join('、') || '（无 .bib）'}</span>}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-6 gap-1 px-1.5 text-2xs"
          disabled={verifyBusy || entries.length === 0}
          onClick={() => void runFactCheck()}
          data-testid="library-verify-btn"
          title="通过 Crossref / OpenAlex / arXiv 核验参考文献真实性（防 AI 幻觉）"
        >
          {verifyBusy ? <Loader2 aria-hidden className="size-3 animate-spin" /> : <ShieldCheck aria-hidden className="size-3" />}
          真实性核验
        </Button>
        <Button variant="ghost" size="sm" className="h-6 px-1.5" onClick={() => void refresh()} data-testid="library-refresh" title="重新解析 .bib">
          {busy ? <Loader2 aria-hidden className="size-3 animate-spin" /> : <RotateCw aria-hidden className="size-3" />}
        </Button>
      </div>
      <div className="flex flex-wrap shrink-0 items-center gap-x-1 gap-y-1 border-b border-line px-2 py-1 text-xs">
        <Seg
          options={['list', 'import', 'diagnostics'] as Tab[]}
          value={tab}
          onChange={setTab}
          labels={{ list: '文献列表', import: '导入', diagnostics: `诊断${diagCount(lib) ? `（${diagCount(lib)}）` : ''}` }}
        />
        <a className="ml-auto inline-flex items-center gap-0.5 py-0.5 text-fg-muted hover:text-fg" href={libraryApi.exportUrl(pid, 'bibtex')} data-testid="library-export-bib">
          <Download aria-hidden className="size-3" /> BibTeX
        </a>
        <a className="inline-flex items-center gap-0.5 py-0.5 text-fg-muted hover:text-fg" href={libraryApi.exportUrl(pid, 'csl-json')} data-testid="library-export-csl">
          <Download aria-hidden className="size-3" /> CSL-JSON
        </a>
      </div>
      {onUpdateBibliography && (
        <div className="shrink-0 space-y-1 border-b border-line px-2 py-1.5">
          <Button
            size="sm"
            className="h-8 w-full text-sm"
            onClick={onUpdateBibliography}
            disabled={bibliographyBusy || !canEdit}
            title="扫描正文 [n] 引用标记，按全局编号顺序重建文档末尾的参考文献表"
            data-testid="library-update-bibliography"
          >
            {bibliographyBusy ? <Loader2 aria-hidden className="size-3 animate-spin" /> : <BookOpen aria-hidden className="size-3" />}
            更新参考文献表
          </Button>
          {citationStyle && onCitationStyleChange && (
            <label className="flex items-center gap-1.5 text-xs text-fg-muted" data-testid="library-citation-style-row">
              引用格式
              <select
                className="rounded border border-line bg-app px-1 py-0.5 text-xs"
                value={citationStyle}
                onChange={(e) => onCitationStyleChange(e.target.value as CitationStyle)}
                data-testid="library-citation-style"
              >
                {(Object.keys(CITATION_STYLE_LABELS) as CitationStyle[]).map((s) => (
                <option key={s} value={s}>{CITATION_STYLE_LABELS[s]}</option>
              ))}</select>
            </label>
          )}
          {onRenumberCitations && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 w-full text-xs"
              onClick={() => void onRenumberCitations(citationStyle)}
              disabled={renumberBusy || !canEdit}
              title="服务端直接按正文首次出现顺序重排全文引用编号 [n]，同步重建托管参考文献表与文献顺序表（基于已保存版本执行，有变化时编辑器自动重载；标记异常/修订边界/越界编号将拒绝并提示）"
              data-testid="library-renumber-citations"
            >
              {renumberBusy ? <Loader2 aria-hidden className="size-3 animate-spin" /> : <ListOrdered aria-hidden className="size-3" />}
              按出现顺序重排引用
            </Button>
          )}
          {onStripBibMarkers && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 w-full text-xs"
              onClick={onStripBibMarkers}
              disabled={stripBibMarkersBusy || !canEdit}
              title="移除文末「[参考文献-平台生成]」与「（完）」两个托管标记段，格式化好的 [1] … 文献条目原样保留（定稿前清理，异常形态插件 fail-closed 拒绝）"
              data-testid="library-strip-bib-markers"
            >
              {stripBibMarkersBusy ? <Loader2 aria-hidden className="size-3 animate-spin" /> : <Eraser aria-hidden className="size-3" />}
              定稿前清理托管标记
            </Button>
          )}
        </div>
      )}
      {error && <div role="alert" className="shrink-0 border-b border-line px-2 py-1 text-xs text-danger" data-testid="library-error">{error}</div>}
      {notice && <div role="status" className="shrink-0 border-b border-line px-2 py-1 text-xs text-fg-muted" data-testid="library-notice">{notice}</div>}

      {tab === 'list' && (
        <>
          <div className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1">
            <Search aria-hidden className="size-3.5 shrink-0 text-fg-muted" />
            <input
              className="h-8 min-w-0 flex-1 rounded border border-line bg-panel px-2 text-sm"
              placeholder="搜索 标题 / 作者 / key / 年份"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              data-testid="library-search"
            />
          </div>
          {selectedEntries.length > 0 && (
            <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line bg-panel px-2 py-1.5 text-xs" data-testid="library-insert-bar">
              <span>已选 {selectedEntries.length} 篇</span>
              <select
                className="rounded border border-line bg-app px-1.5 py-1 text-xs"
                value={citeCommand}
                onChange={(e) => setCiteCommand(e.target.value)}
                data-testid="library-cite-command"
                title={lib?.cite_style ? `工程检测：${lib.cite_style.style}（来自 ${lib.cite_style.detected_from}）` : ''}
              >
                {(lib?.mode === 'bib' ? [
                  { v: 'cite', label: '\\cite' },
                  { v: 'citep', label: '\\citep（括号）' },
                  { v: 'citet', label: '\\citet（作者作主语）' },
                  { v: 'autocite', label: '\\autocite（biblatex）' },
                  { v: 'textcite', label: '\\textcite（biblatex）' },
                ] : [
                  { v: 'cite', label: '\\cite' },
                ]).map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
              </select>
              <Button size="sm" className="h-6 px-2" onClick={insert} data-testid="library-insert">
                <Quote aria-hidden className="size-3" /> 在光标处插入引用
              </Button>
              <Button variant="ghost" size="sm" className="h-6 px-1.5" onClick={() => setSelected(new Set())}>取消</Button>
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-auto p-1.5" data-testid="library-list">
            {filtered.length === 0 && (
              <div className="p-2 text-xs text-fg-muted">
                {entries.length === 0
                  ? lib?.mode === 'bib'
                    ? '工程暂无文献条目——切到「导入」粘贴 BibTeX，或用 DOI/arXiv 查询。'
                    : '项目暂无文献条目——切到「导入」添加。'
                  : '无匹配条目。'}
              </div>
            )}
            <ul className="space-y-1">
              {filtered.map((e) => (
                <li key={e.reference_id} className="rounded border border-line bg-panel text-sm">
                  <div className="flex items-start gap-2 p-2">
                    <input
                      type="checkbox"
                      className="mt-0.5 size-4 shrink-0 accent-primary"
                      checked={selected.has(e.reference_id)}
                      onChange={() => toggleSel(e.reference_id)}
                      aria-label={`选择 ${e.citation_key}`}
                      data-testid={`library-select-${e.citation_key}`}
                    />
                    <button className="min-w-0 flex-1 text-left" onClick={() => setExpanded(expanded === e.reference_id ? null : e.reference_id)}>
                      <span className="block truncate font-medium text-fg-strong" title={e.title}>
                        {e.title || `（无标题）${e.citation_key}`}
                      </span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-fg-muted">
                        <span className="truncate">{e.citation_key}</span>
                        {e.year && <span>· {e.year}</span>}
                        {e.venue && <span className="truncate">· {e.venue}</span>}
                        <VerifiedBadge entry={e} />
                        <FactCheckBadge item={verifyMap.get(e.reference_id)} />
                      </span>
                    </button>
                    <button className="shrink-0 p-0.5 text-fg-muted" onClick={() => setExpanded(expanded === e.reference_id ? null : e.reference_id)} aria-label="详情">
                      {expanded === e.reference_id ? <ChevronDown aria-hidden className="size-3.5" /> : <ChevronRight aria-hidden className="size-3.5" />}
                    </button>
                  </div>
                  {expanded === e.reference_id && (
                    <EntryDetail pid={pid} entry={e} canEdit={canEdit} sourceLabels={lib?.source_labels ?? SOURCE_LABEL_FALLBACK} onChanged={() => void afterChange()} onNotice={setNotice} onError={setError} entries={entries} />
                  )}
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      {tab === 'import' && (
        <ImportTab pid={pid} lib={lib} canEdit={canEdit} onDone={async (msg) => { setNotice(msg); await afterChange() }} onError={setError} />
      )}

      {tab === 'diagnostics' && <DiagnosticsTab lib={lib} onGoList={(rid) => { setExpanded(rid); setTab('list') }} />}
    </div>
  )
}

function FactCheckBadge({ item }: { item?: CitationVerifyItem }) {
  if (!item) return null
  if (item.status === 'verified') {
    return (
      <span className="inline-flex items-center gap-0.5 rounded bg-ok/10 px-1 text-ok" title={item.reason} data-testid={`factcheck-badge-${item.citation_key}`}>
        <ShieldCheck aria-hidden className="size-3" /> 源已核验
      </span>
    )
  }
  if (item.status === 'retracted') {
    return (
      <span className="inline-flex items-center gap-0.5 rounded bg-danger/10 px-1 text-danger" title={item.reason} data-testid={`factcheck-badge-${item.citation_key}`}>
        <ShieldAlert aria-hidden className="size-3" /> 权威源撤稿
      </span>
    )
  }
  if (item.status === 'mismatch') {
    const detail = item.diffs.map((d) => `${d.field}: ${d.local} → ${d.remote}`).join('; ')
    return (
      <span className="inline-flex items-center gap-0.5 rounded bg-warning/15 px-1 text-warning" title={`${item.reason}${detail ? ` (${detail})` : ''}`} data-testid={`factcheck-badge-${item.citation_key}`}>
        <AlertTriangle aria-hidden className="size-3" /> 字段偏差
      </span>
    )
  }
  if (item.status === 'unverified') {
    return (
      <span className="inline-flex items-center gap-0.5 rounded bg-danger/10 px-1 text-danger" title={item.reason} data-testid={`factcheck-badge-${item.citation_key}`}>
        <CircleAlert aria-hidden className="size-3" /> 未检出
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-0.5 rounded bg-sunken px-1 text-fg-muted" title={item.reason} data-testid={`factcheck-badge-${item.citation_key}`}>
      核验异常
    </span>
  )
}

function diagCount(lib: LibraryReply | null): number {
  if (!lib) return 0
  const d = lib.diagnostics
  return d.duplicate_keys.length + d.fuzzy_duplicates.length + d.missing_fields.length + d.undefined_in_tex.length + (d.parse_errors?.length ?? 0)
}

function VerifiedBadge({ entry }: { entry: LibraryEntry }) {
  if (entry.retraction?.status === 'retracted') {
    return <span className="inline-flex items-center gap-0.5 rounded bg-danger/10 px-1 text-danger" title="来源记录显示已撤稿"><ShieldAlert aria-hidden className="size-3" /> 已撤稿</span>
  }
  if (entry.verified === 'verified') {
    return <span className="inline-flex items-center gap-0.5 text-ok" title="字段已人工确认"><CheckCircle2 aria-hidden className="size-3" /></span>
  }
  return <span className="text-fg-muted" title="未验证：仅表示尚未经外部来源/人工确认，不代表文献不存在">未验证</span>
}

function EntryDetail({ pid, entry, canEdit, sourceLabels, onChanged, onNotice, onError, entries }: {
  pid: string
  entry: LibraryEntry
  canEdit: boolean
  sourceLabels: Record<string, string>
  onChanged: () => Promise<void> | void
  onNotice: (s: string) => void
  onError: (s: string) => void
  entries: LibraryEntry[]
}) {
  const [busy, setBusy] = useState(false)
  const [lookupResult, setLookupResult] = useState<{ candidates: SourceCandidate[] } | null>(null)
  const [lookupBusy, setLookupBusy] = useState(false)
  const [lookupErr, setLookupErr] = useState('')
  const [mergeWith, setMergeWith] = useState('')
  const [fieldPicks, setFieldPicks] = useState<Record<string, 'survivor' | 'loser'>>({})
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [editing, setEditing] = useState(false)

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      onError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const doLookup = (kind: 'doi' | 'arxiv' | 'query') =>
    run(async () => {
      setLookupBusy(true)
      setLookupErr('')
      try {
        const body = kind === 'doi' ? { doi: entry.doi ?? '', reference_id: entry.reference_id }
          : kind === 'arxiv' ? { arxiv: entry.arxiv_id ?? '', reference_id: entry.reference_id }
            : { query: entry.title, reference_id: entry.reference_id }
        if ((kind === 'doi' && !entry.doi) || (kind === 'arxiv' && !entry.arxiv_id)) {
          setLookupErr(kind === 'doi' ? '该条目没有 DOI 字段' : '该条目没有 arXiv 标识')
          return
        }
        const r = await libraryApi.lookup(pid, body)
        setLookupResult(r)
      } catch (e) {
        setLookupErr(errText(e))
      } finally {
        setLookupBusy(false)
      }
    })

  const diffSameCount = (c: SourceCandidate) => (c.diff ?? []).filter((d) => !d.same).length

  return (
    <div className="border-t border-line px-2 py-1.5 text-xs" data-testid={`library-detail-${entry.citation_key}`}>
      {/* 逐字段 + provenance */}
      <table className="w-full">
        <tbody>
          {([
            ['citation_key', 'Key'], ['title', '标题'], ['author', '作者'], ['year', '年份'],
            ['venue', '期刊/会议'], ['volume', '卷'], ['number', '期'], ['pages', '页码'],
            ['publisher', '出版社'], ['doi', 'DOI'], ['eprint', 'arXiv'], ['url', 'URL'],
          ] as const).map(([f, label]) => {
            const value = f === 'author' ? entry.authors.join(' and ')
              : f === 'venue' ? (entry.venue ?? '')
                : f === 'eprint' ? (entry.arxiv_id ?? '')
                  : (entry as unknown as Record<string, string | null>)[f] ?? entry.fields[f] ?? ''
            if (!value) return null
            const pv = entry.field_provenance[f]
            const suggested = entry.suggested?.[f]
            return (
              <tr key={f} className="align-top">
                <td className="w-16 shrink-0 py-0.5 text-fg-muted">{label}</td>
                <td className="py-0.5">
                  <span className="break-all">{String(value)}</span>
                  {pv && (
                    <span className={cn('ml-1 rounded px-1 text-2xs', pv.confirmed ? 'bg-ok/10 text-ok' : 'bg-sunken text-fg-muted')}
                      title={pv.confirmed ? '已人工确认' : '来源字段（未逐项确认）'}>
                      {sourceLabels[pv.source] ?? SOURCE_LABEL_FALLBACK[pv.source] ?? pv.source}{pv.confirmed ? '·已确认' : ''}
                    </span>
                  )}
                  {suggested && (
                    <span className="ml-1 text-warning" title={`AI 建议（${entry.suggested_model ?? ''}）：${suggested}`}>
                      <Sparkles aria-hidden className="mr-0.5 inline size-3" />AI建议：{suggested}
                    </span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {entry.retraction && (
        <div className={cn('mt-1 rounded px-1.5 py-1', entry.retraction.status === 'retracted' ? 'bg-danger/10 text-danger' : 'bg-sunken text-fg-muted')} data-testid={`library-retraction-${entry.citation_key}`}>
          {entry.retraction.status === 'retracted' && '⚠ 来源记录显示该文献已撤稿'}
          {entry.retraction.status === 'corrected' && '来源记录显示有更正版本'}
          {entry.retraction.status === 'unknown' && '撤稿状态：未知（未查询到撤稿记录 ≠ 已证明未撤稿）'}
          {entry.retraction.source && <span className="ml-1">（来源：{entry.retraction.source}）</span>}
        </div>
      )}
      {entry.raw_bibtex && (
        <details className="mt-1">
          <summary className="cursor-pointer text-fg-muted">原始 BibTeX</summary>
          <pre className="mt-1 max-h-40 overflow-auto rounded bg-app p-1.5 text-2xs leading-4">{entry.raw_bibtex}</pre>
        </details>
      )}

      {/* 外部查询（ viewer 也可发起；写操作按 canEdit 禁用） */}
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <Button variant="outline" size="xs" disabled={lookupBusy} onClick={() => void doLookup('doi')} data-testid={`library-lookup-doi-${entry.citation_key}`}>
          {lookupBusy ? <Loader2 aria-hidden className="size-3 animate-spin" /> : <Search aria-hidden className="size-3" />} DOI 核对
        </Button>
        <Button variant="outline" size="xs" disabled={lookupBusy || !entry.arxiv_id} onClick={() => void doLookup('arxiv')} title={entry.arxiv_id ? '' : '该条目无 arXiv 标识'}>
          arXiv 核对
        </Button>
        <Button variant="outline" size="xs" disabled={lookupBusy || !entry.title} onClick={() => void doLookup('query')} title="按标题搜索候选（不自动落盘）">
          搜索比对
        </Button>
        {canEdit && entry.verified !== 'verified' && (
          <Button size="xs" disabled={busy} onClick={() => void run(async () => {
            await libraryApi.confirm(pid, entry.reference_id, [])
            onNotice('已确认整条（对匹配结果负责）')
            await onChanged()
          })} data-testid={`library-confirm-${entry.citation_key}`}>
            <CheckCircle2 aria-hidden className="size-3" /> 确认整条
          </Button>
        )}
        {canEdit && Object.keys(entry.suggested ?? {}).length > 0 && (
          <Button size="xs" disabled={busy} onClick={() => void run(async () => {
            await libraryApi.confirm(pid, entry.reference_id, Object.keys(entry.suggested ?? {}))
            onNotice('AI 建议字段已标记确认')
            await onChanged()
          })}>确认 AI 建议</Button>
        )}
        {canEdit && (
          <>
            <Button variant="ghost" size="xs" disabled={busy} onClick={() => void run(async () => {
              const r = await libraryApi.aiSuggest(pid, entry.reference_id)
              onNotice(r.note ?? '')
              await onChanged()
            })} title="AI 补全缺失字段（仅建议层，需确认）">
              <Sparkles aria-hidden className="size-3" /> AI 补全
            </Button>
            <Button variant="ghost" size="xs" disabled={busy} onClick={() => setEditing((v) => !v)}>
              编辑
            </Button>
          </>
        )}
      </div>
      {lookupErr && <div role="alert" className="mt-1 text-danger">{lookupErr}</div>}
      {lookupResult && (
        <div className="mt-1 rounded border border-line bg-app p-1.5" data-testid={`library-lookup-result-${entry.citation_key}`}>
          <div className="mb-1 text-fg-muted">候选（{lookupResult.candidates.length}）——仅展示，确认后才落盘：</div>
          {lookupResult.candidates.length === 0 && <div className="text-fg-muted">无候选。</div>}
          {lookupResult.candidates.map((c, i) => (
            <div key={i} className="mb-1 border-b border-line pb-1 last:border-0">
              <div className="font-medium">{String(c.candidate.fields.title ?? '（无标题）')}</div>
              <div className="text-fg-muted">
                {String(c.candidate.fields.authors ?? '')} · {String(c.candidate.fields.year ?? '')} · {String(c.candidate.fields.venue ?? '')} · 来源 {c.candidate.source}
              </div>
              {(c.diff ?? []).some((d) => !d.same) && (
                <ul className="mt-0.5 space-y-0.5">
                  {(c.diff ?? []).filter((d) => !d.same).map((d) => (
                    <li key={d.field} className="text-warning">字段 {d.field} 不一致：当前「{d.current}」 ↔ 来源「{d.source}」</li>
                  ))}
                </ul>
              )}
              {(c.diff ?? []).length > 0 && diffSameCount(c) === 0 && <div className="mt-0.5 text-ok">已有字段与来源一致。</div>}
              {canEdit && (
                <Button size="xs" className="mt-1" disabled={busy} onClick={() => void run(async () => {
                  // 用来源值更新本地字段（经 PATCH 写回事实源；provenance=crossref/arxiv 等）
                  const f = c.candidate.fields
                  const patch: Record<string, string> = {}
                  if (f.pages) patch.pages = String(f.pages)
                  if (f.volume) patch.volume = String(f.volume)
                  if (f.venue && !entry.venue) patch.venue = String(f.venue)
                  if (f.abstract && !entry.abstract) patch.abstract = String(f.abstract)
                  if (!Object.keys(patch).length) { onNotice('来源没有可补充的字段'); return }
                  await libraryApi.editEntry(pid, entry.reference_id, patch)
                  onNotice('已按来源补充缺失字段')
                  await onChanged()
                })}>按来源补全缺失字段</Button>
              )}
            </div>
          ))}
        </div>
      )}

      {editing && canEdit && (
        <div className="mt-1.5 rounded border border-line bg-app p-1.5">
          {(['title', 'year', 'venue', 'pages', 'volume', 'number', 'doi', 'publisher'] as const).map((f) => (
            <label key={f} className="mb-1 flex items-center gap-1.5">
              <span className="w-12 shrink-0 text-fg-muted">{f}</span>
              <input
                className="min-w-0 flex-1 rounded border border-line bg-panel px-1 py-0.5"
                defaultValue={f === 'venue' ? entry.venue ?? '' : (entry as unknown as Record<string, string | null>)[f] ?? ''}
                onChange={(ev) => setEdits((prev) => ({ ...prev, [f]: ev.target.value }))}
                data-testid={`library-edit-${f}`}
              />
            </label>
          ))}
          <div className="flex gap-1">
            <Button size="xs" disabled={busy} onClick={() => void run(async () => {
              if (!Object.keys(edits).length) { setEditing(false); return }
              await libraryApi.editEntry(pid, entry.reference_id, edits)
              onNotice('字段已写回 .bib')
              setEditing(false)
              setEdits({})
              await onChanged()
            })} data-testid="library-edit-save">保存修改</Button>
            <Button variant="ghost" size="xs" onClick={() => { setEditing(false); setEdits({}) }}>取消</Button>
          </div>
        </div>
      )}

      {/* 合并去重 */}
      {canEdit && entries.length > 1 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1 rounded bg-sunken px-1.5 py-1">
          <span className="text-fg-muted">合并（本条为主）：</span>
          <select className="rounded border border-line bg-app px-1 py-0.5" value={mergeWith} onChange={(e) => setMergeWith(e.target.value)} data-testid={`library-merge-select-${entry.citation_key}`}>
            <option value="">选择重复条目…</option>
            {entries.filter((o) => o.reference_id !== entry.reference_id).map((o) => (
              <option key={o.reference_id} value={o.reference_id}>{o.citation_key} — {(o.title ?? '').slice(0, 30)}</option>
            ))}
          </select>
          {mergeWith && (() => {
            const other = entries.find((o) => o.reference_id === mergeWith)
            const fields = ['title', 'author', 'year', 'venue', 'pages', 'volume', 'doi', 'publisher']
            return (
              <span className="flex flex-wrap items-center gap-1">
                {fields.map((f) => {
                  const a = f === 'author' ? entry.authors.join(' and ') : f === 'venue' ? entry.venue ?? '' : (entry as unknown as Record<string, string | null>)[f] ?? ''
                  const b = other ? (f === 'author' ? other.authors.join(' and ') : f === 'venue' ? other.venue ?? '' : (other as unknown as Record<string, string | null>)[f] ?? '') : ''
                  if (!a || !b || a === b) return null
                  return (
                    <label key={f} className="flex items-center gap-0.5 text-2xs" title={`主：${a} / 副：${b}`}>
                      {f}
                      <select className="rounded border border-line bg-app" value={fieldPicks[f] ?? 'survivor'} onChange={(e) => setFieldPicks((p) => ({ ...p, [f]: e.target.value as 'survivor' | 'loser' }))}>
                        <option value="survivor">本条</option>
                        <option value="loser">对方</option>
                      </select>
                    </label>
                  )
                })}
                <Button size="xs" disabled={busy} onClick={() => void run(async () => {
                  const other = entries.find((o) => o.reference_id === mergeWith)
                  if (!other) return
                  // 影响预览：正文引用了对方 key 的文件（后端在 merge 时统一改名）
                  await libraryApi.merge(pid, {
                    survivor_rid: entry.reference_id,
                    loser_rid: other.reference_id,
                    field_choices: fieldPicks,
                    tex_updates: [],
                  })
                  onNotice('已合并（重复条目移除；如需改正文引用键请用「改名」）')
                  setMergeWith('')
                  setFieldPicks({})
                  await onChanged()
                })} data-testid={`library-merge-do-${entry.citation_key}`}>执行合并</Button>
              </span>
            )
          })()}
        </div>
      )}

      {canEdit && (
        <Button variant="ghost" size="xs" className="mt-1 text-danger" disabled={busy} onClick={() => void run(async () => {
          if (!window.confirm(`从文献库删除 ${entry.citation_key}？（会从 .bib 移除该条目）`)) return
          await libraryApi.deleteEntry(pid, entry.reference_id)
          onNotice('条目已删除')
          await onChanged()
        })} data-testid={`library-delete-${entry.citation_key}`}>
          <Trash2 aria-hidden className="size-3" /> 删除条目
        </Button>
      )}
    </div>
  )
}

function ImportTab({ pid, lib, canEdit, onDone, onError }: {
  pid: string
  lib: LibraryReply | null
  canEdit: boolean
  onDone: (msg: string) => Promise<void>
  onError: (s: string) => void
}) {
  const [text, setText] = useState('')
  const [preview, setPreview] = useState<ImportReply | null>(null)
  const [busy, setBusy] = useState(false)
  const [targets, setTargets] = useState<Set<number>>(new Set())
  const [targetBib, setTargetBib] = useState('')
  const [newBibName, setNewBibName] = useState('')
  const [renames, setRenames] = useState<Record<number, string>>({})
  // Zotero 公开群组导入（v0.5）：群组/集合 → 复用同一预览确认流；commit 带 provider 记录
  const [zotOpen, setZotOpen] = useState(false)
  const [zotGroupInput, setZotGroupInput] = useState('')
  const [zotGroup, setZotGroup] = useState<ZoteroGroup | null>(null)
  const [zotCollections, setZotCollections] = useState<ZoteroCollection[]>([])
  const [zotCollectionKey, setZotCollectionKey] = useState('')
  const [zotSource, setZotSource] = useState<ZoteroImportSource | null>(null)
  const [zotBusy, setZotBusy] = useState(false)
  // Zotero v2（B2）：库类型/私有库授权/一键刷新
  const [zotLibType, setZotLibType] = useState<ZoteroLibraryType>('group')
  const [zotUserId, setZotUserId] = useState('')
  const [zotCredOpen, setZotCredOpen] = useState(false)
  const [zotCred, setZotCred] = useState<ZoteroCredentials | null>(null)
  const [zotCredKey, setZotCredKey] = useState('')
  const [zotCredUid, setZotCredUid] = useState('')
  const [zotCredBusy, setZotCredBusy] = useState(false)
  const [refresh, setRefresh] = useState<ZoteroRefreshPreview | null>(null)
  // 刷新三栏勾选：added 按序号 / updated 按序号 / removals 按 rid
  const [refreshSel, setRefreshSel] = useState<{ additions: Set<number>; updates: Set<number>; removals: Set<string>; removeFromOrder: boolean }>(
    () => ({ additions: new Set(), updates: new Set(), removals: new Set(), removeFromOrder: false }))

  const bibFiles = lib?.bib_files ?? []
  useEffect(() => {
    if (!targetBib && bibFiles.length) setTargetBib(bibFiles[0])
  }, [bibFiles, targetBib])

  const doPreview = async (raw?: string) => {
    const payload = raw ?? text
    if (!payload.trim()) return
    setBusy(true)
    try {
      const r = await libraryApi.import(pid, payload)
      setPreview(r)
      setZotSource(null)
      setTargets(new Set(r.entries.map((_, i) => i)))
    } catch (e) {
      onError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const zotLoadCollections = async () => {
    const raw = zotGroupInput.trim()
    if (zotBusy) return
    if (zotLibType === 'group' ? !raw : !zotUserId.trim()) return
    setZotBusy(true)
    try {
      const r = await libraryApi.zoteroCollections(pid, raw, zotLibType, zotUserId.trim() || null)
      setZotGroup(r.group)
      setZotCollections(r.collections)
      setZotCollectionKey('')
      onError('')
    } catch (e) {
      onError(errText(e))
    } finally {
      setZotBusy(false)
    }
  }

  const zotPreview = async () => {
    if (!zotGroup || zotBusy) return
    setZotBusy(true)
    try {
      const r = await libraryApi.zoteroPreview(pid, String(zotGroup.id), zotCollectionKey || null,
                                               zotLibType, zotUserId.trim() || null)
      setPreview(r)
      // 以服务端清洗后的 source 为准写回锚点（library_type / zotero_user_id）
      setZotSource({ provider: 'zotero', group_id: r.source.group_id, collection_key: r.source.collection_key,
                     group_name: r.group.name, library_type: r.source.library_type,
                     zotero_user_id: r.source.zotero_user_id })
      setRefresh(null)
      setTargets(new Set(r.entries.map((_, i) => i)))
      onError('')
    } catch (e) {
      onError(errText(e))
    } finally {
      setZotBusy(false)
    }
  }

  /** B2 修补：挂载即恢复最近一次可刷新来源（重开工程「刷新此来源」直接可用）。 */
  useEffect(() => {
    if (!zotSource) {
      libraryApi.zoteroImports(pid).then((r) => {
        const latest = r.latest_refreshable
        if (!latest) return
        setZotSource({
          provider: 'zotero',
          group_id: (latest.group_id as number | null) ?? null,
          collection_key: (latest.collection_key as string | null) ?? null,
          group_name: (latest.group_name as string) || '',
          library_type: ((latest.library_type as ZoteroLibraryType) || 'group'),
          zotero_user_id: (latest.zotero_user_id as string | null) ?? null,
        })
      }).catch(() => { /* 回显失败静默（旧镜像无端点），不影响手动导入 */ })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid])

  /** B2 v2：私有库授权弹层（masked 显示 + 留空保留 + 清除）。 */
  const zotLoadCreds = async () => {
    setZotCredOpen((v) => !v)
    try {
      const r = await libraryApi.zoteroCredentials()
      setZotCred(r.credentials)
      setZotCredUid(r.credentials.zotero_user_id ?? '')
      setZotCredKey('')
    } catch (e) {
      onError(errText(e))
    }
  }

  const zotSaveCreds = async () => {
    if (zotCredBusy) return
    setZotCredBusy(true)
    try {
      const r = await libraryApi.saveZoteroCredentials(zotCredKey.trim(), zotCredUid.trim())
      setZotCred(r.credentials)
      setZotCredUid(r.credentials.zotero_user_id ?? '')
      setZotCredKey('')
      onError('')
      onDone?.('Zotero API Key 已保存（明文不再显示）')
    } catch (e) {
      onError(errText(e))
    } finally {
      setZotCredBusy(false)
    }
  }

  const zotClearCreds = async () => {
    if (zotCredBusy || !confirm('确认清除已保存的 Zotero API Key？')) return
    setZotCredBusy(true)
    try {
      const r = await libraryApi.clearZoteroCredentials()
      setZotCred(r.credentials)
      setZotCredUid(''); setZotCredKey('')
      onError('')
    } catch (e) {
      onError(errText(e))
    } finally {
      setZotCredBusy(false)
    }
  }

  /** B2 v2：一键刷新（预览 → 三栏勾选 → 提交）。 */
  const zotRefreshPreview = async () => {
    const src = zotSource
    if (!src || zotBusy) return
    setZotBusy(true)
    try {
      const r = await libraryApi.zoteroRefreshPreview(pid, src)
      setRefresh(r)
      setRefreshSel({ additions: new Set(r.added.map((_e, i) => i)),
                      updates: new Set<number>(), removals: new Set<string>(), removeFromOrder: false })
      onError('')
    } catch (e) {
      onError(errText(e))
    } finally {
      setZotBusy(false)
    }
  }

  const zotRefreshCommit = async () => {
    const src = zotSource
    const data = refresh
    if (!src || !data || zotBusy) return
    setZotBusy(true)
    try {
      let baseSha: string | null = null
      if (data.mode === 'bib') {
        const f = await latexApi.read(pid, targetBib)
        baseSha = f.sha
      }
      const r = await libraryApi.zoteroRefreshCommit(pid, src, {
        additions: data.added.filter((_e, i) => refreshSel.additions.has(i)),
        updates: data.updated.filter((_u, i) => refreshSel.updates.has(i))
          .map((u) => ({ reference_id: u.reference_id, entry: u.entry })),
        removals: [...refreshSel.removals],
        remove_from_citation_order: refreshSel.removeFromOrder,
        target_bib: data.mode === 'bib' ? targetBib : null,
        base_sha: baseSha,
      })
      await onDone(`刷新已提交：新增 ${r.applied.added}、更新 ${r.applied.updated}、移除 ${r.applied.removed}`)
      setRefresh(null)
    } catch (e) {
      onError(errText(e))
    } finally {
      setZotBusy(false)
    }
  }

  const doCommit = async () => {
    if (!preview) return
    setBusy(true)
    try {
      const chosen = preview.entries.filter((_e, i) => targets.has(i))
      if (!chosen.length) return
      const entries = chosen.map((e) => {
        const origIdx = preview.entries.indexOf(e)
        const key = renames[origIdx] || e.citation_key
        return { ...e, citation_key: key }
      })
      let baseSha: string | null = null
      if (lib?.mode === 'bib') {
        const f = await latexApi.read(pid, targetBib)
        baseSha = f.sha
      }
      const r = await libraryApi.commit(pid, entries as unknown as Record<string, unknown>[], lib?.mode === 'bib' ? targetBib : null, baseSha, zotSource ?? undefined)
      await onDone(`已导入 ${r.reference_ids.length} 条${zotSource ? `（来自 Zotero「${zotSource.group_name}」）` : ''}到 ${lib?.mode === 'bib' ? targetBib : '项目文献清单'}`)
      setPreview(null)
      setText('')
      setZotSource(null)
    } catch (e) {
      onError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const createBib = async () => {
    const name = newBibName.trim().endsWith('.bib') ? newBibName.trim() : `${newBibName.trim()}.bib`
    if (!name || name === '.bib') return
    setBusy(true)
    try {
      const r = await libraryApi.newBibFile(pid, name)
      await onDone(`已创建 ${r.path}（记得在正文 \\bibliography{...} 中引用它）`)
      setTargetBib(name)
      setNewBibName('')
    } catch (e) {
      onError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto p-2 text-xs" data-testid="library-import">
      <div className="mb-1 text-fg-muted">粘贴 BibTeX 或 GB/T 7714 引文文本（每行一条，如 Google Scholar 引用导出；或选择 .bib 文件）——解析预览逐条报错，确认后才写入：</div>
      <textarea
        className="h-32 w-full rounded border border-line bg-panel p-1.5 font-mono text-2xs"
        placeholder={'@article{key2020,\n  title = {…},\n  author = {…},\n  year = {2020}\n}'}
        value={text}
        onChange={(e) => setText(e.target.value)}
        data-testid="library-import-text"
      />
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        <Button size="sm" className="h-6 px-2" disabled={busy || !text.trim()} onClick={() => void doPreview()} data-testid="library-import-preview">
          {busy ? <Loader2 aria-hidden className="size-3 animate-spin" /> : <Plus aria-hidden className="size-3" />} 解析预览
        </Button>
        <label className="cursor-pointer rounded border border-line px-1.5 py-0.5 hover:bg-hover">
          上传 .bib
          <input type="file" accept=".bib,text/plain" className="hidden" onChange={(e) => {
            const file = e.target.files?.[0]
            if (!file) return
            void file.text().then((t) => { setText(t); return doPreview(t) })
          }} />
        </label>
        <button
          type="button"
          className="flex items-center gap-1 rounded border border-line px-1.5 py-0.5 transition-colors hover:bg-hover"
          aria-expanded={zotOpen}
          onClick={() => setZotOpen((v) => !v)}
          data-testid="library-zotero-toggle"
        >
          <BookOpen aria-hidden className="size-3" /> 从 Zotero 群组导入
          {zotOpen ? <ChevronDown aria-hidden className="size-3" /> : <ChevronRight aria-hidden className="size-3" />}
        </button>
      </div>

      {zotOpen && (
        <div className="mt-1 rounded border border-line bg-panel p-2" data-testid="library-zotero">
          <div className="flex flex-wrap items-center gap-1.5">
            <select
              className="rounded border border-line bg-app px-1 py-0.5"
              value={zotLibType}
              onChange={(e) => { setZotLibType(e.target.value as ZoteroLibraryType); setZotGroup(null); setZotCollections([]); setRefresh(null) }}
              data-testid="library-zotero-libtype"
            >
              <option value="group">公开群组</option>
              <option value="user">个人库（需 API Key）</option>
            </select>
            {zotLibType === 'group' ? (
              <input
                className="w-56 rounded border border-line bg-app px-1.5 py-0.5"
                placeholder="群组 ID 或 zotero.org/groups/<id> 链接"
                value={zotGroupInput}
                onChange={(e) => setZotGroupInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void zotLoadCollections() }}
                data-testid="library-zotero-group"
              />
            ) : (
              <input
                className="w-40 rounded border border-line bg-app px-1.5 py-0.5"
                placeholder="Zotero userID（数字）"
                value={zotUserId}
                onChange={(e) => setZotUserId(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void zotLoadCollections() }}
                data-testid="library-zotero-userid"
              />
            )}
            <Button size="sm" variant="secondary" className="h-6 px-2"
              disabled={zotBusy || (zotLibType === 'group' ? !zotGroupInput.trim() : !zotUserId.trim())}
              onClick={() => void zotLoadCollections()} data-testid="library-zotero-fetch">
              {zotBusy ? <Loader2 aria-hidden className="size-3 animate-spin" /> : <RotateCw aria-hidden className="size-3" />} 拉取
            </Button>
            <Button size="sm" variant="secondary" className="h-6 px-2" onClick={() => void zotLoadCreds()}
              aria-expanded={zotCredOpen} data-testid="library-zotero-cred-toggle">
              <ShieldAlert aria-hidden className="size-3" /> 私有库授权
            </Button>
            {zotGroup && <span className="text-fg-muted">「{zotGroup.name}」</span>}
          </div>
          {zotCredOpen && (
            <div className="mt-1.5 rounded border border-line bg-app p-2" data-testid="library-zotero-cred">
              {zotCred?.has_api_key
                ? <p className="text-2xs text-fg-muted">已保存 Key（{zotCred.api_key_hint}）——留空表示保留原值</p>
                : <p className="text-2xs text-fg-muted">在 zotero.org/settings/keys 创建只读 Key 并填入；明文只提交一次，不再显示</p>}
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <input type="password" autoComplete="new-password" className="w-56 rounded border border-line bg-app px-1.5 py-0.5"
                  placeholder="Zotero API Key（留空 = 保留已存）" value={zotCredKey}
                  onChange={(e) => setZotCredKey(e.target.value)} data-testid="library-zotero-cred-key" />
                <input className="w-32 rounded border border-line bg-app px-1.5 py-0.5" placeholder="userID（数字）"
                  value={zotCredUid} onChange={(e) => setZotCredUid(e.target.value)} data-testid="library-zotero-cred-uid" />
                <Button size="sm" className="h-6 px-2" disabled={zotCredBusy}
                  onClick={() => void zotSaveCreds()} data-testid="library-zotero-cred-save">保存</Button>
                <Button size="sm" variant="secondary" className="h-6 px-2" disabled={zotCredBusy || !zotCred?.has_api_key}
                  onClick={() => void zotClearCreds()} data-testid="library-zotero-cred-clear">清除</Button>
              </div>
            </div>
          )}
          {zotGroup && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <select
                className="rounded border border-line bg-app px-1 py-0.5"
                value={zotCollectionKey}
                onChange={(e) => setZotCollectionKey(e.target.value)}
                data-testid="library-zotero-collection"
              >
                <option value="">全部条目（顶层）</option>
                {zotCollections.map((col) => (
                  <option key={col.key} value={col.key}>
                    {col.parent ? `└ ${col.name}` : col.name}
                  </option>
                ))}
              </select>
              <Button size="sm" className="h-6 px-2" disabled={zotBusy} onClick={() => void zotPreview()} data-testid="library-zotero-preview">
                {zotBusy ? <Loader2 aria-hidden className="size-3 animate-spin" /> : <Plus aria-hidden className="size-3" />} 预览条目
              </Button>
              <span className="text-2xs text-fg-muted">公开群组免授权；私有库在「私有库授权」配置 Key。导入或刷新走下方流程。</span>
            </div>
          )}
          {zotSource && (
            <div className="mt-1.5">
              <Button size="sm" variant="secondary" className="h-6 px-2" disabled={zotBusy}
                onClick={() => void zotRefreshPreview()} data-testid="library-zotero-refresh-run">
                {zotBusy ? <Loader2 aria-hidden className="size-3 animate-spin" /> : <RotateCw aria-hidden className="size-3" />} 刷新此来源
              </Button>
            </div>
          )}
        </div>
      )}
      {refresh && (
        <div className="mt-1 rounded border border-line bg-panel p-2" data-testid="library-zotero-refresh">
          <div className="flex flex-wrap items-center justify-between gap-1.5">
            <strong className="text-2xs">一键刷新 · 新增 {refresh.counts.added} / 更新 {refresh.counts.updated} / 移除 {refresh.counts.removed} / 不变 {refresh.counts.unchanged}{refresh.truncated ? ' · 远端拉取被截断' : ''}</strong>
            <Button size="sm" className="h-6 px-2"
              disabled={zotBusy || (!refreshSel.additions.size && !refreshSel.updates.size && !refreshSel.removals.size)}
              onClick={() => void zotRefreshCommit()} data-testid="library-zotero-refresh-commit">提交勾选</Button>
          </div>
          {refresh.notice && <p className="mt-1 text-2xs text-fg-muted" role="note">{refresh.notice}</p>}
          {refresh.added.length > 0 && (
            <div className="mt-1" data-testid="library-zotero-refresh-added">
              <p className="text-2xs text-fg-muted">新增（勾选导入）</p>
              {refresh.added.map((e, i) => (
                <label key={`a${i}`} className="flex items-center gap-1 py-0.5">
                  <input type="checkbox" checked={refreshSel.additions.has(i)}
                    onChange={() => setRefreshSel((s) => { const n = new Set(s.additions); n.has(i) ? n.delete(i) : n.add(i); return { ...s, additions: n } })} />
                  <span className="font-mono text-2xs">{String(e.citation_key ?? '')}</span>
                  <span className="truncate text-2xs">{String(e.title ?? '')}</span>
                </label>
              ))}
            </div>
          )}
          {refresh.updated.length > 0 && (
            <div className="mt-1" data-testid="library-zotero-refresh-updated">
              <p className="text-2xs text-fg-muted">更新（默认不勾选；本地已改字段不会被覆盖）</p>
              {refresh.updated.map((u, i) => (
                <label key={`u${i}`} className="flex items-center gap-1 py-0.5">
                  <input type="checkbox" checked={refreshSel.updates.has(i)}
                    onChange={() => setRefreshSel((s) => { const n = new Set(s.updates); n.has(i) ? n.delete(i) : n.add(i); return { ...s, updates: n } })} />
                  <span className="font-mono text-2xs">{u.citation_key}</span>
                  <span className="truncate text-2xs">
                    {Object.keys(u.new).filter((k) => (u.old[k] ?? '') !== (u.new[k] ?? '')).slice(0, 3)
                      .map((k) => `${k}: ${u.old[k] || '空'} → ${u.new[k] || '空'}`).join('；')}
                  </span>
                </label>
              ))}
            </div>
          )}
          {refresh.removed.length > 0 && (
            <div className="mt-1" data-testid="library-zotero-refresh-removed">
              <p className="text-2xs text-fg-muted">远端已移除（勾选确认删除）</p>
              {refresh.removed.map((r) => (
                <label key={r.reference_id} className="flex items-center gap-1 py-0.5">
                  <input type="checkbox" checked={refreshSel.removals.has(r.reference_id)}
                    onChange={() => setRefreshSel((s) => { const n = new Set(s.removals); n.has(r.reference_id) ? n.delete(r.reference_id) : n.add(r.reference_id); return { ...s, removals: n } })} />
                  <span className="font-mono text-2xs">{r.citation_key}</span>
                  {r.in_citation_order && <span className="text-2xs text-danger-fg">在引用顺序表中</span>}
                </label>
              ))}
              {refresh.mode === 'index' && refresh.removed.some((r) => r.in_citation_order && refreshSel.removals.has(r.reference_id)) && (
                <label className="mt-0.5 flex items-center gap-1 text-2xs text-danger-fg">
                  <input type="checkbox" checked={refreshSel.removeFromOrder}
                    onChange={(e) => setRefreshSel((s) => ({ ...s, removeFromOrder: e.target.checked }))} />
                  同时从引用顺序表移除（否则提交会被拒绝）
                </label>
              )}
            </div>
          )}
        </div>
      )}

      {preview && (
        <div className="mt-2" data-testid="library-import-preview">
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            <span>解析出 {preview.entries.length} 条{preview.errors.length ? `，${preview.errors.length} 条损坏已跳过` : ''}。</span>
            {lib?.mode === 'bib' && (
              <>
                <select className="rounded border border-line bg-app px-1 py-0.5" value={targetBib} onChange={(e) => setTargetBib(e.target.value)} data-testid="library-import-target">
                  {bibFiles.map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
                <span className="flex items-center gap-1 text-fg-muted">
                  <FilePlus2 aria-hidden className="size-3" />
                  <input className="w-28 rounded border border-line bg-app px-1 py-0.5" placeholder="新建 refs.bib" value={newBibName} onChange={(e) => setNewBibName(e.target.value)} />
                  <Button variant="ghost" size="xs" disabled={!newBibName.trim() || !canEdit} onClick={() => void createBib()}>新建</Button>
                </span>
              </>
            )}
            <Button size="sm" className="ml-auto h-6 px-2" disabled={busy || !canEdit || targets.size === 0 || (lib?.mode === 'bib' && !targetBib)} onClick={() => void doCommit()} data-testid="library-import-commit">
              确认导入 {targets.size} 条
            </Button>
          </div>
          <ul className="space-y-1">
            {preview.entries.map((e, i) => (
              <li key={i} className="rounded border border-line bg-panel p-1.5">
                <label className="flex items-start gap-1.5">
                  <input type="checkbox" className="mt-0.5" checked={targets.has(i)} onChange={() => setTargets((prev) => {
                    const next = new Set(prev)
                    if (next.has(i)) next.delete(i)
                    else next.add(i)
                    return next
                  })} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{e.title || `（无标题）${e.citation_key}`}</span>
                    <span className="flex flex-wrap items-center gap-1 text-fg-muted">
                      <input
                        className="w-40 rounded border border-line bg-app px-1"
                        defaultValue={e.citation_key}
                        onChange={(ev) => setRenames((p) => ({ ...p, [i]: ev.target.value.trim() }))}
                        title="导入时的 citation key（可改）"
                        data-testid={`library-import-key-${i}`}
                      />
                      {e.year && <span>· {e.year}</span>}
                      {e.key_conflict && <span className="text-warning">key 与现有条目冲突</span>}
                      {e.duplicates.map((d) => (
                        <span key={d.kind} className="rounded bg-warning/10 px-1 text-warning">
                          {d.kind === 'doi' ? 'DOI 与现有条目重复' : d.kind === 'arxiv' ? 'arXiv 与现有条目重复' : '疑似重复'}：{d.citation_key}
                        </span>
                      ))}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {preview.errors.map((err, i) => (
            <div key={i} className="mt-1 rounded border border-danger/30 bg-danger/5 p-1.5 text-danger" role="alert">
              <span className="inline-flex items-center gap-1"><CircleAlert aria-hidden className="size-3" /> 第 {err.line} 行：{err.error}</span>
              <pre className="mt-1 max-h-16 overflow-auto whitespace-pre-wrap text-2xs opacity-80">{err.raw}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function DiagnosticsTab({ lib, onGoList }: { lib: LibraryReply | null; onGoList: (rid: string) => void }) {
  const d = lib?.diagnostics
  if (!d) return null
  const item = (n: number) => (n === 0 ? null : n)
  return (
    <div className="min-h-0 flex-1 overflow-auto p-2 text-xs" data-testid="library-diagnostics">
      {(item(d.duplicate_keys.length) && (
        <section className="mb-2">
          <h4 className="mb-1 flex items-center gap-1 font-medium text-warning"><AlertTriangle aria-hidden className="size-3.5" /> 重复 citation key（{d.duplicate_keys.length}）</h4>
          <ul className="space-y-0.5">
            {d.duplicate_keys.map((x) => (
              <li key={x.key}>「{x.key}」出现在 {x.bib_files.join('、') || '多处'}——请合并或改名（点击条目 → 合并）</li>
            ))}
          </ul>
        </section>
      ))}
      {(item(d.fuzzy_duplicates.length) && (
        <section className="mb-2">
          <h4 className="mb-1 flex items-center gap-1 font-medium text-warning"><AlertTriangle aria-hidden className="size-3.5" /> 疑似重复（标题+作者+年份）（{d.fuzzy_duplicates.length}）</h4>
          <ul className="space-y-0.5">
            {d.fuzzy_duplicates.map((x, i) => (
              <li key={i}>
                <button className="text-left hover:underline" onClick={() => onGoList(x.reference_ids[0])}>{x.title || '（无标题）'}</button>
                <span className="ml-1 text-fg-muted">（{x.reference_ids.length} 条疑似同一文献）</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {(item(d.undefined_in_tex.length) && (
        <section className="mb-2">
          <h4 className="mb-1 flex items-center gap-1 font-medium text-warning"><AlertTriangle aria-hidden className="size-3.5" /> 正文引用但库中不存在（{d.undefined_in_tex.length}）</h4>
          <ul className="space-y-0.5">
            {d.undefined_in_tex.map((k) => <li key={k}>{`\\cite{${k}}`}——库内无此 key（编译会出 undefined citation）</li>)}
          </ul>
        </section>
      ))}
      {(item(d.missing_fields.length) && (
        <section className="mb-2">
          <h4 className="mb-1 flex items-center gap-1 font-medium text-fg-muted"><AlertTriangle aria-hidden className="size-3.5" /> 缺字段（{d.missing_fields.length}）</h4>
          <ul className="space-y-0.5">
            {d.missing_fields.map((m) => (
              <li key={m.reference_id}>
                <button className="hover:underline" onClick={() => onGoList(m.reference_id)}>{m.citation_key}</button>
                <span className="ml-1 text-fg-muted">缺 {m.missing.join('、')}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {(item(d.parse_errors?.length ?? 0) && (
        <section className="mb-2">
          <h4 className="mb-1 flex items-center gap-1 font-medium text-danger"><CircleAlert aria-hidden className="size-3.5" /> .bib 解析错误（{d.parse_errors.length}）</h4>
          <ul className="space-y-1">
            {d.parse_errors.map((e, i) => (
              <li key={i} className="rounded border border-danger/30 bg-danger/5 p-1">
                第 {e.line} 行：{e.error}
                <pre className="mt-0.5 max-h-14 overflow-auto whitespace-pre-wrap text-2xs opacity-80">{e.raw}</pre>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {diagCount(lib) === 0 && <div className="text-fg-muted">未发现重复 key、缺字段或解析错误。</div>}
      <p className="mt-2 text-2xs text-fg-muted">说明：「未验证」仅表示尚未经外部来源或人工确认，不代表文献不存在。</p>
    </div>
  )
}

function Seg<T extends string>({ options, value, onChange, labels }: {
  options: T[]
  value: T
  onChange: (v: T) => void
  labels: Record<T, string>
}) {
  return (
    <div className="flex overflow-hidden rounded border border-line">
      {options.map((o) => (
        <button
          key={o}
          className={cn('px-1.5 py-0.5', value === o ? 'bg-panel text-fg-strong' : 'text-fg-muted hover:bg-panel')}
          onClick={() => onChange(o)}
          data-testid={`library-tab-${o}`}
        >
          {labels[o]}
        </button>
      ))}
    </div>
  )
}

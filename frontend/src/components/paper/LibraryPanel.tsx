import { useCallback, useEffect, useMemo, useState } from 'react'
import { BookOpen, ChevronDown, ChevronRight, Download, Loader2, Quote, RotateCw, Search, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { libraryApi, type LibraryEntry, type LibraryReply } from '@/lib/api/library'
import { cn } from '@/lib/utils'
import { DiagnosticsTab } from './library/DiagnosticsTab'
import { EntryDetail } from './library/EntryDetail'
import { ImportTab } from './library/ImportTab'
import { FactCheckBadge, VerifiedBadge } from './library/LibraryBadges'
import { CITATION_STYLE_LABELS, type CitationStyle, type LibraryTab, SOURCE_LABEL_FALLBACK, diagCount, errText } from './library/types'
import { useCitationVerify } from './library/useCitationVerify'
import { WordBibToolbar } from './library/WordBibToolbar'

export { CITATION_STYLE_LABELS, type CitationStyle }

interface Props {
  pid: string
  canEdit: boolean
  /** @deprecated LaTeX 面板亦不再读取；保留 prop 兼容既有调用 */
  activePath?: string | null
  onInsertCitations: (entries: LibraryEntry[], command: string) => void
  reloadSignal?: number
  onLibraryChanged?: () => void
  onUpdateBibliography?: () => void
  bibliographyBusy?: boolean
  citationStyle?: CitationStyle
  onCitationStyleChange?: (s: CitationStyle) => void
  onStripBibMarkers?: () => void
  stripBibMarkersBusy?: boolean
  onRenumberCitations?: (style?: CitationStyle) => void | Promise<unknown>
  renumberBusy?: boolean
}

export function LibraryPanel({
  pid,
  canEdit,
  onInsertCitations,
  reloadSignal = 0,
  onUpdateBibliography,
  bibliographyBusy = false,
  onLibraryChanged,
  citationStyle,
  onCitationStyleChange,
  onStripBibMarkers,
  stripBibMarkersBusy = false,
  onRenumberCitations,
  renumberBusy = false,
}: Props) {
  const [tab, setTab] = useState<LibraryTab>('list')
  const [lib, setLib] = useState<LibraryReply | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<string | null>(null)
  const [citeCommand, setCiteCommand] = useState('')
  const isWordMode = Boolean(onUpdateBibliography)

  const entries = useMemo(() => lib?.entries ?? [], [lib])
  const { verifyMap, verifyBusy, loadVerifyCache, runFactCheck } = useCitationVerify({
    pid,
    entries,
    selected,
    onNotice: setNotice,
    onError: setError,
  })

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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return entries
    return entries.filter(
      (e) =>
        e.citation_key.toLowerCase().includes(q) ||
        (e.title ?? '').toLowerCase().includes(q) ||
        e.authors.join(' ').toLowerCase().includes(q) ||
        (e.year ?? '').includes(q),
    )
  }, [entries, query])

  const selectedEntries = useMemo(() => entries.filter((e) => selected.has(e.reference_id)), [entries, selected])

  const toggleSel = (rid: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(rid)) next.delete(rid)
      else next.add(rid)
      return next
    })
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
      <div className="flex shrink-0 flex-wrap items-center gap-x-1 gap-y-1 border-b border-line px-2 py-1 text-xs">
        <Seg
          options={['list', 'import', 'diagnostics'] as LibraryTab[]}
          value={tab}
          onChange={setTab}
          labels={{
            list: '文献列表',
            import: '导入',
            diagnostics: `诊断${diagCount(lib) ? `（${diagCount(lib)}）` : ''}`,
          }}
        />
        <a className="ml-auto inline-flex items-center gap-0.5 py-0.5 text-fg-muted hover:text-fg" href={libraryApi.exportUrl(pid, 'bibtex')} data-testid="library-export-bib">
          <Download aria-hidden className="size-3" /> BibTeX
        </a>
        <a className="inline-flex items-center gap-0.5 py-0.5 text-fg-muted hover:text-fg" href={libraryApi.exportUrl(pid, 'csl-json')} data-testid="library-export-csl">
          <Download aria-hidden className="size-3" /> CSL-JSON
        </a>
      </div>

      {onUpdateBibliography && (
        <WordBibToolbar
          canEdit={canEdit}
          onUpdateBibliography={onUpdateBibliography}
          bibliographyBusy={bibliographyBusy}
          citationStyle={citationStyle}
          onCitationStyleChange={onCitationStyleChange}
          onStripBibMarkers={onStripBibMarkers}
          stripBibMarkersBusy={stripBibMarkersBusy}
          onRenumberCitations={onRenumberCitations}
          renumberBusy={renumberBusy}
        />
      )}

      {error && (
        <div role="alert" className="shrink-0 border-b border-line px-2 py-1 text-xs text-danger" data-testid="library-error">
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className="shrink-0 border-b border-line px-2 py-1 text-xs text-fg-muted" data-testid="library-notice">
          {notice}
        </div>
      )}

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
              {!isWordMode && (
                <select
                  className="rounded border border-line bg-app px-1.5 py-1 text-xs"
                  value={citeCommand}
                  onChange={(e) => setCiteCommand(e.target.value)}
                  data-testid="library-cite-command"
                  title={lib?.cite_style ? `工程检测：${lib.cite_style.style}（来自 ${lib.cite_style.detected_from}）` : ''}
                >
                  {(lib?.mode === 'bib'
                    ? [
                        { v: 'cite', label: '\\cite' },
                        { v: 'citep', label: '\\citep（括号）' },
                        { v: 'citet', label: '\\citet（作者作主语）' },
                        { v: 'autocite', label: '\\autocite（biblatex）' },
                        { v: 'textcite', label: '\\textcite（biblatex）' },
                      ]
                    : [{ v: 'cite', label: '\\cite' }]
                  ).map((o) => (
                    <option key={o.v} value={o.v}>
                      {o.label}
                    </option>
                  ))}
                </select>
              )}
              <Button size="sm" className="h-6 px-2" onClick={() => selectedEntries.length && onInsertCitations(selectedEntries, citeCommand || 'cite')} data-testid="library-insert">
                <Quote aria-hidden className="size-3" /> {isWordMode && selectedEntries.length > 1 ? '合并插入引用' : '在光标处插入引用'}
              </Button>
              <Button variant="ghost" size="sm" className="h-6 px-1.5" onClick={() => setSelected(new Set())}>
                取消
              </Button>
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
                        <VerifiedBadge entry={e} factCheck={verifyMap.get(e.reference_id)} />
                        <FactCheckBadge item={verifyMap.get(e.reference_id)} />
                      </span>
                    </button>
                    {canEdit && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-6 shrink-0 gap-0.5 px-1.5 text-2xs"
                        onClick={() => onInsertCitations([e], citeCommand || 'cite')}
                        title={isWordMode ? '在正文光标处直接插入此篇引用 [n]' : `在光标处插入 \\${citeCommand || 'cite'}{${e.citation_key}}`}
                        data-testid={`library-quick-cite-${e.citation_key}`}
                      >
                        <Quote aria-hidden className="size-2.5" /> 引用
                      </Button>
                    )}
                    <button
                      className="shrink-0 p-0.5 text-fg-muted"
                      onClick={() => setExpanded(expanded === e.reference_id ? null : e.reference_id)}
                      aria-label="详情"
                    >
                      {expanded === e.reference_id ? <ChevronDown aria-hidden className="size-3.5" /> : <ChevronRight aria-hidden className="size-3.5" />}
                    </button>
                  </div>
                  {expanded === e.reference_id && (
                    <EntryDetail
                      pid={pid}
                      entry={e}
                      canEdit={canEdit}
                      sourceLabels={lib?.source_labels ?? SOURCE_LABEL_FALLBACK}
                      onChanged={() => void afterChange()}
                      onNotice={setNotice}
                      onError={setError}
                      entries={entries}
                      verifyItem={verifyMap.get(e.reference_id)}
                    />
                  )}
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      {tab === 'import' && (
        <ImportTab
          pid={pid}
          lib={lib}
          canEdit={canEdit}
          onDone={async (msg) => {
            setNotice(msg)
            await afterChange()
          }}
          onError={setError}
        />
      )}

      {tab === 'diagnostics' && (
        <DiagnosticsTab
          lib={lib}
          onGoList={(rid) => {
            setExpanded(rid)
            setTab('list')
          }}
        />
      )}
    </div>
  )
}

function Seg<T extends string>({
  options,
  value,
  onChange,
  labels,
}: {
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

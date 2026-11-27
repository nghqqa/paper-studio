import { useRef, useState } from 'react'
import { ArrowUpCircle, CheckCircle2, FileText, FileUp, Loader2, Search, Sparkles, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  type CitationVerifyItem,
  libraryApi,
  type LibraryEntry,
  type SourceCandidate,
} from '@/lib/api/library'
import { cn } from '@/lib/utils'
import { LibraryPdfDialog } from './LibraryPdfDialog'
import { SOURCE_LABEL_FALLBACK, errText } from './types'

export function EntryDetail({
  pid,
  entry,
  canEdit,
  sourceLabels,
  onChanged,
  onNotice,
  onError,
  entries,
  verifyItem,
}: {
  pid: string
  entry: LibraryEntry
  canEdit: boolean
  sourceLabels: Record<string, string>
  onChanged: () => Promise<void> | void
  onNotice: (s: string) => void
  onError: (s: string) => void
  entries: LibraryEntry[]
  verifyItem?: CitationVerifyItem
}) {
  const [busy, setBusy] = useState(false)
  const [lookupResult, setLookupResult] = useState<{ candidates: SourceCandidate[]; upgradeMode?: boolean } | null>(null)
  const [lookupBusy, setLookupBusy] = useState(false)
  const [lookupErr, setLookupErr] = useState('')
  const [mergeWith, setMergeWith] = useState('')
  const [fieldPicks, setFieldPicks] = useState<Record<string, 'survivor' | 'loser'>>({})
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [editing, setEditing] = useState(false)
  const [applyingVerify, setApplyingVerify] = useState(false)
  const [pdfOpen, setPdfOpen] = useState(false)
  const [pdfBusy, setPdfBusy] = useState(false)
  const pdfInputRef = useRef<HTMLInputElement>(null)

  async function applyAuthoritativeVerify() {
    if (!verifyItem?.remote_fields || applyingVerify) return
    const rf = verifyItem.remote_fields
    const patch: Record<string, string> = {}
    if (rf.title) patch.title = rf.title
    if (rf.authors && rf.authors.length > 0) patch.author = rf.authors.join(' and ')
    if (rf.year) patch.year = rf.year
    if (rf.venue) patch.venue = rf.venue
    if (rf.doi) patch.doi = rf.doi
    if (rf.url) patch.url = rf.url
    if (Object.keys(patch).length === 0) return
    setApplyingVerify(true)
    try {
      await libraryApi.editEntry(pid, entry.reference_id, patch)
      onNotice('已根据权威核验结果更新文献元数据')
      await onChanged()
    } catch (e) {
      onError(errText(e))
    } finally {
      setApplyingVerify(false)
    }
  }

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
        const body =
          kind === 'doi'
            ? { doi: entry.doi ?? '', reference_id: entry.reference_id }
            : kind === 'arxiv'
              ? { arxiv: entry.arxiv_id ?? '', reference_id: entry.reference_id }
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

  const isFormalCandidate = (c: SourceCandidate) => {
    const src = String(c.candidate.source || '').toLowerCase()
    const doi = String(c.candidate.fields.doi || '').trim()
    const venue = String(c.candidate.fields.venue || '').trim()
    const isArxivDoi = /^10\.48550\/arxiv\./i.test(doi)
    const isArxivVenue = /^arxiv\b/i.test(venue)
    return (src === 'crossref' || src === 'openalex') && Boolean(venue) && !isArxivVenue && !isArxivDoi
  }

  const doUpgradePreprint = () =>
    run(async () => {
      setLookupBusy(true)
      setLookupErr('')
      try {
        const r = await libraryApi.lookup(pid, { query: entry.title, reference_id: entry.reference_id })
        const sorted = [...r.candidates].sort((a, b) => Number(isFormalCandidate(b)) - Number(isFormalCandidate(a)))
        setLookupResult({ candidates: sorted, upgradeMode: true })
      } catch (e) {
        setLookupErr(errText(e))
      } finally {
        setLookupBusy(false)
      }
    })

  const hasFormalDoi = Boolean(entry.doi && !/^10\.48550\/arxiv\./i.test(entry.doi.trim()))
  const isPreprint =
    !hasFormalDoi &&
    (Boolean(entry.arxiv_id) ||
      /\barxiv\b|\bcorr\b/i.test(entry.venue ?? '') ||
      /^10\.48550\/arxiv\./i.test(entry.doi ?? ''))

  const diffSameCount = (c: SourceCandidate) => (c.diff ?? []).filter((d) => !d.same).length

  return (
    <div className="border-t border-line px-2 py-1.5 text-xs" data-testid={`library-detail-${entry.citation_key}`}>
      <table className="w-full">
        <tbody>
          {(
            [
              ['citation_key', 'Key'],
              ['title', '标题'],
              ['author', '作者'],
              ['year', '年份'],
              ['venue', '期刊/会议'],
              ['volume', '卷'],
              ['number', '期'],
              ['pages', '页码'],
              ['publisher', '出版社'],
              ['doi', 'DOI'],
              ['eprint', 'arXiv'],
              ['url', 'URL'],
            ] as const
          ).map(([f, label]) => {
            const value =
              f === 'author'
                ? entry.authors.join(' and ')
                : f === 'venue'
                  ? (entry.venue ?? '')
                  : f === 'eprint'
                    ? (entry.arxiv_id ?? '')
                    : ((entry as unknown as Record<string, string | null>)[f] ?? entry.fields[f] ?? '')
            if (!value) return null
            const pv = entry.field_provenance[f]
            const suggested = entry.suggested?.[f]
            return (
              <tr key={f} className="align-top">
                <td className="w-16 shrink-0 py-0.5 text-fg-muted">{label}</td>
                <td className="py-0.5">
                  <span className="break-all">{String(value)}</span>
                  {pv && (
                    <span
                      className={cn(
                        'ml-1 rounded px-1 text-2xs',
                        pv.confirmed ? 'bg-ok/10 text-ok' : 'bg-sunken text-fg-muted',
                      )}
                      title={pv.confirmed ? '已人工确认' : '来源字段（未逐项确认）'}
                    >
                      {sourceLabels[pv.source] ?? SOURCE_LABEL_FALLBACK[pv.source] ?? pv.source}
                      {pv.confirmed ? '·已确认' : ''}
                    </span>
                  )}
                  {suggested && (
                    <span className="ml-1 text-warning" title={`AI 建议（${entry.suggested_model ?? ''}）：${suggested}`}>
                      <Sparkles aria-hidden className="mr-0.5 inline size-3" />
                      AI建议：{suggested}
                    </span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {entry.retraction && (
        <div
          className={cn(
            'mt-1 rounded px-1.5 py-1',
            entry.retraction.status === 'retracted' ? 'bg-danger/10 text-danger' : 'bg-sunken text-fg-muted',
          )}
          data-testid={`library-retraction-${entry.citation_key}`}
        >
          {entry.retraction.status === 'retracted' && '⚠ 来源记录显示该文献已撤稿'}
          {entry.retraction.status === 'corrected' && '来源记录显示有更正版本'}
          {entry.retraction.status === 'unknown' && '撤稿状态：未知（未查询到撤稿记录 ≠ 已证明未撤稿）'}
          {entry.retraction.source && <span className="ml-1">（来源：{entry.retraction.source}）</span>}
        </div>
      )}
      {verifyItem?.status === 'mismatch' && (
        <div
          className="mt-1 rounded border border-warning/40 bg-warning/10 p-1.5 text-xs"
          data-testid={`library-verify-mismatch-${entry.citation_key}`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium text-warning">
              权威核验发现字段差异（来源：{verifyItem.source ?? '未知'}）
            </span>
            {canEdit && verifyItem.remote_fields && Object.keys(verifyItem.remote_fields).length > 0 && (
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={applyingVerify || busy}
                onClick={() => void applyAuthoritativeVerify()}
                data-testid={`library-apply-verify-${entry.citation_key}`}
              >
                {applyingVerify ? '正在应用…' : '一键应用权威元数据'}
              </Button>
            )}
          </div>
          {verifyItem.diffs.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-fg-muted">
              {verifyItem.diffs.map((d) => (
                <li key={d.field}>
                  <span className="font-medium">{d.field}</span>：本地「{d.local}」→ 权威「{d.remote}」
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {entry.raw_bibtex && (
        <details className="mt-1">
          <summary className="cursor-pointer text-fg-muted">原始 BibTeX</summary>
          <pre className="mt-1 max-h-40 overflow-auto rounded bg-app p-1.5 text-2xs leading-4">{entry.raw_bibtex}</pre>
        </details>
      )}

      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <Button
          variant="outline"
          size="xs"
          disabled={lookupBusy}
          onClick={() => void doLookup('doi')}
          data-testid={`library-lookup-doi-${entry.citation_key}`}
        >
          {lookupBusy ? <Loader2 aria-hidden className="size-3 animate-spin" /> : <Search aria-hidden className="size-3" />} DOI 核对
        </Button>
        <Button
          variant="outline"
          size="xs"
          disabled={lookupBusy || !entry.arxiv_id}
          onClick={() => void doLookup('arxiv')}
          title={entry.arxiv_id ? '' : '该条目无 arXiv 标识'}
        >
          arXiv 核对
        </Button>
        <Button
          variant="outline"
          size="xs"
          disabled={lookupBusy || !entry.title}
          onClick={() => void doLookup('query')}
          title="按标题搜索候选（不自动落盘）"
        >
          搜索比对
        </Button>
        {isPreprint && canEdit && (
          <Button
            variant="outline"
            size="xs"
            disabled={lookupBusy || !entry.title}
            onClick={() => void doUpgradePreprint()}
            title="检索该预印本是否已在期刊/会议正式发表"
            data-testid={`library-upgrade-preprint-${entry.citation_key}`}
          >
            <ArrowUpCircle aria-hidden className="size-3" /> 升级正式版
          </Button>
        )}
        {canEdit && entry.verified !== 'verified' && (
          <Button
            size="xs"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await libraryApi.confirm(pid, entry.reference_id, [])
                onNotice('已确认整条（对匹配结果负责）')
                await onChanged()
              })
            }
            data-testid={`library-confirm-${entry.citation_key}`}
          >
            <CheckCircle2 aria-hidden className="size-3" /> 确认整条
          </Button>
        )}
        {canEdit && Object.keys(entry.suggested ?? {}).length > 0 && (
          <Button
            size="xs"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await libraryApi.confirm(pid, entry.reference_id, Object.keys(entry.suggested ?? {}))
                onNotice('AI 建议字段已标记确认')
                await onChanged()
              })
            }
          >
            确认 AI 建议
          </Button>
        )}
        {canEdit && (
          <>
            <Button
              variant="ghost"
              size="xs"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const r = await libraryApi.aiSuggest(pid, entry.reference_id)
                  onNotice(r.note ?? '')
                  await onChanged()
                })
              }
              title="AI 补全缺失字段（仅建议层，需确认）"
            >
              <Sparkles aria-hidden className="size-3" /> AI 补全
            </Button>
            <Button variant="ghost" size="xs" disabled={busy} onClick={() => setEditing((v) => !v)}>
              编辑
            </Button>
          </>
        )}
        {entry.pdf?.has_pdf && (
          <Button
            variant="outline"
            size="xs"
            onClick={() => setPdfOpen(true)}
            data-testid={`library-read-pdf-${entry.citation_key}`}
          >
            <FileText aria-hidden className="size-3" /> 阅读 PDF ({entry.pdf.pages}p)
          </Button>
        )}
        {canEdit && (
          <>
            <input
              ref={pdfInputRef}
              type="file"
              accept=".pdf,application/pdf"
              className="hidden"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(ev) => {
                const picked = ev.target.files?.[0]
                ev.target.value = ''
                if (!picked) return
                setPdfBusy(true)
                void libraryApi
                  .uploadEntryPdf(pid, entry.reference_id, picked)
                  .then(() => {
                    onNotice('已归档文献 PDF 原文')
                    return onChanged()
                  })
                  .catch((err) => onError(errText(err)))
                  .finally(() => setPdfBusy(false))
              }}
            />
            <Button
              variant="ghost"
              size="xs"
              disabled={busy || pdfBusy}
              onClick={() => pdfInputRef.current?.click()}
              data-testid={`library-attach-pdf-${entry.citation_key}`}
            >
              <FileUp aria-hidden className="size-3" /> {pdfBusy ? '上传中…' : entry.pdf?.has_pdf ? '替换 PDF' : '附加 PDF'}
            </Button>
            {entry.pdf?.has_pdf && (
              <Button
                variant="ghost"
                size="xs"
                className="text-danger"
                disabled={busy || pdfBusy}
                onClick={() =>
                  void libraryApi
                    .deleteEntryPdf(pid, entry.reference_id)
                    .then(() => {
                      onNotice('已移除归档 PDF')
                      return onChanged()
                    })
                    .catch((err) => onError(errText(err)))
                }
              >
                移除 PDF
              </Button>
            )}
          </>
        )}
      </div>
      {lookupErr && (
        <div role="alert" className="mt-1 text-danger">
          {lookupErr}
        </div>
      )}
      {lookupResult && (
        <div className="mt-1 rounded border border-line bg-app p-1.5" data-testid={`library-lookup-result-${entry.citation_key}`}>
          {lookupResult.upgradeMode && (
            <div className="mb-1 rounded bg-primary-soft px-1.5 py-1 text-2xs text-link" data-testid={`library-upgrade-banner-${entry.citation_key}`}>
              {lookupResult.candidates.some(isFormalCandidate)
                ? '检测到正式发表版本候选，核对差异后点击合并即可替换为期刊/会议正式引文。'
                : '暂未检索到非预印本的正式发表记录（可能仍处于预印本阶段）。'}
            </div>
          )}
          <div className="mb-1 text-fg-muted">候选（{lookupResult.candidates.length}）——仅展示，确认后才落盘：</div>
          {lookupResult.candidates.length === 0 && <div className="text-fg-muted">无候选。</div>}
          {lookupResult.candidates.map((c, i) => (
            <div key={i} className="mb-1 border-b border-line pb-1 last:border-0">
              <div className="flex flex-wrap items-center gap-1 font-medium">
                <span>{String(c.candidate.fields.title ?? '（无标题）')}</span>
                {isFormalCandidate(c) && <Badge tone="ok">正式出版</Badge>}
              </div>
              <div className="text-fg-muted">
                {String(c.candidate.fields.authors ?? '')} · {String(c.candidate.fields.year ?? '')} ·{' '}
                {String(c.candidate.fields.venue ?? '')} · 来源 {c.candidate.source}
              </div>
              {(c.diff ?? []).some((d) => !d.same) && (
                <ul className="mt-0.5 space-y-0.5">
                  {(c.diff ?? [])
                    .filter((d) => !d.same)
                    .map((d) => (
                      <li key={d.field} className="text-warning">
                        字段 {d.field} 不一致：当前「{d.current}」 ↔ 来源「{d.source}」
                      </li>
                    ))}
                </ul>
              )}
              {(c.diff ?? []).length > 0 && diffSameCount(c) === 0 && (
                <div className="mt-0.5 text-ok">已有字段与来源一致。</div>
              )}
              {canEdit && (
                <Button
                  size="xs"
                  className="mt-1"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const f = c.candidate.fields
                      const patch: Record<string, string> = {}
                      if (f.pages) patch.pages = String(f.pages)
                      if (f.volume) patch.volume = String(f.volume)
                      if (f.venue && !entry.venue) patch.venue = String(f.venue)
                      if (f.abstract && !entry.abstract) patch.abstract = String(f.abstract)
                      if (!Object.keys(patch).length) {
                        onNotice('来源没有可补充的字段')
                        return
                      }
                      await libraryApi.editEntry(pid, entry.reference_id, patch)
                      onNotice('已按来源补充缺失字段')
                      await onChanged()
                    })
                  }
                >
                  按来源补全缺失字段
                </Button>
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
                defaultValue={f === 'venue' ? (entry.venue ?? '') : ((entry as unknown as Record<string, string | null>)[f] ?? '')}
                onChange={(ev) => setEdits((prev) => ({ ...prev, [f]: ev.target.value }))}
                data-testid={`library-edit-${f}`}
              />
            </label>
          ))}
          <div className="flex gap-1">
            <Button
              size="xs"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  if (!Object.keys(edits).length) {
                    setEditing(false)
                    return
                  }
                  await libraryApi.editEntry(pid, entry.reference_id, edits)
                  onNotice('字段已写回 .bib')
                  setEditing(false)
                  setEdits({})
                  await onChanged()
                })
              }
              data-testid="library-edit-save"
            >
              保存修改
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                setEditing(false)
                setEdits({})
              }}
            >
              取消
            </Button>
          </div>
        </div>
      )}

      {canEdit && entries.length > 1 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1 rounded bg-sunken px-1.5 py-1">
          <span className="text-fg-muted">合并（本条为主）：</span>
          <select
            className="rounded border border-line bg-app px-1 py-0.5"
            value={mergeWith}
            onChange={(e) => setMergeWith(e.target.value)}
            data-testid={`library-merge-select-${entry.citation_key}`}
          >
            <option value="">选择重复条目…</option>
            {entries
              .filter((o) => o.reference_id !== entry.reference_id)
              .map((o) => (
                <option key={o.reference_id} value={o.reference_id}>
                  {o.citation_key} — {(o.title ?? '').slice(0, 30)}
                </option>
              ))}
          </select>
          {mergeWith &&
            (() => {
              const other = entries.find((o) => o.reference_id === mergeWith)
              const fields = ['title', 'author', 'year', 'venue', 'pages', 'volume', 'doi', 'publisher']
              return (
                <span className="flex flex-wrap items-center gap-1">
                  {fields.map((f) => {
                    const a =
                      f === 'author'
                        ? entry.authors.join(' and ')
                        : f === 'venue'
                          ? (entry.venue ?? '')
                          : ((entry as unknown as Record<string, string | null>)[f] ?? '')
                    const b = other
                      ? f === 'author'
                        ? other.authors.join(' and ')
                        : f === 'venue'
                          ? (other.venue ?? '')
                          : ((other as unknown as Record<string, string | null>)[f] ?? '')
                      : ''
                    if (!a || !b || a === b) return null
                    return (
                      <label key={f} className="flex items-center gap-0.5 text-2xs" title={`主：${a} / 副：${b}`}>
                        {f}
                        <select
                          className="rounded border border-line bg-app"
                          value={fieldPicks[f] ?? 'survivor'}
                          onChange={(e) => setFieldPicks((p) => ({ ...p, [f]: e.target.value as 'survivor' | 'loser' }))}
                        >
                          <option value="survivor">本条</option>
                          <option value="loser">对方</option>
                        </select>
                      </label>
                    )
                  })}
                  <Button
                    size="xs"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const loser = entries.find((o) => o.reference_id === mergeWith)
                        if (!loser) return
                        await libraryApi.merge(pid, {
                          survivor_rid: entry.reference_id,
                          loser_rid: loser.reference_id,
                          field_choices: fieldPicks,
                          tex_updates: [],
                        })
                        onNotice('已合并（重复条目移除；如需改正文引用键请用「改名」）')
                        setMergeWith('')
                        setFieldPicks({})
                        await onChanged()
                      })
                    }
                    data-testid={`library-merge-do-${entry.citation_key}`}
                  >
                    执行合并
                  </Button>
                </span>
              )
            })()}
        </div>
      )}

      {canEdit && (
        <Button
          variant="ghost"
          size="xs"
          className="mt-1 text-danger"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              if (!window.confirm(`从文献库删除 ${entry.citation_key}？（会从 .bib 移除该条目）`)) return
              await libraryApi.deleteEntry(pid, entry.reference_id)
              onNotice('条目已删除')
              await onChanged()
            })
          }
          data-testid={`library-delete-${entry.citation_key}`}
        >
          <Trash2 aria-hidden className="size-3" /> 删除条目
        </Button>
      )}
      {entry.pdf?.has_pdf && (
        <LibraryPdfDialog open={pdfOpen} onOpenChange={setPdfOpen} pid={pid} entry={entry} />
      )}
    </div>
  )
}

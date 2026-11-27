import { useCallback, useEffect, useMemo, useState } from 'react'
import { BookA, Check, CornerDownLeft, Plus, RefreshCw, Sparkles, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  glossaryApi,
  type GlossaryCandidate,
  type GlossaryCategory,
  type GlossaryEntry,
} from '@/lib/api/glossary'
import { cn } from '@/lib/utils'

const CAT_LABELS: Record<GlossaryCategory, string> = {
  term: '术语',
  notation: '符号',
  acronym: '缩略语',
}

function errMsg(e: unknown): string {
  const obj = e as { detail?: { message?: string }; message?: string }
  return obj?.detail?.message || obj?.message || String(e)
}

export function GlossaryPanel({
  pid,
  canEdit,
  onInsertText,
  onChanged,
}: {
  pid: string
  canEdit: boolean
  onInsertText?: (text: string) => void
  onChanged?: () => void
}) {
  const [entries, setEntries] = useState<GlossaryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [notice, setNotice] = useState('')
  const [filterCat, setFilterCat] = useState<'all' | GlossaryCategory>('all')
  const [search, setSearch] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [term, setTerm] = useState('')
  const [category, setCategory] = useState<GlossaryCategory>('term')
  const [symbol, setSymbol] = useState('')
  const [aliasesRaw, setAliasesRaw] = useState('')
  const [definition, setDefinition] = useState('')
  const [enforce, setEnforce] = useState(true)
  const [candidates, setCandidates] = useState<GlossaryCandidate[] | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setErr('')
    try {
      const r = await glossaryApi.list(pid)
      setEntries(r.entries)
    } catch (e) {
      setErr(errMsg(e))
    } finally {
      setLoading(false)
    }
  }, [pid])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const resetForm = () => {
    setEditingId(null)
    setTerm('')
    setCategory('term')
    setSymbol('')
    setAliasesRaw('')
    setDefinition('')
    setEnforce(true)
    setFormOpen(false)
  }

  const startEdit = (e: GlossaryEntry) => {
    setEditingId(e.id)
    setTerm(e.term)
    setCategory(e.category)
    setSymbol(e.symbol)
    setAliasesRaw(e.aliases.join(', '))
    setDefinition(e.definition)
    setEnforce(e.enforce)
    setFormOpen(true)
  }

  const handleSave = async () => {
    if (!term.trim() || busy) return
    setBusy(true)
    setErr('')
    setNotice('')
    const aliases = aliasesRaw
      .split(/[,，;；\n]/)
      .map((s) => s.trim())
      .filter(Boolean)
    try {
      const reply = await glossaryApi.upsert(pid, {
        ...(editingId ? { id: editingId } : {}),
        term: term.trim(),
        category,
        symbol: symbol.trim(),
        aliases,
        definition: definition.trim(),
        enforce,
      })
      setEntries(reply.entries)
      onChanged?.()
      setNotice(editingId ? '已更新术语条目' : '已添加术语条目')
      resetForm()
    } catch (e) {
      setErr(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  const handleToggleEnforce = async (e: GlossaryEntry) => {
    if (!canEdit || busy) return
    setBusy(true)
    setErr('')
    try {
      const r = await glossaryApi.update(pid, e.id, { enforce: !e.enforce })
      setEntries(r.entries)
      onChanged?.()
    } catch (ex) {
      setErr(errMsg(ex))
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async (e: GlossaryEntry) => {
    if (!canEdit || busy) return
    setBusy(true)
    setErr('')
    try {
      const r = await glossaryApi.remove(pid, e.id)
      setEntries(r.entries)
      if (editingId === e.id) resetForm()
      setCandidates((prev) =>
        prev
          ? prev.map((it) =>
              it.category === e.category && it.term === e.term ? { ...it, exists: false } : it,
            )
          : null,
      )
      onChanged?.()
      setNotice(`已移除「${e.term}」`)
    } catch (ex) {
      setErr(errMsg(ex))
    } finally {
      setBusy(false)
    }
  }

  const handleAddCandidate = async (c: NonNullable<typeof candidates>[number]) => {
    if (!canEdit || busy) return
    setBusy(true)
    setErr('')
    setNotice('')
    try {
      const r = await glossaryApi.upsert(pid, {
        term: c.term,
        category: c.category,
        symbol: c.symbol,
        definition: c.definition,
        aliases: c.aliases,
        enforce: true,
      })
      setEntries(r.entries)
      onChanged?.()
      setCandidates((prev) =>
        prev
          ? prev.map((it) =>
              it.category === c.category && it.term === c.term ? { ...it, exists: true } : it,
            )
          : null,
      )
      setNotice(`已收入「${c.term}」`)
    } catch (ex) {
      setErr(errMsg(ex))
    } finally {
      setBusy(false)
    }
  }

  const handleExtract = async (commit = false) => {
    if (!canEdit || busy) return
    setBusy(true)
    setErr('')
    setNotice('')
    try {
      const r = await glossaryApi.extract(pid, commit)
      setEntries(r.entries)
      if (commit) {
        onChanged?.()
        setNotice(`已自动导入 ${r.added} 条源码术语/符号`)
        setCandidates(null)
      } else {
        setCandidates(r.candidates)
      }
    } catch (ex) {
      setErr(errMsg(ex))
    } finally {
      setBusy(false)
    }
  }

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return entries.filter((e) => {
      if (filterCat !== 'all' && e.category !== filterCat) return false
      if (!q) return true
      return (
        e.term.toLowerCase().includes(q) ||
        e.symbol.toLowerCase().includes(q) ||
        e.definition.toLowerCase().includes(q) ||
        e.aliases.some((a) => a.toLowerCase().includes(q))
      )
    })
  }, [entries, filterCat, search])

  return (
    <div className="flex min-h-0 flex-1 flex-col text-xs" data-testid="glossary-panel">
      <div className="shrink-0 space-y-1.5 border-b border-line p-2">
        <div className="flex flex-wrap items-center gap-1">
          <span className="inline-flex items-center gap-1 font-medium text-fg-strong">
            <BookA aria-hidden className="size-3.5" /> 术语与符号表
          </span>
          <span className="text-2xs text-fg-muted">({entries.length})</span>
          <div className="ml-auto flex items-center gap-1">
            {canEdit && (
              <>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void handleExtract(false)}
                  data-testid="glossary-extract-btn"
                  title="扫描 .tex 源码中的缩略语与自定义数学宏"
                >
                  <Sparkles aria-hidden className="size-3" /> 扫描提取
                </Button>
                <Button
                  size="xs"
                  disabled={busy}
                  onClick={() => {
                    if (formOpen && !editingId) resetForm()
                    else {
                      resetForm()
                      setFormOpen(true)
                    }
                  }}
                  data-testid="glossary-new-btn"
                >
                  <Plus aria-hidden className="size-3" /> 新增
                </Button>
              </>
            )}
            <Button size="icon-xs" variant="ghost" disabled={loading} onClick={() => void refresh()} aria-label="刷新术语表">
              <RefreshCw aria-hidden className={cn('size-3', loading && 'animate-spin')} />
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {(['all', 'term', 'notation', 'acronym'] as const).map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => setFilterCat(cat)}
              className={cn(
                'rounded px-1.5 py-0.5 text-2xs transition-colors',
                filterCat === cat ? 'bg-primary-soft font-medium text-primary' : 'text-fg-muted hover:bg-hover',
              )}
            >
              {cat === 'all' ? '全部' : CAT_LABELS[cat]}
            </button>
          ))}
        </div>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索术语、符号或别名…"
          aria-label="搜索术语表"
          className="w-full rounded border border-line bg-app px-2 py-1 text-xs"
          data-testid="glossary-search"
        />
      </div>

      {err && <div role="alert" className="shrink-0 border-b border-line px-2 py-1 text-danger">{err}</div>}
      {notice && <div role="status" className="shrink-0 border-b border-line px-2 py-1 text-fg-muted">{notice}</div>}

      {candidates !== null && (
        <div className="shrink-0 space-y-1 border-b border-line bg-sunken p-2" data-testid="glossary-candidates">
          <div className="flex items-center justify-between gap-1">
            <span className="font-medium text-fg-strong">源码发现候选 ({candidates.length})</span>
            <div className="flex items-center gap-1">
              {candidates.some((c) => !c.exists) && (
                <Button size="xs" disabled={busy} onClick={() => void handleExtract(true)} data-testid="glossary-commit-candidates">
                  全部入库
                </Button>
              )}
              <Button size="xs" variant="ghost" onClick={() => setCandidates(null)}>收起</Button>
            </div>
          </div>
          {candidates.length === 0 ? (
            <p className="text-fg-muted">未从可编辑 .tex 源码中扫描到新的缩略语或宏定义。</p>
          ) : (
            <ul className="max-h-36 space-y-1 overflow-auto">
              {candidates.map((c, idx) => (
                <li key={`${c.category}:${c.term}:${idx}`} className="flex items-center justify-between gap-1 rounded border border-line bg-panel px-1.5 py-1">
                  <div className="min-w-0">
                    <span className="font-medium text-fg-strong">{c.term}</span>
                    <span className="ml-1 text-2xs text-fg-muted">[{CAT_LABELS[c.category]}] {c.definition}</span>
                  </div>
                  {c.exists ? (
                    <span className="shrink-0 text-2xs text-fg-muted">已在库</span>
                  ) : (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void handleAddCandidate(c)}
                    >
                      收入
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {formOpen && canEdit && (
        <div className="shrink-0 space-y-1.5 border-b border-line bg-sunken p-2" data-testid="glossary-form">
          <div className="flex items-center gap-1">
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as GlossaryCategory)}
              aria-label="条目类别"
              className="rounded border border-line bg-app px-1.5 py-1 text-xs"
            >
              <option value="term">术语</option>
              <option value="notation">符号</option>
              <option value="acronym">缩略语</option>
            </select>
            <input
              type="text"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="规范术语 / 缩写"
              className="min-w-0 flex-1 rounded border border-line bg-app px-2 py-1 text-xs"
              data-testid="glossary-input-term"
            />
          </div>
          <input
            type="text"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            placeholder="LaTeX 符号（可选，如 \mathcal{L}）"
            className="w-full rounded border border-line bg-app px-2 py-1 text-xs"
            data-testid="glossary-input-symbol"
          />
          <input
            type="text"
            value={aliasesRaw}
            onChange={(e) => setAliasesRaw(e.target.value)}
            placeholder="弃用别名（逗号分隔，投稿检查将标黄警告）"
            className="w-full rounded border border-line bg-app px-2 py-1 text-xs"
            data-testid="glossary-input-aliases"
          />
          <input
            type="text"
            value={definition}
            onChange={(e) => setDefinition(e.target.value)}
            placeholder="含义与用法说明"
            className="w-full rounded border border-line bg-app px-2 py-1 text-xs"
            data-testid="glossary-input-definition"
          />
          <div className="flex items-center justify-between gap-2">
            <label className="flex cursor-pointer items-center gap-1 text-xs text-fg-muted">
              <input type="checkbox" checked={enforce} onChange={(e) => setEnforce(e.target.checked)} className="accent-primary" />
              投稿体检拦截弃用别名
            </label>
            <div className="flex items-center gap-1">
              <Button size="xs" variant="ghost" onClick={resetForm}>取消</Button>
              <Button size="xs" disabled={busy || !term.trim()} onClick={() => void handleSave()} data-testid="glossary-save-btn">
                <Check aria-hidden className="size-3" /> 保存
              </Button>
            </div>
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto p-2">
        {loading && entries.length === 0 ? (
          <p className="text-fg-muted">正在读取术语表…</p>
        ) : visible.length === 0 ? (
          <p className="text-fg-muted">暂无术语或符号条目。可点击上方「扫描提取」从源码收集，或手动「新增」。</p>
        ) : (
          <ul className="space-y-1.5">
            {visible.map((e) => (
              <li key={e.id} className="space-y-1 rounded border border-line bg-panel p-2" data-testid={`glossary-item-${e.id}`}>
                <div className="flex items-center gap-1.5">
                  <span className="rounded bg-sunken px-1.5 py-0.5 text-2xs text-fg-muted">{CAT_LABELS[e.category]}</span>
                  <strong className="min-w-0 truncate text-fg-strong">{e.term}</strong>
                  {e.symbol && <code className="rounded bg-app px-1 py-0.5 font-mono text-2xs text-primary">{e.symbol}</code>}
                </div>
                {e.definition && <p className="text-fg-muted">{e.definition}</p>}
                {e.aliases.length > 0 && (
                  <p className="text-2xs text-warning">禁止别名：{e.aliases.join('、')}</p>
                )}
                <div className="flex flex-wrap items-center gap-1 pt-0.5">
                  {onInsertText && (
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => onInsertText(e.symbol || e.term)}
                      title="插入到编辑器光标位置"
                    >
                      <CornerDownLeft aria-hidden className="size-3" /> 插入
                    </Button>
                  )}
                  {canEdit && (
                    <>
                      <button
                        type="button"
                        onClick={() => void handleToggleEnforce(e)}
                        className={cn(
                          'rounded border px-1.5 py-0.5 text-2xs',
                          e.enforce ? 'border-primary/40 bg-primary-soft text-primary' : 'border-line text-fg-muted',
                        )}
                      >
                        {e.enforce ? '体检启用' : '体检关闭'}
                      </button>
                      <Button size="xs" variant="ghost" onClick={() => startEdit(e)}>编辑</Button>
                      <Button size="xs" variant="ghost" className="text-danger" onClick={() => void handleDelete(e)} aria-label={`删除 ${e.term}`}>
                        <Trash2 aria-hidden className="size-3" />
                      </Button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

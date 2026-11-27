import { useCallback, useEffect, useState } from 'react'
import { BookMarked, Code2, Plus, Send, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { sharedAssetsApi, type LatexSnippetItem, type SharedLibraryItem } from '@/lib/api/sharedAssets'
import { cn } from '@/lib/utils'
import { useStudio } from '@/store'

export function SharedAssetsView() {
  const projects = useStudio((s) => s.projects)
  const authOff = useStudio((s) => s.authStatus === 'off')
  const editableProjects = projects.filter(
    (p) => (p.list_state ?? 'active') === 'active' && (authOff || ['owner', 'editor', 'agent'].includes(p.my_role ?? '')),
  )

  const [tab, setTab] = useState<'library' | 'snippets'>('library')
  const [libItems, setLibItems] = useState<SharedLibraryItem[]>([])
  const [snippets, setSnippets] = useState<LatexSnippetItem[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [targetPid, setTargetPid] = useState('')
  const [sourcePid, setSourcePid] = useState('')
  const [bibtex, setBibtex] = useState('')
  const [snpTitle, setSnpTitle] = useState('')
  const [snpCategory, setSnpCategory] = useState('常用')
  const [snpCode, setSnpCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [notice, setNotice] = useState('')

  const loadAll = useCallback(async () => {
    setErr('')
    try {
      const [lr, sr] = await Promise.all([sharedAssetsApi.listLibrary(), sharedAssetsApi.listSnippets()])
      setLibItems(lr.items)
      setSnippets(sr.items)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  const importBibtex = async () => {
    if (!bibtex.trim() || busy) return
    setBusy(true); setErr(''); setNotice('')
    try {
      const r = await sharedAssetsApi.addLibrary({ bibtex })
      setLibItems(r.items)
      setBibtex('')
      setNotice(`已存入 ${r.added} 条文献到个人共享库`)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const syncFromProject = async () => {
    if (!sourcePid || busy) return
    setBusy(true); setErr(''); setNotice('')
    try {
      const r = await sharedAssetsApi.addLibrary({ from_project_id: sourcePid })
      setLibItems(r.items)
      setNotice(`已从项目采集 ${r.added} 条不重复文献`)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const pushToProject = async () => {
    if (!targetPid || selectedIds.size === 0 || busy) return
    setBusy(true); setErr(''); setNotice('')
    try {
      const r = await sharedAssetsApi.importToProject(targetPid, [...selectedIds])
      setNotice(`已导入 ${r.imported} 条文献至所选项目`)
      setSelectedIds(new Set())
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const saveSnippet = async () => {
    if (!snpTitle.trim() || !snpCode.trim() || busy) return
    setBusy(true); setErr(''); setNotice('')
    try {
      const r = await sharedAssetsApi.saveSnippet({ title: snpTitle.trim(), category: snpCategory.trim() || '常用', code: snpCode })
      setSnippets(r.items)
      setSnpTitle('')
      setSnpCode('')
      setNotice('LaTeX 片段已保存')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const deleteLibraryItem = async (id: string) => {
    if (busy) return
    setBusy(true); setErr(''); setNotice('')
    try {
      const r = await sharedAssetsApi.deleteLibraryItem(id)
      setLibItems(r.items)
      setSelectedIds((prev) => {
        if (!prev.has(id)) return prev
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const deleteSnippet = async (sid: string) => {
    if (busy) return
    setBusy(true); setErr(''); setNotice('')
    try {
      const r = await sharedAssetsApi.deleteSnippet(sid)
      setSnippets(r.items)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4 p-4 text-sm" data-testid="shared-assets-view">
      <div className="flex flex-wrap items-center gap-2 border-b border-border pb-2">
        <button
          type="button"
          onClick={() => setTab('library')}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium',
            tab === 'library' ? 'bg-primary-soft text-primary' : 'text-fg-muted hover:bg-hover',
          )}
          data-testid="shared-tab-library"
        >
          <BookMarked aria-hidden className="size-3.5" /> 个人共享文献库 ({libItems.length})
        </button>
        <button
          type="button"
          onClick={() => setTab('snippets')}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium',
            tab === 'snippets' ? 'bg-primary-soft text-primary' : 'text-fg-muted hover:bg-hover',
          )}
          data-testid="shared-tab-snippets"
        >
          <Code2 aria-hidden className="size-3.5" /> LaTeX 常用片段库 ({snippets.length})
        </button>
      </div>

      {err && <p role="alert" className="text-xs text-danger">{err}</p>}
      {notice && <p role="status" className="text-xs text-ok">{notice}</p>}

      {tab === 'library' ? (
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-2 rounded-lg border border-border bg-panel p-3">
              <div className="text-xs font-medium text-fg-strong">从项目文献库沉淀到共享库</div>
              <div className="flex items-center gap-2">
                <select
                  value={sourcePid}
                  onChange={(e) => setSourcePid(e.target.value)}
                  className="min-w-0 flex-1 rounded border border-border bg-app px-2 py-1 text-xs"
                  aria-label="选择源论文项目"
                >
                  <option value="">选择论文项目…</option>
                  {projects.filter((p) => (p.list_state ?? 'active') === 'active').map((p) => (
                    <option key={p.id} value={p.id}>{p.title || p.id}</option>
                  ))}
                </select>
                <Button size="xs" disabled={!sourcePid || busy} onClick={() => void syncFromProject()} data-testid="shared-sync-project-btn">
                  采集文献
                </Button>
              </div>
            </div>
            <div className="space-y-2 rounded-lg border border-border bg-panel p-3">
              <div className="text-xs font-medium text-fg-strong">粘贴 BibTeX 入个人共享库</div>
              <textarea
                rows={2}
                value={bibtex}
                onChange={(e) => setBibtex(e.target.value)}
                placeholder="@article{...}"
                className="w-full rounded border border-border bg-app p-2 font-mono text-xs"
                data-testid="shared-bibtex-input"
              />
              <Button size="xs" disabled={!bibtex.trim() || busy} onClick={() => void importBibtex()} data-testid="shared-import-bibtex-btn">
                <Plus aria-hidden className="size-3" /> 解析并存入共享库
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-sunken p-2.5 text-xs">
            <span>已选 {selectedIds.size} 条 → 推送至项目：</span>
            <select
              value={targetPid}
              onChange={(e) => setTargetPid(e.target.value)}
              className="rounded border border-border bg-app px-2 py-1 text-xs"
              data-testid="shared-target-project"
              aria-label="目标导入项目"
            >
              <option value="">选择可写项目…</option>
              {editableProjects.map((p) => (
                <option key={p.id} value={p.id}>{p.title || p.id}</option>
              ))}
            </select>
            <Button size="xs" disabled={!targetPid || selectedIds.size === 0 || busy} onClick={() => void pushToProject()} data-testid="shared-push-project-btn">
              <Send aria-hidden className="size-3" /> 一键导入到项目
            </Button>
          </div>

          {libItems.length === 0 ? (
            <p className="text-xs text-fg-muted">共享文献库为空，请先从现有项目采集或粘贴 BibTeX。</p>
          ) : (
            <ul className="space-y-2">
              {libItems.map((it) => (
                <li key={it.id} className="flex items-start gap-2 rounded-lg border border-border bg-panel p-3 text-xs">
                  <input
                    type="checkbox"
                    className="mt-1 accent-primary"
                    checked={selectedIds.has(it.id)}
                    onChange={() =>
                      setSelectedIds((prev) => {
                        const nxt = new Set(prev)
                        if (nxt.has(it.id)) nxt.delete(it.id)
                        else nxt.add(it.id)
                        return nxt
                      })
                    }
                  />
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="rounded bg-sunken px-1.5 py-0.5 font-mono text-primary">{it.citation_key}</code>
                      <strong className="text-fg-strong">{it.title || '（无标题）'}</strong>
                    </div>
                    <p className="text-fg-muted">
                      {it.authors.slice(0, 3).join(', ')}
                      {it.year ? ` (${it.year})` : ''}
                      {it.venue ? ` · ${it.venue}` : ''}
                      {it.source_project ? ` · 来自「${it.source_project}」` : ''}
                    </p>
                  </div>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="text-danger"
                    disabled={busy}
                    onClick={() => void deleteLibraryItem(it.id)}
                    aria-label={`移除 ${it.citation_key}`}
                  >
                    <Trash2 aria-hidden className="size-3" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="space-y-2 rounded-lg border border-border bg-panel p-3 text-xs">
            <div className="font-medium text-fg-strong">新建自定义 LaTeX 片段（在工作台编辑器可一键插入）</div>
            <div className="flex flex-wrap gap-2">
              <input
                type="text"
                value={snpTitle}
                onChange={(e) => setSnpTitle(e.target.value)}
                placeholder="片段标题"
                className="min-w-44 flex-1 rounded border border-border bg-app px-2 py-1 text-xs"
                data-testid="snippet-title-input"
              />
              <input
                type="text"
                value={snpCategory}
                onChange={(e) => setSnpCategory(e.target.value)}
                placeholder="分类（如 表格/公式）"
                className="w-32 rounded border border-border bg-app px-2 py-1 text-xs"
              />
            </div>
            <textarea
              rows={3}
              value={snpCode}
              onChange={(e) => setSnpCode(e.target.value)}
              placeholder="\begin{figure}...\end{figure}"
              className="w-full rounded border border-border bg-app p-2 font-mono text-xs"
              data-testid="snippet-code-input"
            />
            <Button size="xs" disabled={!snpTitle.trim() || !snpCode.trim() || busy} onClick={() => void saveSnippet()} data-testid="snippet-save-btn">
              <Plus aria-hidden className="size-3" /> 保存片段
            </Button>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {snippets.map((s) => (
              <div key={s.id} className="space-y-1.5 rounded-lg border border-border bg-panel p-3 text-xs" data-testid={`snippet-card-${s.id}`}>
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <strong className="text-fg-strong">{s.title}</strong>
                    <span className="ml-2 rounded bg-sunken px-1.5 py-0.5 text-2xs text-fg-muted">{s.category}</span>
                  </div>
                  {!s.builtin && (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      className="text-danger"
                      disabled={busy}
                      onClick={() => void deleteSnippet(s.id)}
                      aria-label={`删除 ${s.title}`}
                    >
                      <Trash2 aria-hidden className="size-3" />
                    </Button>
                  )}
                </div>
                {s.description && <p className="text-fg-muted">{s.description}</p>}
                <pre className="max-h-32 overflow-auto rounded border border-border bg-app p-2 font-mono text-2xs">{s.code}</pre>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

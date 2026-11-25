import { useEffect, useState } from 'react'
import { BookOpen, ChevronDown, ChevronRight, CircleAlert, FilePlus2, Loader2, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { latexApi } from '@/lib/api/latex'
import { libraryApi, type ImportReply, type LibraryReply, type ZoteroImportSource } from '@/lib/api/library'
import { errText } from './types'
import { ZoteroImportSection } from './ZoteroImportSection'

export function ImportTab({
  pid,
  lib,
  canEdit,
  onDone,
  onError,
}: {
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
  const [zotOpen, setZotOpen] = useState(false)
  const [zotSource, setZotSource] = useState<ZoteroImportSource | null>(null)

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
      const r = await libraryApi.commit(
        pid,
        entries as unknown as Record<string, unknown>[],
        lib?.mode === 'bib' ? targetBib : null,
        baseSha,
        zotSource ?? undefined,
      )
      await onDone(
        `已导入 ${r.reference_ids.length} 条${zotSource ? `（来自 Zotero「${zotSource.group_name}」）` : ''}到 ${lib?.mode === 'bib' ? targetBib : '项目文献清单'}`,
      )
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
      <div className="mb-1 text-fg-muted">
        粘贴 BibTeX 或 GB/T 7714 引文文本（每行一条，如 Google Scholar 引用导出；或选择 .bib 文件）——解析预览逐条报错，确认后才写入：
      </div>
      <textarea
        className="h-32 w-full rounded border border-line bg-panel p-1.5 font-mono text-2xs"
        placeholder={'@article{key2020,\n  title = {…},\n  author = {…},\n  year = {2020}\n}'}
        value={text}
        onChange={(e) => setText(e.target.value)}
        data-testid="library-import-text"
      />
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          className="h-6 px-2"
          disabled={busy || !text.trim()}
          onClick={() => void doPreview()}
          data-testid="library-import-preview"
        >
          {busy ? <Loader2 aria-hidden className="size-3 animate-spin" /> : <Plus aria-hidden className="size-3" />} 解析预览
        </Button>
        <label className="cursor-pointer rounded border border-line px-1.5 py-0.5 hover:bg-hover">
          上传 .bib
          <input
            type="file"
            accept=".bib,text/plain"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (!file) return
              void file.text().then((t) => {
                setText(t)
                return doPreview(t)
              })
            }}
          />
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

      <ZoteroImportSection
        pid={pid}
        open={zotOpen}
        targetBib={targetBib}
        zotSource={zotSource}
        onSetZotSource={setZotSource}
        onPreviewEntries={(r, src) => {
          setPreview(r)
          setZotSource(src)
          setTargets(new Set(r.entries.map((_, i) => i)))
        }}
        onDone={onDone}
        onError={onError}
      />

      {preview && (
        <div className="mt-2" data-testid="library-import-preview">
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            <span>
              解析出 {preview.entries.length} 条{preview.errors.length ? `，${preview.errors.length} 条损坏已跳过` : ''}。
            </span>
            {lib?.mode === 'bib' && (
              <>
                <select
                  className="rounded border border-line bg-app px-1 py-0.5"
                  value={targetBib}
                  onChange={(e) => setTargetBib(e.target.value)}
                  data-testid="library-import-target"
                >
                  {bibFiles.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
                <span className="flex items-center gap-1 text-fg-muted">
                  <FilePlus2 aria-hidden className="size-3" />
                  <input
                    className="w-28 rounded border border-line bg-app px-1 py-0.5"
                    placeholder="新建 refs.bib"
                    value={newBibName}
                    onChange={(e) => setNewBibName(e.target.value)}
                  />
                  <Button variant="ghost" size="xs" disabled={!newBibName.trim() || !canEdit} onClick={() => void createBib()}>
                    新建
                  </Button>
                </span>
              </>
            )}
            <Button
              size="sm"
              className="ml-auto h-6 px-2"
              disabled={busy || !canEdit || targets.size === 0 || (lib?.mode === 'bib' && !targetBib)}
              onClick={() => void doCommit()}
              data-testid="library-import-commit"
            >
              确认导入 {targets.size} 条
            </Button>
          </div>
          <ul className="space-y-1">
            {preview.entries.map((e, i) => (
              <li key={i} className="rounded border border-line bg-panel p-1.5">
                <label className="flex items-start gap-1.5">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={targets.has(i)}
                    onChange={() =>
                      setTargets((prev) => {
                        const next = new Set(prev)
                        if (next.has(i)) next.delete(i)
                        else next.add(i)
                        return next
                      })
                    }
                  />
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
                          {d.kind === 'doi' ? 'DOI 与现有条目重复' : d.kind === 'arxiv' ? 'arXiv 与现有条目重复' : '疑似重复'}：
                          {d.citation_key}
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
              <span className="inline-flex items-center gap-1">
                <CircleAlert aria-hidden className="size-3" /> 第 {err.line} 行：{err.error}
              </span>
              <pre className="mt-1 max-h-16 overflow-auto whitespace-pre-wrap text-2xs opacity-80">{err.raw}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

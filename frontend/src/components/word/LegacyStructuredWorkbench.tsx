import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { StructPaperWorkbench, type StructDraftState } from '@/components/struct/StructPaperWorkbench'
import { wordApi } from '@/lib/api/word'
import { useStudio } from '@/store'

export function LegacyStructuredWorkbench({ pid }: { pid: string }) {
  return <LegacySession key={pid} pid={pid} />
}

function LegacySession({ pid }: { pid: string }) {
  const ready = useStudio((s) => s.wordEditorEnabled && s.wordEditorReady)
  const role = useStudio((s) => s.project?.role)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState<StructDraftState>({ loaded: false, dirty: false, saving: false, conflict: false })
  const active = useRef(true)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  const canConvert = ready && draft.loaded && !draft.dirty && !draft.saving && !draft.conflict && !busy
  const draftHint = busy ? '正在转换为 Word，请稍候…'
    : !draft.loaded ? '正在加载旧稿，加载完成后可转换。'
    : draft.conflict ? '旧稿存在保存冲突，请先处理冲突后再转换。'
    : draft.saving ? '旧稿正在保存，保存完成后可转换。'
    : draft.dirty ? '有未保存修改，请先保存旧稿后再转换。' : ''
  const convert = async () => {
    if (!canConvert) return
    setBusy(true); setError('')
    try {
      const next = await wordApi.convertStructured(pid)
      if (!active.current) return
      window.location.assign(`#/p/${encodeURIComponent(next.id)}`)
    } catch (e) { if (active.current) setError(e instanceof Error ? e.message : String(e)) }
    finally { if (active.current) setBusy(false) }
  }
  return <div className="flex h-dvh min-h-0 flex-col overflow-hidden">
    <div className="flex flex-wrap items-center gap-3 border-b border-border bg-panel px-3 py-2 text-xs">
      <p className="min-w-0 flex-1 text-fg-muted">此为旧版结构化稿件。请先在下方保存，再转为 Word 继续编辑；会创建新项目并保留原稿。</p>
      {(role == null || role === 'owner' || role === 'editor' || role === 'agent') && <Button variant="outline" size="sm" disabled={!canConvert} onClick={() => void convert()} data-testid="legacy-convert">从已保存稿转为 Word</Button>}
      {draftHint && <span className="text-fg-muted" role="status">{draftHint}</span>}
      {!ready && <span className="text-fg-muted">Word 编辑服务尚未就绪</span>}
      {error && <p role="alert" className="text-danger-fg">{error}</p>}
    </div>
    <div className="min-h-0 flex-1 overflow-hidden [&>div]:h-full" inert={busy} aria-busy={busy || undefined} data-testid="legacy-editor"><StructPaperWorkbench pid={pid} onDraftStateChange={setDraft} /></div>
  </div>
}

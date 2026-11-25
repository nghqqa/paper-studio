import { Button } from '@/components/ui/button'

export function LatexStatusBanners({
  canEdit,
  saving,
  draftProposal,
  draftRestored,
  conflict,
  notice,
  error,
  loadErr,
  locateFlash,
  onRestoreDraft,
  onDiscardDraft,
  onSaveNow,
  onDropRestoredDraft,
  onResolveOverwrite,
  onResolveReload,
}: {
  canEdit: boolean
  saving: boolean
  draftProposal: { path: string; content: string; savedAt: number } | null
  draftRestored: boolean
  conflict: boolean
  notice: string | null
  error: string | null
  loadErr: string
  locateFlash: string
  onRestoreDraft: () => void
  onDiscardDraft: () => void
  onSaveNow: () => void
  onDropRestoredDraft: () => void
  onResolveOverwrite: () => void
  onResolveReload: () => Promise<void>
}) {
  return (
    <>
      {draftProposal && !draftRestored && (
        <div
          role="alert"
          className="flex shrink-0 items-center gap-3 border-b border-line bg-panel px-3 py-1.5 text-xs"
          data-testid="latex-draft-proposal"
        >
          <span className="min-w-0 flex-1 text-fg-strong">
            {canEdit
              ? `检测到未保存的本地草稿（${draftProposal.path}，${new Date(draftProposal.savedAt).toLocaleString()}，约 ${draftProposal.content.length} 字符）。恢复后自动保存将暂停，由你确认后再保存。`
              : `检测到本地草稿（${draftProposal.path}），但当前为只读访问，无法提交。草稿已保留。`}
          </span>
          {canEdit && (
            <Button size="sm" data-testid="latex-draft-restore" onClick={onRestoreDraft}>
              恢复本地草稿
            </Button>
          )}
          <Button variant="ghost" size="sm" data-testid="latex-draft-discard" onClick={onDiscardDraft}>
            使用服务器版本（丢弃草稿）
          </Button>
        </div>
      )}
      {draftRestored && (
        <div
          role="status"
          className="flex shrink-0 items-center gap-3 border-b border-line bg-panel px-3 py-1.5 text-xs"
          data-testid="latex-draft-restored"
        >
          <span className="min-w-0 flex-1 text-fg-strong">
            本地草稿已恢复到编辑器（未保存）。自动保存已暂停——请核对内容后保存到服务器，或丢弃。
          </span>
          <Button size="sm" data-testid="latex-draft-save" onClick={onSaveNow} disabled={saving}>
            保存到服务器
          </Button>
          <Button variant="ghost" size="sm" data-testid="latex-draft-drop" onClick={onDropRestoredDraft}>
            丢弃草稿
          </Button>
        </div>
      )}
      {conflict && (
        <div
          role="alert"
          className="flex shrink-0 items-center gap-3 border-b border-warning/40 bg-warning/10 px-3 py-1.5 text-xs"
          data-testid="latex-conflict"
        >
          <span className="min-w-0 flex-1 text-fg-strong">{error}</span>
          <Button size="sm" data-testid="latex-conflict-overwrite" onClick={onResolveOverwrite}>
            以本地内容覆盖服务器
          </Button>
          <Button variant="ghost" size="sm" data-testid="latex-conflict-reload" onClick={() => void onResolveReload()}>
            放弃本地修改
          </Button>
        </div>
      )}
      {notice && !conflict && (
        <div role="status" className="shrink-0 border-b border-line bg-panel px-3 py-1 text-xs text-fg-muted" data-testid="latex-notice">
          {notice}
        </div>
      )}
      {error && !conflict && (
        <div role="alert" className="shrink-0 border-b border-line px-3 py-1 text-xs text-danger" data-testid="latex-error">
          {error}
        </div>
      )}
      {loadErr && (
        <div role="alert" className="shrink-0 border-b border-line px-3 py-1 text-xs text-danger">
          {loadErr}
        </div>
      )}
      {locateFlash && (
        <div role="status" className="shrink-0 border-b border-line px-3 py-1 text-xs text-warning" data-testid="latex-locate-flash">
          {locateFlash}
        </div>
      )}
    </>
  )
}

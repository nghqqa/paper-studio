import { Download, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { RebuttalArchiveView } from './RebuttalArchiveView'
import { RebuttalImportList } from './RebuttalImportList'
import { RebuttalItemDetail } from './RebuttalItemDetail'
import { EXPORTS } from './rebuttalHelpers'
import { useRebuttalState } from './useRebuttalState'

export function RebuttalPanel({
  pid,
  canEdit,
  activeFile,
  cursorLine,
  onJump,
  mode = 'latex',
}: {
  pid: string
  canEdit: boolean
  activeFile: string | null
  cursorLine: number | null
  onJump: (file: string, line: number) => void
  /** B3：word 模式不调 /comments、无源码跳转，快照锚点改挂 Word 版本列表。 */
  mode?: 'latex' | 'word'
}) {
  const rb = useRebuttalState({ pid, canEdit, activeFile, cursorLine })

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel" data-testid="rebuttal-panel">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-fg" data-testid="rebuttal-progress">
            回复信{' '}
            {rb.items.length > 0 && (
              <span className="text-fg-muted">
                已修改 {rb.addressed} / 总 {rb.items.length} 条{rb.state && rb.state.round > 0 ? ` · 第 ${rb.state.round} 轮` : ''}
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-0.5">
          {EXPORTS.map(({ fmt, label }) => (
            <Button
              key={fmt}
              variant="ghost"
              size="sm"
              className="h-6 gap-0.5 px-1.5 text-2xs"
              disabled={rb.items.length === 0 || rb.exportFmt !== null}
              onClick={() => void rb.doExport(fmt)}
              aria-label={`导出 ${label} 回复信`}
              title={`导出 ${label} 回复信`}
              data-testid={`rebuttal-export-${fmt}`}
            >
              {rb.exportFmt === fmt ? <Loader2 aria-hidden className="size-3 animate-spin" /> : <Download aria-hidden className="size-3" />}
              {label}
            </Button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-2 text-xs">
        {rb.banner && (
          <p role="alert" className="mb-2 rounded-md bg-danger/10 px-2 py-1.5 text-2xs text-danger" data-testid="rebuttal-error">
            {rb.banner}
          </p>
        )}
        {rb.notice && (
          <p className="mb-2 rounded-md bg-info-bg px-2 py-1.5 text-2xs text-info-fg" data-testid="rebuttal-notice">
            {rb.notice}
          </p>
        )}

        {(rb.rounds.length > 0 || rb.viewRound !== 'current') && (
          <div className="mb-2 flex flex-wrap items-center gap-1" data-testid="rebuttal-rounds">
            <button
              type="button"
              className={cn('rounded px-1.5 py-0.5 text-2xs', rb.viewRound === 'current' ? 'bg-primary-soft text-primary' : 'bg-sunken text-fg-muted hover:text-fg')}
              onClick={() => void rb.openRound('current')}
              data-testid="rebuttal-round-current"
            >
              第 {rb.state?.round ?? 1} 轮（当前）
            </button>
            {rb.rounds.map((r) => (
              <button
                key={r.round}
                type="button"
                className={cn('rounded px-1.5 py-0.5 text-2xs', rb.viewRound === r.round ? 'bg-primary-soft text-primary' : 'bg-sunken text-fg-muted hover:text-fg')}
                onClick={() => void rb.openRound(r.round)}
                title={`第 ${r.round} 轮归档（${r.items} 条，只读）`}
                data-testid={`rebuttal-round-${r.round}`}
              >
                第 {r.round} 轮
              </button>
            ))}
          </div>
        )}

        {rb.viewRound !== 'current' && rb.roundDetail ? (
          <RebuttalArchiveView roundDetail={rb.roundDetail} />
        ) : rb.selected && rb.form ? (
          <RebuttalItemDetail
            pid={pid}
            mode={mode}
            selected={rb.selected}
            form={rb.form}
            canEdit={canEdit}
            activeFile={activeFile}
            cursorLine={cursorLine}
            aiEnabled={rb.aiEnabled}
            aiBusy={rb.aiBusy && rb.draftItemId === rb.selected.id}
            streamingDraft={rb.draftItemId === rb.selected.id ? rb.streamingDraft : null}
            dirty={rb.dirty}
            saving={rb.saving}
            onBack={() => rb.setActiveId(null)}
            onJump={onJump}
            onPatchForm={rb.patchForm}
            onSwitchStatus={(st) => void rb.switchStatus(st)}
            onLinkCursor={rb.linkCursor}
            onRunDraft={() => void rb.runDraft()}
            onCancelDraft={rb.cancelDraft}
            onAdoptDraft={rb.adoptDraft}
            onSaveItem={() => void rb.saveItem()}
            onReload={() => void rb.load()}
          />
        ) : (
          <RebuttalImportList
            state={rb.state}
            items={rb.items}
            visible={rb.visible}
            reviewers={rb.reviewers}
            canEdit={canEdit}
            importing={rb.importing}
            loadFailed={rb.loadFailed}
            importText={rb.importText}
            importMode={rb.importMode}
            reviewer={rb.reviewer}
            status={rb.status}
            onImportText={rb.setImportText}
            onImportMode={rb.setImportMode}
            onImportPasted={rb.importPasted}
            onImportFile={rb.importFile}
            onReviewer={rb.setReviewer}
            onStatus={rb.setStatus}
            onRetry={() => void rb.load()}
            onSelectItem={(id) => rb.setActiveId(id)}
          />
        )}
      </div>
    </div>
  )
}

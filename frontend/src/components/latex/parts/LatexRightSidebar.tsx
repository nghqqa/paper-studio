import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { LibraryPanel } from '@/components/paper/LibraryPanel'
import { ProposalPanel } from '@/components/paper/ProposalPanel'
import type { AnchorLike, ApplyOutcome } from '@/components/paper/proposalApply'
import type { FixVerification } from '@/lib/api/paperProposals'
import { CommentsSidebar } from '../CommentsSidebar'
import { RebuttalPanel } from '../../rebuttal/RebuttalPanel'
import type { LatexSideTab } from './LatexTopBar'

const WIDTH_KEY = 'paper-latex-right-width'
const clampWidth = (w: number) => Math.min(640, Math.max(320, w))

export function LatexRightSidebar({
  pid,
  sideTab,
  canEdit,
  active,
  savedSha,
  dirty,
  saving,
  cursorLine,
  reloadTick,
  proposalTick,
  onClose,
  onOpenFile,
  onJump,
  onJumpPage,
  onInsertCitations,
  onLibraryChanged,
  getSelection,
  applyProposal,
  revertProposal,
  locateProposal,
  verifyProposalFix,
}: {
  pid: string
  sideTab: Exclude<LatexSideTab, null>
  canEdit: boolean
  active: string | null
  savedSha: string | null
  dirty: boolean
  saving: boolean
  cursorLine: number | null
  reloadTick: number
  proposalTick: number
  onClose?: () => void
  onOpenFile: (file: string) => Promise<void>
  onJump: (file: string, line: number | null) => void
  onJumpPage: (page: number) => void
  onInsertCitations: (entries: { citation_key: string }[], command: string) => void
  onLibraryChanged: () => void
  getSelection: () => { text: string; doc: string; from: number; to: number } | null
  applyProposal: (anchor: AnchorLike, suggested: string) => ApplyOutcome
  revertProposal: (anchor: AnchorLike, appliedText: string) => ApplyOutcome
  locateProposal: (anchor: AnchorLike & { file: string }) => void
  verifyProposalFix?: (proposalId: string) => Promise<FixVerification>
}) {
  const [width, setWidth] = useState(() => {
    try {
      const v = Number(window.localStorage.getItem(WIDTH_KEY))
      return Number.isFinite(v) && v >= 320 ? clampWidth(v) : 384
    } catch {
      return 384
    }
  })
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)
  const dragCleanupRef = useRef<(() => void) | null>(null)

  useEffect(() => () => { dragCleanupRef.current?.() }, [])

  const onResizeStart = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    dragCleanupRef.current?.()
    dragRef.current = { startX: e.clientX, startW: width }
    const onMove = (ev: PointerEvent) => {
      if (!dragRef.current) return
      const next = clampWidth(dragRef.current.startW + (dragRef.current.startX - ev.clientX))
      setWidth(next)
      try {
        window.localStorage.setItem(WIDTH_KEY, String(next))
      } catch {
        /* ignore */
      }
    }
    const cleanup = () => {
      dragRef.current = null
      dragCleanupRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', cleanup)
      window.removeEventListener('pointercancel', cleanup)
    }
    dragCleanupRef.current = cleanup
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', cleanup)
    window.addEventListener('pointercancel', cleanup)
  }

  const jumpAcrossFiles = (file: string, line: number) => {
    if (file !== active) {
      void onOpenFile(file).then(() => {
        window.setTimeout(() => onJump(file, line), 200)
      })
    } else {
      onJump(file, line)
    }
  }

  return (
    <div className="fixed inset-0 z-overlay flex justify-end md:static md:inset-auto md:z-auto md:flex md:shrink-0">
      <div
        className="flex-1 bg-bg-inverse/20 md:hidden"
        onClick={() => onClose?.()}
        aria-hidden="true"
      />
      <aside
        className="relative flex h-full w-96 max-w-[92vw] shrink-0 flex-col border-l border-line bg-panel shadow-lg md:max-w-none md:shadow-none"
        style={{ width }}
        data-testid="latex-side-panel"
      >
        <div
          className="absolute inset-y-0 left-0 hidden w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-primary/30 md:block"
          onPointerDown={onResizeStart}
          title="拖拽调整侧栏宽度"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整侧栏宽度"
        />
        {onClose && (
          <div className="flex items-center justify-end border-b border-line px-2 py-1 md:hidden">
            <button
              type="button"
              className="rounded p-1 text-fg-muted hover:bg-hover hover:text-fg"
              onClick={onClose}
              aria-label="关闭侧栏"
            >
              <X aria-hidden className="size-4" />
            </button>
          </div>
        )}
      {sideTab === 'comments' && (
        <CommentsSidebar
          pid={pid}
          activePath={active}
          savedSha={savedSha}
          dirty={dirty}
          currentLine={cursorLine}
          canEdit={canEdit}
          reloadSignal={reloadTick}
          onJump={jumpAcrossFiles}
          onJumpPage={onJumpPage}
        />
      )}
      {sideTab === 'library' && (
        <LibraryPanel
          pid={pid}
          canEdit={canEdit}
          activePath={active}
          onInsertCitations={onInsertCitations}
          onLibraryChanged={onLibraryChanged}
        />
      )}
      {sideTab === 'proposals' && (
        <ProposalPanel
          pid={pid}
          canEdit={canEdit}
          activePath={active}
          dirty={dirty}
          saving={saving}
          getSelection={getSelection}
          applyProposal={applyProposal}
          revertProposal={revertProposal}
          locateProposal={locateProposal}
          reloadSignal={proposalTick}
          verifyFix={verifyProposalFix}
        />
      )}
      {sideTab === 'rebuttal' && (
        <RebuttalPanel
          pid={pid}
          canEdit={canEdit}
          activeFile={active}
          cursorLine={cursorLine}
          onJump={jumpAcrossFiles}
        />
      )}
      </aside>
    </div>
  )
}

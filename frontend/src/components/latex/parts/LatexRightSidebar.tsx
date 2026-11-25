import { LibraryPanel } from '@/components/paper/LibraryPanel'
import { ProposalPanel } from '@/components/paper/ProposalPanel'
import type { AnchorLike, ApplyOutcome } from '@/components/paper/proposalApply'
import type { FixVerification } from '@/lib/api/paperProposals'
import { CommentsSidebar } from '../CommentsSidebar'
import { RebuttalPanel } from '../../rebuttal/RebuttalPanel'
import type { LatexSideTab } from './LatexTopBar'

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
    <aside className="hidden w-96 shrink-0 border-l border-line md:flex md:flex-col" data-testid="latex-side-panel">
      {sideTab === 'comments' && (
        <CommentsSidebar
          pid={pid}
          activePath={active}
          savedSha={savedSha}
          dirty={dirty}
          currentLine={cursorLine}
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
  )
}

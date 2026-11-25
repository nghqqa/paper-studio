import { useState } from 'react'
import { SplitPane } from '@/components/shell/SplitPane'
import { useStudio } from '@/store'
import { CrossFileSearch } from './CrossFileSearch'
import { useLatexEditorState } from './hooks/useLatexEditorState'
import { useLatexFileOps } from './hooks/useLatexFileOps'
import { useLatexReviewActions } from './hooks/useLatexReviewActions'
import { useLatexSession } from './hooks/useLatexSession'
import { useLatexSyncTex } from './hooks/useLatexSyncTex'
import { useLatexWordExport } from './hooks/useLatexWordExport'
import { LatexEditorPane } from './parts/LatexEditorPane'
import { LatexLeftSidebar, type LatexLeftSideView } from './parts/LatexLeftSidebar'
import { LatexPreviewPane } from './parts/LatexPreviewPane'
import { LatexRightSidebar } from './parts/LatexRightSidebar'
import { LatexStatusBanners } from './parts/LatexStatusBanners'
import { LatexStatusBar } from './parts/LatexStatusBar'
import { type LatexSideTab, LatexTopBar } from './parts/LatexTopBar'
import { SourcePreviewOverlay } from './parts/SourcePreviewOverlay'
import './latex-workbench.css'

/**
 * 原生 LaTeX 论文工作台编排壳：
 * - 文件树 / 跨文件大纲 / Issues / 检查 / 历史 / Git + CodeMirror 编辑器 + 高阶 PDF 预览器（SyncTeX 正反向）
 * - 状态与副作用拆分在 `./hooks/*`，视图区域拆分在 `./parts/*`。
 */
export function LatexWorkbench({ pid }: { pid: string }) {
  const project = useStudio((s) => s.project)
  const authStatus = useStudio((s) => s.authStatus)
  const userEmail = useStudio((s) => s.user?.email ?? null)
  const openCollabCenter = useStudio((s) => s.openCollabCenter)
  const role = useStudio((s) => s.project?.role) as
    | 'owner'
    | 'editor'
    | 'agent'
    | 'reviewer'
    | 'viewer'
    | null
    | undefined
  const canEdit = role == null || role === 'owner' || role === 'editor' || role === 'agent'
  const main = project?.settings?.latex?.main ?? 'main.tex'
  const engine = project?.settings?.latex?.engine ?? 'pdflatex'
  const title = project?.title ?? pid
  const userScope = authStatus === 'authed' && userEmail ? `u:${userEmail}` : 'anon'

  const [sideTab, setSideTab] = useState<LatexSideTab>(null)
  const [sideView, setSideView] = useState<LatexLeftSideView>('files')
  const [preview, setPreview] = useState<{ path: string; kind: 'image' | 'pdf' } | null>(null)
  const [symbolsOpen, setSymbolsOpen] = useState(false)
  const [searchSignal, setSearchSignal] = useState(0)

  const wordExportRef = useRefPlaceholder<((rel: string, content: string) => void) | null>(null)
  const session = useLatexSession({
    pid,
    main,
    engine,
    canEdit,
    userScope,
    onFileLoaded: (rel, content) => wordExportRef.current?.(rel, content),
  })
  const word = useLatexWordExport({ pid, ctrl: session.ctrl })
  wordExportRef.current = word.autoDetectThesis

  const syncTexRef = useRefPlaceholder<((msg: string) => void) | null>(null)
  const editor = useLatexEditorState({
    ctrl: session.ctrl,
    active: session.active,
    reloadTick: session.reloadTick,
    canEdit,
    main,
    files: session.files,
    openFile: session.openFile,
    citeDataRef: session.citeDataRef,
    contentIndex: session.contentIndex,
    onSearchOpen: () => setSearchSignal((t) => t + 1),
    onLocateFlash: (msg) => syncTexRef.current?.(msg),
  })

  const dirty = session.snap?.dirty ?? false
  const savedSha = session.snap?.savedSha ?? null
  const saving = session.snap?.saving ?? false
  const building = session.snap?.building ?? false
  const conflict = session.snap?.conflict ?? false
  const permLost = session.snap?.permLost ?? false
  const notice = session.snap?.notice ?? null
  const error = session.snap?.error ?? null
  const diagList = session.outcome?.diagnostics ?? []

  const syncTex = useLatexSyncTex({
    pid,
    previewBuildId: session.previewBuildId,
    building,
    active: session.active,
    cursorLine: editor.cursorLine,
    openFile: session.openFile,
    jumpTo: editor.jumpTo,
  })
  syncTexRef.current = syncTex.flashLocate

  const fileOps = useLatexFileOps({
    pid,
    active: session.active,
    files: session.files,
    openFile: session.openFile,
    switchFile: session.switchFile,
    reloadFiles: session.reloadFiles,
    refreshIndex: session.refreshIndex,
    onUploadedZip: () => setSideView('files'),
  })

  const review = useLatexReviewActions({
    pid,
    ctrl: session.ctrl,
    active: session.active,
    canEdit,
    openFile: session.openFile,
    refreshBuilds: session.refreshBuilds,
    setPreviewBuildId: session.setPreviewBuildId,
    setPreviewIsOld: session.setPreviewIsOld,
    setOutcome: session.setOutcome,
    setLoadErr: session.setLoadErr,
    onShowProposals: () => setSideTab('proposals'),
  })

  const pdfUrl = session.previewBuildId
    ? `/api/projects/${encodeURIComponent(pid)}/latex/builds/${session.previewBuildId}/artifacts/pdf`
    : null
  const pdfDownloadUrl = session.previewBuildId
    ? `/api/projects/${encodeURIComponent(pid)}/latex/builds/${session.previewBuildId}/artifacts/out.pdf`
    : null
  const latest = session.builds[0]
  const staleNow = Boolean(latest?.stale)
  const configStale =
    session.configStamp > 0 && latest ? new Date(latest.started_at).getTime() < session.configStamp : false
  const previewState = building
    ? 'building'
    : session.outcome && session.outcome.status === 'error'
      ? 'last-failed'
      : session.previewIsOld
        ? 'old-ok'
        : configStale
          ? '旧配置'
          : staleNow || dirty
            ? 'stale'
            : 'current'

  return (
    <div className="latex-workspace flex h-full min-h-0 flex-col bg-app text-fg" data-testid="latex-workbench">
      <LatexTopBar
        title={title}
        engine={engine}
        main={main}
        canEdit={canEdit}
        dirty={dirty}
        saving={saving}
        building={building}
        permLost={permLost}
        autoBuild={session.autoBuild}
        sideTab={sideTab}
        settingsOpen={session.settingsOpen}
        files={session.files}
        onShare={() => openCollabCenter('members')}
        onToggleSideTab={(tab) => setSideTab((v) => (v === tab ? null : tab))}
        onToggleAutoBuild={session.toggleAutoBuild}
        onSaveNow={() => session.ctrl.saveNow()}
        onBuildNow={() => session.ctrl.buildNow()}
        onCancelBuild={() => session.ctrl.cancelBuild()}
        onToggleSettings={() => session.setSettingsOpen((v) => !v)}
        onApplySettings={session.applyBuildSettings}
      />

      <LatexStatusBanners
        canEdit={canEdit}
        saving={saving}
        draftProposal={session.draftProposal}
        draftRestored={session.draftRestored}
        conflict={conflict}
        notice={notice}
        error={error}
        loadErr={session.loadErr}
        locateFlash={syncTex.locateFlash}
        onRestoreDraft={session.restoreDraftProposal}
        onDiscardDraft={session.discardDraftProposal}
        onSaveNow={() => session.ctrl.saveNow()}
        onDropRestoredDraft={session.dropRestoredDraft}
        onResolveOverwrite={() => session.ctrl.resolveOverwrite()}
        onResolveReload={session.reloadConflictFile}
      />

      <div className="flex min-h-0 flex-1">
        <LatexLeftSidebar
          pid={pid}
          sideView={sideView}
          onChangeSideView={setSideView}
          files={session.files}
          active={session.active}
          dirty={dirty}
          saving={saving}
          loadErr={session.loadErr}
          panelNote={fileOps.panelNote}
          canEdit={canEdit}
          activeFileEmpty={
            session.active !== null && session.ctrl.getPath() === session.active && session.ctrl.getContent().trim() === ''
          }
          diagList={diagList}
          outlineItems={editor.outlineItems}
          uploadRef={fileOps.uploadRef}
          zipRef={fileOps.zipRef}
          onSwitchFile={session.switchFile}
          onOpenFile={session.openFile}
          onJump={editor.jumpTo}
          onPreviewFile={setPreview}
          onNewFile={() => void fileOps.onNewFile()}
          onUploadFiles={(fs) => void fileOps.onUploadFiles(fs)}
          onUploadZip={(f) => void fileOps.onUploadZip(f)}
          onRenameFile={(p) => void fileOps.onRenameFile(p)}
          onDeleteFile={(p) => void fileOps.onDeleteFile(p)}
          onAiReview={canEdit ? review.aiReviewCurrentFile : undefined}
          onProposeFixFromDiag={canEdit ? (d) => void review.proposeFixFromDiag(d) : undefined}
          onRestoreHistory={session.handleHistoryRestore}
          onPulled={session.onPulled}
        />

        <div className="min-h-0 min-w-0 flex-1">
          <SplitPane
            storageKey="latex-split"
            min={0.25}
            left={
              <LatexEditorPane
                active={session.active}
                docStats={editor.docStats}
                canEdit={canEdit}
                saving={saving}
                dirty={dirty}
                draftRestored={session.draftRestored}
                permLost={permLost}
                autoBuild={session.autoBuild}
                building={building}
                storageOk={session.storageOk}
                symbolsOpen={symbolsOpen}
                hasPreviewBuild={Boolean(session.previewBuildId)}
                st={editor.st}
                viewRef={editor.viewRef}
                mathSel={editor.mathSel}
                onOpenCrossFileSearch={() => setSearchSignal((t) => t + 1)}
                onToggleSymbols={() => setSymbolsOpen((v) => !v)}
                onInsertSymbol={editor.insertAtCursor}
                onLocateInPdf={() => void syncTex.locateInPdf()}
              />
            }
            right={
              <LatexPreviewPane
                pid={pid}
                title={title}
                engine={engine}
                building={building}
                dirty={dirty}
                outcome={session.outcome}
                latest={latest}
                builds={session.builds}
                previewState={previewState}
                pdfUrl={pdfUrl}
                pdfDownloadUrl={pdfDownloadUrl}
                previewScroll={syncTex.previewScroll}
                diagList={diagList}
                active={session.active}
                wordProfile={word.wordProfile}
                wordExporting={word.wordExporting}
                wordResult={word.wordResult}
                wordExportErr={word.wordExportErr}
                wordHistory={word.wordHistory}
                onSelectWordProfile={word.selectWordProfile}
                onRunWordExport={() => void word.runWordExport()}
                onCloseWordResult={() => word.setWordResult(null)}
                onJumpDiag={(file, line) => {
                  if (line != null) editor.jumpToSearchHit(file, line)
                  else if (file !== session.active) void session.openFile(file)
                }}
                onInverseSync={(info) => void syncTex.onPdfClickLocate(info)}
              />
            }
          />
        </div>

        {sideTab && (
          <LatexRightSidebar
            pid={pid}
            sideTab={sideTab}
            canEdit={canEdit}
            active={session.active}
            savedSha={savedSha}
            dirty={dirty}
            saving={saving}
            cursorLine={editor.cursorLine}
            reloadTick={session.reloadTick}
            proposalTick={review.proposalTick}
            onOpenFile={session.openFile}
            onJump={editor.jumpTo}
            onJumpPage={(p) => syncTex.setPreviewScroll({ page: p, nonce: Date.now() })}
            onInsertCitations={editor.insertCitations}
            onLibraryChanged={session.onLibraryChanged}
            getSelection={editor.getSelection}
            applyProposal={editor.doApplyProposal}
            revertProposal={editor.doRevertProposal}
            locateProposal={editor.locateProposal}
            verifyProposalFix={canEdit ? review.verifyProposalFix : undefined}
          />
        )}
      </div>

      {preview && <SourcePreviewOverlay pid={pid} preview={preview} onClose={() => setPreview(null)} />}
      <CrossFileSearch index={session.contentIndex} openSignal={searchSignal} onPick={editor.jumpToSearchHit} />
      <LatexStatusBar
        active={session.active}
        dirty={dirty}
        building={building}
        latest={latest}
        staleNow={staleNow}
        onJumpToLine={(n) => {
          if (session.active) editor.jumpTo(session.active, n)
        }}
      />
    </div>
  )
}

function useRefPlaceholder<T>(init: T): { current: T } {
  const [box] = useState(() => ({ current: init }))
  return box
}

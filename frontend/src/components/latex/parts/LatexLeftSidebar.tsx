import type { RefObject } from 'react'
import { Download, FolderInput, Plus, Upload } from 'lucide-react'
import { latexApi, type LatexDiagnostic, type LatexFileInfo } from '@/lib/api/latex'
import { cn } from '@/lib/utils'
import { LatexFileTree } from '../LatexFileTree'
import { LatexGitPanel } from '../LatexGitPanel'
import { LatexHistory } from '../LatexHistory'
import { LatexIssues } from '../LatexIssues'
import { LatexPreflight } from '../LatexPreflight'

export type LatexLeftSideView = 'files' | 'outline' | 'issues' | 'preflight' | 'history' | 'git'

export function LatexLeftSidebar({
  pid,
  sideView,
  onChangeSideView,
  files,
  active,
  dirty,
  saving,
  loadErr,
  panelNote,
  canEdit,
  activeFileEmpty,
  diagList,
  outlineItems,
  uploadRef,
  zipRef,
  onSwitchFile,
  onOpenFile,
  onJump,
  onPreviewFile,
  onNewFile,
  onUploadFiles,
  onUploadZip,
  onRenameFile,
  onDeleteFile,
  onAiReview,
  onProposeFixFromDiag,
  onRestoreHistory,
  onPulled,
}: {
  pid: string
  sideView: LatexLeftSideView
  onChangeSideView: (v: LatexLeftSideView) => void
  files: LatexFileInfo[]
  active: string | null
  dirty: boolean
  saving: boolean
  loadErr: string
  panelNote: string
  canEdit: boolean
  activeFileEmpty: boolean
  diagList: LatexDiagnostic[]
  outlineItems: { file: string; level: number; title: string; line: number }[]
  uploadRef: RefObject<HTMLInputElement | null>
  zipRef: RefObject<HTMLInputElement | null>
  onSwitchFile: (path: string) => void
  onOpenFile: (path: string) => Promise<void>
  onJump: (file: string, line: number | null) => void
  onPreviewFile: (preview: { path: string; kind: 'image' | 'pdf' }) => void
  onNewFile: () => void
  onUploadFiles: (list: FileList) => void
  onUploadZip: (file: File) => void
  onRenameFile: (path: string) => void
  onDeleteFile: (path: string) => void
  onAiReview?: (file: string) => Promise<number>
  onProposeFixFromDiag?: (diag: LatexDiagnostic) => void
  onRestoreHistory: (sha: string) => Promise<string | null>
  onPulled: () => void
}) {
  return (
    <nav aria-label="工程文件" className="hidden w-72 shrink-0 flex-col border-r border-line bg-app md:flex" data-testid="latex-files">
      <div className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-line px-2 py-1" role="tablist" aria-label="侧栏视图">
        {(
          [
            ['files', '文件', 'latex-tab-files'],
            ['outline', '大纲', 'latex-tab-outline'],
            ['issues', 'Issues', 'latex-tab-issues'],
            ['preflight', '检查', 'latex-tab-preflight'],
            ['history', '历史', 'latex-tab-history'],
            ['git', '同步', 'latex-tab-git'],
          ] as const
        ).map(([id, label, testid]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={sideView === id}
            className={cn(
              'shrink-0 whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs transition-colors',
              sideView === id ? 'bg-primary-soft font-medium text-primary' : 'text-fg-muted hover:bg-hover hover:text-fg',
            )}
            onClick={() => onChangeSideView(id)}
            data-testid={testid}
          >
            {label}
          </button>
        ))}
        <span className="ml-auto flex shrink-0 items-center gap-1 text-2xs text-fg-muted" title={dirty ? '有未保存修改' : '已保存'}>
          <span aria-hidden className={cn('size-2 rounded-full', dirty || saving ? 'bg-warn-dot animate-pulse' : 'bg-ok-dot')} />
          {files.length}
        </span>
      </div>

      {sideView === 'files' ? (
        <>
          <div className="flex shrink-0 items-center gap-0.5 border-b border-line px-2 py-1">
            <span className="mr-auto text-2xs text-fg-muted">工程文件</span>
            <a
              className="grid size-6 place-items-center rounded-md text-fg-muted transition-colors hover:bg-hover hover:text-fg"
              href={latexApi.exportZipUrl(pid)}
              download
              title="下载整包 ZIP"
              data-testid="latex-files-download"
            >
              <Download aria-hidden className="size-3.5" />
            </a>
            <button
              type="button"
              className="grid size-6 place-items-center rounded-md text-fg-muted transition-colors hover:bg-hover hover:text-fg"
              title="上传文件（到当前目录；默认不覆盖同名）"
              data-testid="latex-files-upload"
              onClick={() => uploadRef.current?.click()}
            >
              <Upload aria-hidden className="size-3.5" />
            </button>
            <button
              type="button"
              className="grid size-6 place-items-center rounded-md text-fg-muted transition-colors hover:bg-hover hover:text-fg"
              title="上传 ZIP 合并入工程（不覆盖已有文件）"
              data-testid="latex-files-upload-zip"
              onClick={() => zipRef.current?.click()}
            >
              <FolderInput aria-hidden className="size-3.5" />
            </button>
            <button
              type="button"
              className="grid size-6 place-items-center rounded-md text-fg-muted transition-colors hover:bg-hover hover:text-fg"
              title="新建文件"
              data-testid="latex-files-new"
              onClick={onNewFile}
            >
              <Plus aria-hidden className="size-4" />
            </button>
          </div>
          {panelNote && (
            <div className="shrink-0 border-b border-line px-2 py-1 text-2xs leading-4 text-fg-muted" data-testid="latex-files-note">
              {panelNote}
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-auto p-2">
            <LatexFileTree
              files={files}
              active={active}
              dirty={dirty}
              onOpen={onSwitchFile}
              onPreview={(path) => onPreviewFile({ path, kind: /\.pdf$/i.test(path) ? 'pdf' : 'image' })}
              onRenameFile={onRenameFile}
              onDeleteFile={onDeleteFile}
            />
            {files.length === 0 && !loadErr && <div className="px-1 text-xs text-fg-muted">加载中…</div>}
          </div>
          <input
            ref={uploadRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              const fs = e.target.files
              if (fs?.length) onUploadFiles(fs)
              e.target.value = ''
            }}
          />
          <input
            ref={zipRef}
            type="file"
            accept=".zip"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) onUploadZip(f)
              e.target.value = ''
            }}
          />
        </>
      ) : sideView === 'outline' ? (
        <div className="min-h-0 flex-1 overflow-auto p-2 text-xs" data-testid="latex-outline-panel">
          {outlineItems.length === 0 ? (
            <p className="text-fg-muted">未检测到章节（\chapter / \section / \subsection）。</p>
          ) : (
            <ul className="space-y-0.5">
              {outlineItems.map((it, idx) => {
                const isOther = active !== null && it.file !== active
                const shortFile = it.file.includes('/') ? it.file.slice(it.file.lastIndexOf('/') + 1) : it.file
                return (
                  <li key={`${it.file}-${it.line}-${idx}`}>
                    <button
                      type="button"
                      className={cn(
                        'flex w-full items-center gap-1 rounded px-1.5 py-1 text-left text-fg hover:bg-hover',
                        it.level === 0 && 'font-medium',
                      )}
                      style={{ paddingLeft: `${Math.max(0, it.level) * 10 + 6}px` }}
                      onClick={() => {
                        if (it.file === active) {
                          onJump(it.file, it.line)
                        } else {
                          void onOpenFile(it.file).then(() => {
                            window.setTimeout(() => onJump(it.file, it.line), 120)
                          })
                        }
                      }}
                      title={`${it.file} 第 ${it.line} 行：${it.title}`}
                    >
                      <span className="min-w-0 flex-1 truncate">{it.title}</span>
                      <span className="shrink-0 text-2xs tabular-nums text-fg-muted">
                        {isOther ? `${shortFile}:` : ''}L{it.line}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      ) : sideView === 'issues' ? (
        <LatexIssues
          pid={pid}
          activeFile={active}
          activeFileEmpty={activeFileEmpty}
          diagList={diagList}
          aiReview={onAiReview}
          proposeFix={onProposeFixFromDiag}
          onJump={(file, line) => {
            if (file !== active) {
              void onOpenFile(file).then(() => {
                window.setTimeout(() => onJump(file, line), 200)
              })
            } else {
              onJump(file, line)
            }
          }}
        />
      ) : sideView === 'preflight' ? (
        <LatexPreflight pid={pid} canEdit={canEdit} />
      ) : sideView === 'history' ? (
        <LatexHistory pid={pid} canEdit={canEdit} onRestore={onRestoreHistory} />
      ) : (
        <LatexGitPanel pid={pid} canEdit={canEdit} onPulled={onPulled} />
      )}
    </nav>
  )
}

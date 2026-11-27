import { useMemo, useState, type ClipboardEvent, type DragEvent, type RefObject } from 'react'
import { openSearchPanel } from '@codemirror/search'
import type { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import katex from 'katex'
import { Code2, Crosshair, FileCode2, ImagePlus, Moon, Search, Sigma, Sun, Table2, X } from 'lucide-react'
import type { LatexFileInfo } from '@/lib/api/latex'
import { sharedAssetsApi, type LatexSnippetItem } from '@/lib/api/sharedAssets'
import { cn } from '@/lib/utils'
import type { MathPreview } from '../editorEnhancements'
import { PasteImageDialog } from '../PasteImageDialog'
import { SymbolPanel } from '../SymbolPanel'
import { TableGeneratorDialog } from '../TableGeneratorDialog'
import { CodeMirrorHost } from './CodeMirrorHost'

export function LatexEditorPane({
  pid,
  active,
  openTabs = [],
  files,
  docStats,
  wholeDocStats,
  canEdit,
  saving,
  dirty,
  draftRestored,
  permLost,
  autoBuild,
  building,
  storageOk,
  symbolsOpen,
  hasPreviewBuild,
  st,
  viewRef,
  mathPreview,
  onSwitchTab,
  onCloseTab,
  onOpenQuickSwitch,
  onOpenCrossFileSearch,
  onToggleSymbols,
  onInsertSymbol,
  onUploadedFile,
  onLocateInPdf,
}: {
  pid: string
  active: string | null
  openTabs?: string[]
  files: LatexFileInfo[]
  docStats: { cjk: number; words: number; lines: number } | null
  wholeDocStats?: { cjk: number; words: number; fileCount: number } | null
  canEdit: boolean
  saving: boolean
  dirty: boolean
  draftRestored: boolean
  permLost: boolean
  autoBuild: boolean
  building: boolean
  storageOk: boolean
  symbolsOpen: boolean
  hasPreviewBuild: boolean
  st: EditorState
  viewRef: RefObject<EditorView | null>
  mathPreview: MathPreview | null
  onSwitchTab?: (path: string) => void
  onCloseTab?: (path: string) => void
  onOpenQuickSwitch?: () => void
  onOpenCrossFileSearch: () => void
  onToggleSymbols: () => void
  onInsertSymbol: (text: string) => void
  onUploadedFile: () => void
  onLocateInPdf: () => void
}) {
  const [tableOpen, setTableOpen] = useState(false)
  const [snippetsOpen, setSnippetsOpen] = useState(false)
  const [snippets, setSnippets] = useState<LatexSnippetItem[] | null>(null)
  const [pasteOpen, setPasteOpen] = useState(false)

  const toggleSnippets = () => {
    const next = !snippetsOpen
    setSnippetsOpen(next)
    if (next && snippets === null) {
      void sharedAssetsApi
        .listSnippets()
        .then((r) => setSnippets(r.items))
        .catch(() => setSnippets([]))
    }
  }
  const [pasteFile, setPasteFile] = useState<File | null>(null)
  const [editorDark, setEditorDark] = useState(() => {
    try {
      const saved = window.localStorage.getItem('paper-latex-editor-dark')
      if (saved === '1' || saved === '0') return saved === '1'
      return document.documentElement.classList.contains('dark')
    } catch {
      return false
    }
  })
  const toggleEditorDark = () => {
    setEditorDark((prev) => {
      const next = !prev
      try {
        window.localStorage.setItem('paper-latex-editor-dark', next ? '1' : '0')
      } catch {
        /* ignore */
      }
      return next
    })
  }
  const existingPaths = useMemo(() => new Set(files.map((f) => f.path)), [files])

  const openImageModalWith = (img: File | null) => {
    if (!canEdit || !active) return
    setPasteFile(img)
    setPasteOpen(true)
  }

  const onEditorPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    if (!canEdit || !active) return
    const items = Array.from(e.clipboardData?.files ?? [])
    const img = items.find((f) => f.type.startsWith('image/'))
    if (img) {
      e.preventDefault()
      openImageModalWith(img)
    }
  }

  const onEditorDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!canEdit || !active) return
    const items = Array.from(e.dataTransfer?.files ?? [])
    const img = items.find((f) => f.type.startsWith('image/') || /\.(png|jpe?g|webp|svg|pdf)$/i.test(f.name))
    if (img) {
      e.preventDefault()
      openImageModalWith(img)
    }
  }

  return (
    <section aria-label="源码编辑" className="flex h-full min-h-0 min-w-0 flex-col" data-testid="latex-editor">
      <div className="flex min-h-8 shrink-0 flex-wrap items-center gap-2 border-b border-line px-2 py-1 text-xs text-fg-muted">
        <span className="truncate">{active ?? '未打开文件'}</span>
        {docStats && (
          <span className="shrink-0 tabular-nums text-2xs text-fg-muted" title="当前文件中文字符 / 英文词数 / 行数" data-testid="latex-doc-stats">
            {docStats.cjk} 字 · {docStats.words} 词 · {docStats.lines} 行
          </span>
        )}
        {wholeDocStats && wholeDocStats.fileCount > 1 && (
          <span
            className="shrink-0 rounded bg-sunken px-1.5 py-0.5 tabular-nums text-2xs text-fg-muted"
            title={`沿 \\input/\\include 汇总共 ${wholeDocStats.fileCount} 个源文件`}
            data-testid="latex-whole-stats"
          >
            全文 {wholeDocStats.cjk} 字 · {wholeDocStats.words} 词
          </span>
        )}
        <span className="ml-auto shrink-0" data-testid="latex-edit-state">
          {canEdit
            ? saving
              ? '保存中…'
              : dirty
                ? draftRestored
                  ? '草稿已恢复（自动保存暂停）'
                  : permLost
                    ? '未保存（无写入权限，已暂停自动保存）'
                    : '未保存（停顿后自动保存）'
                : '已保存'
            : '只读访问（可批注）'}
          {!autoBuild && canEdit && !building && ' · 编译需手动'}
          {!storageOk && ' · 本地恢复不可用'}
        </span>
        <button
          type="button"
          className="shrink-0 rounded px-1.5 py-0.5 text-xs text-fg-muted transition-colors hover:bg-hover hover:text-fg"
          title="跨文件搜索（Ctrl+Shift+F）"
          onClick={onOpenCrossFileSearch}
          data-testid="latex-crossfile-toggle"
        >
          <Search aria-hidden className="mr-0.5 inline size-3.5" />
          搜索
        </button>
        <button
          type="button"
          className="shrink-0 rounded px-1.5 py-0.5 text-xs text-fg-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-50"
          disabled={!active}
          title="当前文件查找与替换（Ctrl+F / Ctrl+H）"
          onClick={() => {
            if (viewRef.current) openSearchPanel(viewRef.current)
          }}
          data-testid="latex-find-replace"
        >
          查找替换
        </button>
        <button
          type="button"
          className={cn(
            'shrink-0 rounded px-1.5 py-0.5 text-xs transition-colors disabled:opacity-50',
            symbolsOpen ? 'bg-primary-soft text-primary' : 'text-fg-muted hover:bg-hover hover:text-fg',
          )}
          disabled={!canEdit}
          title="符号面板（点击插入到光标处）"
          onClick={onToggleSymbols}
          data-testid="latex-symbols-toggle"
        >
          <Sigma aria-hidden className="mr-0.5 inline size-3.5" />
          符号
        </button>
        <button
          type="button"
          className="shrink-0 rounded px-1.5 py-0.5 text-xs text-fg-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-50"
          disabled={!canEdit || !active}
          title="上传或粘贴截图至 figures/ 并插入 figure 环境（亦支持 Ctrl+V / 拖放图片）"
          onClick={() => openImageModalWith(null)}
          data-testid="latex-insert-image-btn"
        >
          <ImagePlus aria-hidden className="mr-0.5 inline size-3.5" />
          插图
        </button>
        <button
          type="button"
          className="shrink-0 rounded px-1.5 py-0.5 text-xs text-fg-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-50"
          disabled={!canEdit || !active}
          title="CSV / Excel 转 LaTeX booktabs 三线表"
          onClick={() => setTableOpen(true)}
          data-testid="latex-table-gen-toggle"
        >
          <Table2 aria-hidden className="mr-0.5 inline size-3.5" />
          三线表
        </button>
        <button
          type="button"
          className={cn(
            'shrink-0 rounded px-1.5 py-0.5 text-xs transition-colors disabled:opacity-50',
            snippetsOpen ? 'bg-primary-soft text-primary' : 'text-fg-muted hover:bg-hover hover:text-fg',
          )}
          disabled={!canEdit || !active}
          title="从个人片段库快速插入 LaTeX 模板代码"
          onClick={toggleSnippets}
          data-testid="latex-snippets-toggle"
        >
          <Code2 aria-hidden className="mr-0.5 inline size-3.5" />
          片段
        </button>
        <button
          type="button"
          className="shrink-0 rounded px-1.5 py-0.5 text-xs text-fg-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-50"
          disabled={!hasPreviewBuild || building || !active}
          title="在 PDF 中定位当前行（SyncTeX 正向）"
          onClick={onLocateInPdf}
          data-testid="latex-locate-pdf"
        >
          <Crosshair aria-hidden className="mr-0.5 inline size-3.5" />
          在 PDF 定位
        </button>
        <button
          type="button"
          className="shrink-0 rounded p-1 text-fg-muted transition-colors hover:bg-hover hover:text-fg"
          title={editorDark ? '切换纸白源码主题' : '切换夜间源码主题'}
          onClick={toggleEditorDark}
          data-testid="latex-editor-theme-toggle"
          aria-label="切换源码主题"
        >
          {editorDark ? <Sun aria-hidden className="size-3.5" /> : <Moon aria-hidden className="size-3.5" />}
        </button>
      </div>
      {openTabs.length > 0 && (
        <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line bg-sunken px-1.5 py-1 text-xs" data-testid="latex-open-tabs">
          {openTabs.map((tabPath) => {
            const name = tabPath.includes('/') ? tabPath.slice(tabPath.lastIndexOf('/') + 1) : tabPath
            const isCur = tabPath === active
            return (
              <div
                key={tabPath}
                className={cn(
                  'group inline-flex shrink-0 items-center gap-1 rounded px-2 py-0.5 text-2xs transition-colors',
                  isCur ? 'bg-panel font-medium text-fg-strong shadow-sm' : 'text-fg-muted hover:bg-hover hover:text-fg',
                )}
              >
                <button
                  type="button"
                  className="inline-flex items-center gap-1"
                  onClick={() => onSwitchTab?.(tabPath)}
                  title={tabPath}
                  data-testid={`latex-open-tab-${tabPath}`}
                >
                  <FileCode2 aria-hidden className="size-3 shrink-0" />
                  <span>{name}</span>
                  {isCur && dirty && <span className="text-warning">*</span>}
                </button>
                {openTabs.length > 1 && onCloseTab && (
                  <button
                    type="button"
                    className="rounded p-0.5 text-fg-muted opacity-70 hover:bg-hover hover:text-fg group-hover:opacity-100"
                    onClick={() => onCloseTab(tabPath)}
                    aria-label={`关闭 ${name}`}
                    data-testid={`latex-close-tab-${tabPath}`}
                  >
                    <X aria-hidden className="size-3" />
                  </button>
                )}
              </div>
            )
          })}
          {onOpenQuickSwitch && (
            <button
              type="button"
              className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-2xs text-fg-muted hover:bg-hover hover:text-fg"
              onClick={onOpenQuickSwitch}
              title="快速切换文件（Ctrl+P）"
              data-testid="latex-quick-open-btn"
            >
              Ctrl+P
            </button>
          )}
        </div>
      )}
      {tableOpen && (
        <TableGeneratorDialog
          open={tableOpen}
          onOpenChange={setTableOpen}
          onInsert={onInsertSymbol}
        />
      )}
      {pasteOpen && (
        <PasteImageDialog
          pid={pid}
          open={pasteOpen}
          initialFile={pasteFile}
          existingPaths={existingPaths}
          onOpenChange={setPasteOpen}
          onUploaded={onUploadedFile}
          onInsert={onInsertSymbol}
        />
      )}
      {symbolsOpen && (
        <div className="shrink-0 border-b border-line bg-panel">
          <SymbolPanel onInsert={onInsertSymbol} onClose={onToggleSymbols} />
        </div>
      )}
      {snippetsOpen && (
        <div className="max-h-40 shrink-0 overflow-auto border-b border-line bg-sunken p-2 text-xs" data-testid="latex-snippets-drawer">
          <div className="mb-1 flex items-center justify-between text-2xs text-fg-muted">
            <span>点击插入常用 LaTeX 片段（可在首页「跨项目资产」管理）</span>
            <button type="button" onClick={() => setSnippetsOpen(false)} className="hover:text-fg">收起</button>
          </div>
          {snippets === null ? (
            <span className="text-2xs text-fg-muted">正在加载片段库…</span>
          ) : snippets.length === 0 ? (
            <span className="text-2xs text-fg-muted">暂无可用片段。</span>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {snippets.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    onInsertSymbol(`\n${s.code}\n`)
                    setSnippetsOpen(false)
                  }}
                  title={s.description || s.code}
                  className="rounded border border-line bg-panel px-2 py-1 text-2xs text-fg hover:border-primary/40 hover:text-primary"
                >
                  {s.title}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <div
        className={cn('min-h-0 flex-1', editorDark && 'latex-editor-dark')}
        onPaste={onEditorPaste}
        onDragOver={(e) => {
          if (canEdit && active && e.dataTransfer?.types?.includes('Files')) e.preventDefault()
        }}
        onDrop={onEditorDrop}
        data-testid="latex-cm-host"
      >
        <CodeMirrorHost state={st} viewRef={viewRef} />
      </div>
      {mathPreview && (
        <div className="shrink-0 overflow-auto border-t border-line bg-panel px-2 py-1.5" data-testid="latex-math-preview">
          <span className="mr-1.5 text-2xs text-fg-muted">公式实时预览</span>
          <span
            className="text-fg-strong"
            dangerouslySetInnerHTML={{
              __html: katex.renderToString(mathPreview.tex, {
                throwOnError: false,
                displayMode: mathPreview.displayMode,
              }),
            }}
          />
        </div>
      )}
    </section>
  )
}

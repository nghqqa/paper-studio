import { useState, type RefObject } from 'react'
import { openSearchPanel } from '@codemirror/search'
import type { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import katex from 'katex'
import { Crosshair, Search, Sigma, Table2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { SymbolPanel } from '../SymbolPanel'
import { TableGeneratorDialog } from '../TableGeneratorDialog'
import { CodeMirrorHost } from './CodeMirrorHost'

export function LatexEditorPane({
  active,
  docStats,
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
  mathSel,
  onOpenCrossFileSearch,
  onToggleSymbols,
  onInsertSymbol,
  onLocateInPdf,
}: {
  active: string | null
  docStats: { cjk: number; words: number; lines: number } | null
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
  mathSel: string
  onOpenCrossFileSearch: () => void
  onToggleSymbols: () => void
  onInsertSymbol: (text: string) => void
  onLocateInPdf: () => void
}) {
  const [tableOpen, setTableOpen] = useState(false)
  return (
    <section aria-label="源码编辑" className="flex h-full min-h-0 min-w-0 flex-col" data-testid="latex-editor">
      <div className="flex min-h-8 shrink-0 flex-wrap items-center gap-2 border-b border-line px-2 py-1 text-xs text-fg-muted">
        <span className="truncate">{active ?? '未打开文件'}</span>
        {docStats && (
          <span className="shrink-0 tabular-nums text-2xs text-fg-muted" title="当前文件中文字符 / 英文词数 / 行数" data-testid="latex-doc-stats">
            {docStats.cjk} 字 · {docStats.words} 词 · {docStats.lines} 行
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
          title="CSV / Excel 转 LaTeX booktabs 三线表"
          onClick={() => setTableOpen(true)}
          data-testid="latex-table-gen-toggle"
        >
          <Table2 aria-hidden className="mr-0.5 inline size-3.5" />
          三线表
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
      </div>
      {tableOpen && (
        <TableGeneratorDialog
          open={tableOpen}
          onOpenChange={setTableOpen}
          onInsert={onInsertSymbol}
        />
      )}
      {symbolsOpen && (
        <div className="shrink-0 border-b border-line bg-panel">
          <SymbolPanel onInsert={onInsertSymbol} onClose={onToggleSymbols} />
        </div>
      )}
      <div className="min-h-0 flex-1" data-testid="latex-cm-host">
        <CodeMirrorHost state={st} viewRef={viewRef} />
      </div>
      {mathSel && (
        <div className="shrink-0 border-t border-line bg-panel px-2 py-1.5" data-testid="latex-math-preview">
          <span className="mr-1.5 text-2xs text-fg-muted">公式预览</span>
          <span
            className="text-fg-strong"
            dangerouslySetInnerHTML={{
              __html: katex.renderToString(mathSel, {
                throwOnError: false,
                displayMode: mathSel.trimStart().startsWith('$$'),
              }),
            }}
          />
        </div>
      )}
    </section>
  )
}

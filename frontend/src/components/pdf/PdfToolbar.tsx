import {
  ChevronDown,
  ChevronUp,
  FileDown,
  List,
  Loader2,
  Moon,
  Search,
  Sun,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ZOOM_PRESETS } from './pdfZoom'

export interface PdfToolbarProps {
  numPages: number
  currentPage: number
  pageDraft: string | null
  onPageDraftChange: (v: string | null) => void
  onGoToPage: (page: number) => void
  effectiveZoom: number
  customZoom: number
  zoomSelectValue: string
  onSelectZoomValue: (val: string) => void
  onStepZoom: (delta: number) => void
  building: boolean
  stale: boolean
  findOpen: boolean
  onToggleFind: () => void
  hasOutline: boolean
  outlineOpen: boolean
  onToggleOutline: () => void
  invert: boolean
  onToggleInvert: () => void
  downloadUrl?: string | null
  downloadFilename?: string
}

/** PDF 预览顶部紧凑工具条：页码直跳、缩放预设、查找/大纲/反色与下载 */
export default function PdfToolbar({
  numPages,
  currentPage,
  pageDraft,
  onPageDraftChange,
  onGoToPage,
  effectiveZoom,
  customZoom,
  zoomSelectValue,
  onSelectZoomValue,
  onStepZoom,
  building,
  stale,
  findOpen,
  onToggleFind,
  hasOutline,
  outlineOpen,
  onToggleOutline,
  invert,
  onToggleInvert,
  downloadUrl,
  downloadFilename,
}: PdfToolbarProps) {
  return (
    <div
      className="flex min-h-8 shrink-0 flex-wrap items-center gap-1 border-b border-line bg-panel px-2 py-1 text-xs"
      data-testid="latex-pdf-toolbar"
    >
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="上一页"
        title="上一页"
        disabled={numPages === 0 || currentPage <= 1}
        onClick={() => onGoToPage(currentPage - 1)}
        data-testid="latex-pdf-prev-page"
      >
        <ChevronUp aria-hidden />
      </Button>
      <label className="flex items-center gap-1 text-xs text-fg-muted">
        <input
          type="text"
          inputMode="numeric"
          aria-label="当前页码"
          data-testid="latex-pdf-page-input"
          className="h-xs w-11 rounded border border-line bg-surface px-1 text-center text-xs tabular-nums text-fg focus:border-accent focus:outline-none"
          value={pageDraft ?? (numPages > 0 ? String(currentPage) : '')}
          disabled={numPages === 0}
          onFocus={(e) => {
            onPageDraftChange(String(currentPage))
            e.currentTarget.select()
          }}
          onChange={(e) => onPageDraftChange(e.target.value)}
          onBlur={() => {
            if (pageDraft != null) {
              const parsed = Number.parseInt(pageDraft, 10)
              if (Number.isFinite(parsed)) onGoToPage(parsed)
              else onPageDraftChange(null)
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const parsed = Number.parseInt(pageDraft ?? '', 10)
              if (Number.isFinite(parsed)) onGoToPage(parsed)
              e.currentTarget.blur()
            } else if (e.key === 'Escape') {
              onPageDraftChange(null)
              e.currentTarget.blur()
            }
          }}
        />
        <span className="tabular-nums" data-testid="latex-pdf-total-pages">/ {numPages || '—'}</span>
      </label>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="下一页"
        title="下一页"
        disabled={numPages === 0 || currentPage >= numPages}
        onClick={() => onGoToPage(currentPage + 1)}
        data-testid="latex-pdf-next-page"
      >
        <ChevronDown aria-hidden />
      </Button>

      <span className="mx-1 h-4 w-px bg-line" aria-hidden />

      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="缩小"
        title="缩小（Ctrl+-）"
        onClick={() => onStepZoom(-0.15)}
        data-testid="latex-pdf-zoom-out"
      >
        <ZoomOut aria-hidden />
      </Button>
      <select
        aria-label="缩放比例"
        data-testid="latex-pdf-zoom-select"
        value={zoomSelectValue}
        onChange={(e) => onSelectZoomValue(e.target.value)}
        className="h-xs rounded border border-line bg-surface px-1.5 text-xs tabular-nums text-fg focus:border-accent focus:outline-none"
      >
        <option value="width">适宽（{Math.round(effectiveZoom * 100)}%）</option>
        <option value="page">适页</option>
        {ZOOM_PRESETS.map((z) => (
          <option key={z} value={String(z)}>{Math.round(z * 100)}%</option>
        ))}
        {zoomSelectValue === 'custom' && (
          <option value="custom">{Math.round(customZoom * 100)}%</option>
        )}
      </select>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="放大"
        title="放大（Ctrl++）"
        onClick={() => onStepZoom(0.15)}
        data-testid="latex-pdf-zoom-in"
      >
        <ZoomIn aria-hidden />
      </Button>

      <div className="ml-auto flex items-center gap-1">
        {building && (
          <span className="inline-flex items-center gap-1 text-2xs text-fg-muted" data-testid="latex-pdf-rebuilding">
            <Loader2 aria-hidden className="size-3 animate-spin" />
            编译更新中
          </span>
        )}
        {!building && stale && (
          <span className="text-2xs text-warning" title="源码已改，待重新编译">过期</span>
        )}
        <Button
          variant={findOpen ? 'soft' : 'ghost'}
          size="icon-xs"
          aria-label="PDF 内查找"
          title="PDF 内查找（Ctrl+F）"
          onClick={onToggleFind}
          data-testid="latex-pdf-find-toggle"
        >
          <Search aria-hidden />
        </Button>
        {hasOutline && (
          <Button
            variant={outlineOpen ? 'soft' : 'ghost'}
            size="icon-xs"
            aria-label="PDF 目录书签"
            title="PDF 目录书签"
            onClick={onToggleOutline}
            data-testid="latex-pdf-outline-toggle"
          >
            <List aria-hidden />
          </Button>
        )}
        <Button
          variant={invert ? 'soft' : 'ghost'}
          size="icon-xs"
          aria-label={invert ? '关闭护眼反色' : '开启护眼反色'}
          title={invert ? '恢复浅色纸面' : '夜间护眼反色'}
          onClick={onToggleInvert}
          data-testid="latex-pdf-invert"
        >
          {invert ? <Sun aria-hidden /> : <Moon aria-hidden />}
        </Button>
        {downloadUrl && (
          <a
            href={downloadUrl}
            download={downloadFilename ?? 'paper.pdf'}
            aria-label="下载 PDF"
            title="下载当前预览 PDF"
            data-testid="latex-pdf-toolbar-download"
            className="inline-flex h-xs items-center gap-1 rounded px-1.5 text-xs text-fg-muted hover:bg-hover hover:text-fg"
          >
            <FileDown aria-hidden className="size-3.5" />
          </a>
        )}
      </div>
    </div>
  )
}

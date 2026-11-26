import type { RefObject } from 'react'
import { ChevronLeft, ChevronRight, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

export interface PdfFindBarProps {
  inputRef: RefObject<HTMLInputElement | null>
  query: string
  normalizedQuery: string
  matchCount: number
  currentIndex: number
  onQueryChange: (q: string) => void
  onStepMatch: (delta: number) => void
  onClose: () => void
}

/** PDF 预览内置全文查找浮条（Enter / Shift+Enter 导航，Esc 关闭） */
export default function PdfFindBar({
  inputRef,
  query,
  normalizedQuery,
  matchCount,
  currentIndex,
  onQueryChange,
  onStepMatch,
  onClose,
}: PdfFindBarProps) {
  return (
    <div
      className="flex shrink-0 items-center gap-1.5 border-b border-line bg-surface px-2 py-1 text-xs"
      data-testid="latex-pdf-find-bar"
    >
      <Search aria-hidden className="size-3.5 shrink-0 text-fg-muted" />
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && matchCount > 0) {
            e.preventDefault()
            onStepMatch(e.shiftKey ? -1 : 1)
          } else if (e.key === 'Escape') {
            onClose()
          }
        }}
        placeholder="在 PDF 中查找…"
        aria-label="在 PDF 中查找"
        data-testid="latex-pdf-find-input"
        className="h-xs min-w-0 flex-1 rounded border border-line bg-panel px-2 text-xs text-fg focus:border-accent focus:outline-none"
      />
      <span className="shrink-0 text-2xs tabular-nums text-fg-muted" data-testid="latex-pdf-find-count">
        {normalizedQuery ? (matchCount ? `${currentIndex + 1} / ${matchCount}` : '0 命中') : ''}
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="上一处"
        disabled={matchCount === 0}
        onClick={() => onStepMatch(-1)}
        data-testid="latex-pdf-find-prev"
      >
        <ChevronLeft aria-hidden />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="下一处"
        disabled={matchCount === 0}
        onClick={() => onStepMatch(1)}
        data-testid="latex-pdf-find-next"
      >
        <ChevronRight aria-hidden />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="关闭查找"
        onClick={onClose}
      >
        <X aria-hidden />
      </Button>
    </div>
  )
}

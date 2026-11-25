import { useState } from 'react'
import { BookOpen, Eraser, ListOrdered, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CITATION_STYLE_LABELS, type CitationStyle } from './types'

export function WordBibToolbar({
  canEdit,
  onUpdateBibliography,
  bibliographyBusy,
  citationStyle,
  onCitationStyleChange,
  onStripBibMarkers,
  stripBibMarkersBusy,
  onRenumberCitations,
  renumberBusy,
}: {
  canEdit: boolean
  onUpdateBibliography: () => void
  bibliographyBusy: boolean
  citationStyle?: CitationStyle
  onCitationStyleChange?: (s: CitationStyle) => void
  onStripBibMarkers?: () => void
  stripBibMarkersBusy: boolean
  onRenumberCitations?: (style?: CitationStyle) => void | Promise<unknown>
  renumberBusy: boolean
}) {
  const [hideWordGuide, setHideWordGuide] = useState(() => {
    try {
      return localStorage.getItem('paper-studio:hide-word-cite-guide') === '1'
    } catch {
      return false
    }
  })

  const dismissWordGuide = () => {
    setHideWordGuide(true)
    try {
      localStorage.setItem('paper-studio:hide-word-cite-guide', '1')
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="shrink-0 space-y-1.5 border-b border-line px-2 py-2">
      {!hideWordGuide && (
        <div
          className="flex items-start gap-1.5 rounded border border-line bg-panel px-2 py-1.5 text-2xs leading-relaxed text-fg-muted"
          data-testid="word-cite-guide"
        >
          <span className="min-w-0 flex-1">
            <strong className="text-fg">3 步上手：</strong>① 正文点好光标 → ② 点下方文献右侧「引用」插{' '}
            <code className="font-mono">[n]</code>（多篇可先勾选再合并插）→ ③ 点下方主按钮生成文末列表
          </span>
          <button
            type="button"
            className="shrink-0 rounded p-0.5 text-fg-muted hover:text-fg"
            aria-label="隐藏上手提示"
            onClick={dismissWordGuide}
          >
            <X aria-hidden className="size-3" />
          </button>
        </div>
      )}
      <Button
        size="sm"
        className="h-8 w-full text-sm"
        onClick={onUpdateBibliography}
        disabled={bibliographyBusy || !canEdit}
        title="扫描正文中的 [n] 编号，自动按所选期刊格式生成或更新文末参考文献列表"
        data-testid="library-update-bibliography"
      >
        {bibliographyBusy ? <Loader2 aria-hidden className="size-3 animate-spin" /> : <BookOpen aria-hidden className="size-3" />}
        更新文末参考文献
      </Button>
      <div className="flex items-center gap-1.5">
        {citationStyle && onCitationStyleChange && (
          <label className="flex min-w-0 flex-1 items-center gap-1 text-xs text-fg-muted" data-testid="library-citation-style-row">
            <span className="shrink-0">格式</span>
            <select
              className="min-w-0 flex-1 rounded border border-line bg-app px-1 py-0.5 text-xs text-fg"
              value={citationStyle}
              onChange={(e) => onCitationStyleChange(e.target.value as CitationStyle)}
              data-testid="library-citation-style"
            >
              {(Object.keys(CITATION_STYLE_LABELS) as CitationStyle[]).map((s) => (
                <option key={s} value={s}>
                  {CITATION_STYLE_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
        )}
        {onRenumberCitations && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 shrink-0 px-2 text-xs"
            onClick={() => void onRenumberCitations(citationStyle)}
            disabled={renumberBusy || !canEdit}
            title="调整过段落顺序导致编号乱序或断号时，点此按正文首次出现顺序重排全文 [n] 并重建文末列表"
            data-testid="library-renumber-citations"
          >
            {renumberBusy ? <Loader2 aria-hidden className="size-3 animate-spin" /> : <ListOrdered aria-hidden className="size-3" />}
            重排编号
          </Button>
        )}
      </div>
      {onStripBibMarkers && (
        <details className="text-2xs text-fg-muted" data-testid="library-finalize-details">
          <summary className="cursor-pointer select-none py-0.5 hover:text-fg">定稿前整理（去掉文末平台标记）</summary>
          <div className="mt-1 space-y-1 rounded border border-line bg-panel p-1.5">
            <p className="leading-relaxed">
              投稿前点此移除文末「[参考文献-平台生成]」与「（完）」两行提示，已排版好的文献条目原样保留。
            </p>
            <Button
              variant="outline"
              size="sm"
              className="h-7 w-full text-xs"
              onClick={onStripBibMarkers}
              disabled={stripBibMarkersBusy || !canEdit}
              data-testid="library-strip-bib-markers"
            >
              {stripBibMarkersBusy ? <Loader2 aria-hidden className="size-3 animate-spin" /> : <Eraser aria-hidden className="size-3" />}
              定稿前清理托管标记
            </Button>
          </div>
        </details>
      )}
    </div>
  )
}

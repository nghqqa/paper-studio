import type { MouseEvent } from 'react'
import { Document, Page } from 'react-pdf'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { RotateCw } from 'lucide-react'
import 'react-pdf/dist/Page/TextLayer.css'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import { pdfDocumentOptions } from '@/lib/pdfjs'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  GAP,
  type InversePing,
  MIN_PAGE_WIDTH,
  type OutlineNode,
  PAD_X,
  type PageLayout,
  type PtSize,
  type Slot,
  type SyncHighlight,
} from './pdfTypes'
import { A4_PT_H, A4_PT_W } from './pdfZoom'

export function PdfFailBox({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="my-6 flex flex-col items-center gap-2" role="alert">
      <p className="text-xs text-danger-fg">PDF 解析失败</p>
      <Button variant="ghost" size="sm" onClick={onRetry} data-testid="latex-pdf-retry">
        <RotateCw aria-hidden className="size-3.5" />
        重试
      </Button>
    </div>
  )
}

export interface PdfDocumentSlotProps {
  slot: Slot
  slotIndex: 0 | 1
  isActive: boolean
  options: typeof pdfDocumentOptions
  maxRenderedWidth: number
  boxWidth: number
  pageLayouts: PageLayout[]
  range: { from: number; to: number }
  invert: boolean
  textRenderer?: (args: { str: string; pageNumber: number; itemIndex: number }) => string
  syncHighlight: SyncHighlight | null
  inversePing: InversePing | null
  inverseSyncEnabled: boolean
  onGoToPage: (page: number) => void
  onDocLoaded: (
    slotIndex: 0 | 1,
    slot: Slot,
    doc: PDFDocumentProxy,
    defaultPt: PtSize,
    outline: OutlineNode[],
  ) => void
  onDocError: (url: string) => void
  onRetry: () => void
  onPageSize: (slotIndex: 0 | 1, page: number, w: number, h: number) => void
  onStagingPageSettled: (slotIndex: 0 | 1, page: number) => void
  onInverseSyncTrigger: (e: MouseEvent<HTMLDivElement>, layout: PageLayout) => void
}

/** 单个双缓冲 PDF 渲染槽（Document + 视口虚拟化 Page + SyncTeX 高亮与反向脉冲） */
export default function PdfDocumentSlot({
  slot,
  slotIndex,
  isActive,
  options,
  maxRenderedWidth,
  boxWidth,
  pageLayouts,
  range,
  invert,
  textRenderer,
  syncHighlight,
  inversePing,
  inverseSyncEnabled,
  onGoToPage,
  onDocLoaded,
  onDocError,
  onRetry,
  onPageSize,
  onStagingPageSettled,
  onInverseSyncTrigger,
}: PdfDocumentSlotProps) {
  return (
    <div
      style={{ width: maxRenderedWidth }}
      className={cn(
        'mx-auto flex flex-col items-center',
        !isActive && 'pointer-events-none invisible absolute inset-x-0 top-3',
      )}
      aria-hidden={!isActive}
      data-testid={isActive ? 'latex-pdf-active' : 'latex-pdf-staging'}
    >
      <Document
        file={slot.file}
        options={options}
        loading={null}
        error={isActive ? <PdfFailBox onRetry={onRetry} /> : null}
        externalLinkTarget="_blank"
        onItemClick={({ pageNumber }) => {
          if (pageNumber) onGoToPage(pageNumber)
        }}
        onLoadSuccess={(doc) => {
          void Promise.all([
            doc
              .getPage(1)
              .then((p) => {
                const v = p.getViewport({ scale: 1 })
                return { w: v.width || A4_PT_W, h: v.height || A4_PT_H }
              })
              .catch(() => ({ w: A4_PT_W, h: A4_PT_H })),
            typeof doc.getOutline === 'function' ? doc.getOutline().catch(() => []) : Promise.resolve([]),
          ]).then(([defaultPt, rawOutline]) => {
            const outline = Array.isArray(rawOutline) ? (rawOutline as OutlineNode[]) : []
            onDocLoaded(slotIndex, slot, doc, defaultPt, outline)
          })
        }}
        onLoadError={() => onDocError(slot.url)}
        className="flex flex-col items-center"
      >
        {Array.from({ length: slot.numPages }, (_, i) => {
          const n = i + 1
          const layout = pageLayouts[i]
          const w = layout?.width ?? Math.max(MIN_PAGE_WIDTH, boxWidth - PAD_X)
          const h = layout?.height ?? Math.round(w * (A4_PT_H / A4_PT_W))
          const inRange = n >= range.from && n <= range.to
          const hasHighlight = isActive && syncHighlight?.page === n
          const hasPing = isActive && inversePing?.page === n
          return (
            <div
              key={n}
              style={{ width: w, height: h, marginBottom: n < slot.numPages ? GAP : 0 }}
              className="relative select-text rounded-xs bg-paper text-paper-fg shadow-paper"
              data-page={n}
              onDoubleClick={(e) => {
                if (!layout) return
                onInverseSyncTrigger(e, layout)
              }}
              onClick={(e) => {
                if (!layout || !(e.ctrlKey || e.metaKey)) return
                onInverseSyncTrigger(e, layout)
              }}
              title={inverseSyncEnabled ? '双击或 Ctrl+点击跳转到对应源码行' : undefined}
            >
              <div style={invert ? { filter: 'invert(0.9) hue-rotate(180deg)' } : undefined}>
                {inRange && (
                  <Page
                    pageNumber={n}
                    width={w}
                    renderAnnotationLayer
                    customTextRenderer={textRenderer}
                    loading={null}
                    onLoadSuccess={(page) => {
                      const v = page.getViewport({ scale: 1 })
                      if (!v.width || !v.height) return
                      onPageSize(slotIndex, n, v.width, v.height)
                    }}
                    onRenderSuccess={() => onStagingPageSettled(slotIndex, n)}
                    onRenderError={() => onStagingPageSettled(slotIndex, n)}
                  />
                )}
              </div>
              {hasHighlight && syncHighlight && (
                <div
                  aria-hidden
                  data-testid="latex-pdf-synctex-highlight"
                  className="pointer-events-none absolute inset-x-0 h-5 -translate-y-1/2 border-y border-accent bg-accent/20 transition-opacity"
                  style={{ top: `${syncHighlight.yFrac * 100}%` }}
                >
                  <span
                    className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent"
                    style={{ left: `${syncHighlight.xFrac * 100}%` }}
                  />
                </div>
              )}
              {hasPing && inversePing && (
                <span
                  aria-hidden
                  data-testid="latex-pdf-inverse-ping"
                  className="pointer-events-none absolute size-4 -translate-x-1/2 -translate-y-1/2 animate-ping rounded-full bg-accent/50"
                  style={{ left: `${inversePing.xFrac * 100}%`, top: `${inversePing.yFrac * 100}%` }}
                />
              )}
            </div>
          )
        })}
      </Document>
    </div>
  )
}

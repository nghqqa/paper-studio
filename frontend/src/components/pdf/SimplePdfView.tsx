import { useEffect, useRef, useState } from 'react'
import { Document, Page } from 'react-pdf'
import { pdfDocumentOptions } from '@/lib/pdfjs'
import 'react-pdf/dist/Page/TextLayer.css'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import { Loader2, RotateCw } from 'lucide-react'
import { withFetchTimeout } from '@/lib/api'
import { Button } from '@/components/ui/button'

/**
 * 轻量 PDF 预览组件（Structured 预览、LaTeX 素材 PDF 弹层等通用只读场景）：
 * 由宿主 `lazy()` 引入，避免将依赖 DOMMatrix 的 pdfjs-dist 拉入测试环境。
 */
export default function SimplePdfView({ url, width: fixedWidth, scrollToPage, onPageClick }: {
  url: string
  width?: number
  scrollToPage?: number | null
  onPageClick?(info: { page: number; xPt: number; yPt: number }): void
}) {
  const [pages, setPages] = useState(0)
  const [measuredWidth, setMeasuredWidth] = useState<number | undefined>(undefined)
  const width = fixedWidth != null ? Math.max(120, fixedWidth) : measuredWidth
  const pageSizePt = useRef<Record<number, { w: number; h: number }>>({})
  const pageWrapRefs = useRef<Record<number, HTMLDivElement | null>>({})

  useEffect(() => {
    if (!scrollToPage) return
    const el = pageWrapRefs.current[scrollToPage]
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'start', behavior: 'smooth' })
    }
  }, [scrollToPage, pages])

  const [file, setFile] = useState<{ data: Uint8Array } | null>(null)
  const [loadErr, setLoadErr] = useState(false)
  const [retryTick, setRetryTick] = useState(0)
  const retriedFor = useRef<string | null>(null)

  const scheduleRetry = (u: string) => {
    if (retriedFor.current === u) {
      setLoadErr(true)
      return
    }
    retriedFor.current = u
    window.setTimeout(() => setRetryTick((t) => t + 1), 800)
  }

  useEffect(() => {
    const ctrl = new AbortController()
    fetch(url, { signal: withFetchTimeout(ctrl.signal), cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        setLoadErr(false)
        setFile({ data: new Uint8Array(await r.arrayBuffer()) })
      })
      .catch(() => {
        if (!ctrl.signal.aborted) scheduleRetry(url)
      })
    return () => ctrl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, retryTick])

  return (
    <div
      className="flex flex-col items-center gap-3 p-3"
      ref={(el) => {
        if (el && fixedWidth == null) {
          const w = Math.min(794, Math.max(120, el.clientWidth - 24))
          if (w !== measuredWidth) setMeasuredWidth(w)
        }
      }}
    >
      <Document
        file={file}
        options={pdfDocumentOptions}
        onLoadSuccess={(d) => setPages(d.numPages)}
        onLoadError={() => scheduleRetry(url)}
        loading={<Loader2 className="size-5 animate-spin text-fg-muted" aria-label="加载中" />}
        error={<FailBox onRetry={() => setRetryTick((t) => t + 1)} />}
        noData={
          loadErr ? (
            <FailBox onRetry={() => setRetryTick((t) => t + 1)} />
          ) : (
            <Loader2 className="size-5 animate-spin text-fg-muted" aria-label="加载中" />
          )
        }
      >
        {Array.from({ length: pages }, (_, i) => (
          <div
            key={i}
            className="mb-3 shadow-sm"
            ref={(el) => { pageWrapRefs.current[i + 1] = el }}
            onClick={onPageClick && width
              ? (e) => {
                  const rect = e.currentTarget.getBoundingClientRect()
                  if (rect.width === 0 || rect.height === 0) return
                  const dims = pageSizePt.current[i + 1]
                  const rx = (e.clientX - rect.left) / rect.width
                  const ry = (e.clientY - rect.top) / rect.height
                  const wPt = dims?.w ?? rect.width * 0.75
                  const hPt = dims?.h ?? rect.height * 0.75
                  onPageClick({ page: i + 1, xPt: rx * wPt, yPt: ry * hPt })
                }
              : undefined}
          >
            <Page
              pageNumber={i + 1}
              width={width}
              renderAnnotationLayer={false}
              onLoadSuccess={onPageClick
                ? (page) => {
                    const v = page.getViewport({ scale: 1 })
                    pageSizePt.current[page.pageNumber ?? i + 1] = { w: v.width, h: v.height }
                  }
                : undefined}
              error={
                <p className="text-xs text-fg-muted" role="alert" data-testid="attachment-pdf-page-error">
                  第 {i + 1} 页渲染失败
                </p>
              }
            />
          </div>
        ))}
      </Document>
      {pages > 0 && <span className="text-xs text-fg-muted tabular">{pages} 页</span>}
    </div>
  )
}

function FailBox({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <p className="text-xs text-danger-fg">PDF 加载失败</p>
      <Button variant="ghost" size="sm" onClick={onRetry} data-testid="attachment-pdf-retry">
        <RotateCw aria-hidden className="size-3.5" />
        重试
      </Button>
    </div>
  )
}

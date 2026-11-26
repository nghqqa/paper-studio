import {
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { Loader2, RotateCw } from 'lucide-react'
import { pdfDocumentOptions } from '@/lib/pdfjs'
import { withFetchTimeout } from '@/lib/api'
import { FOCUS_RING_INSET, cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { extractPageTexts, findMatches, highlightHtml } from './pdfFind'
import { A4_PT_H, A4_PT_W, ZOOM_PRESETS, type ZoomFit, clampZoom } from './pdfZoom'
import PdfDocumentSlot from './PdfDocumentSlot'
import PdfFindBar from './PdfFindBar'
import PdfOutlineDrawer from './PdfOutlineDrawer'
import PdfToolbar from './PdfToolbar'
import {
  clamp01,
  computePageLayouts,
  computeVisibleRange,
  type InversePing,
  type LatexPdfViewerProps,
  MIN_PAGE_WIDTH,
  type OutlineNode,
  OVERSCAN,
  PAD_X,
  type PageLayout,
  type PtSize,
  scrollToY,
  type Slot,
  SWAP_TIMEOUT_MS,
  type SyncHighlight,
} from './pdfTypes'

export type { InverseSyncInfo, LatexPdfViewerProps, SyncTexTarget } from './pdfTypes'

/**
 * LaTeX 专属高阶 PDF 预览器：
 * - 双缓冲无闪白热更新（旧稿保留至新稿视口页就绪，自动保持滚动位置） + Windows 文件锁 800ms 自动重试一次
 * - 基于每页真实宽高比的虚拟化渲染（仅挂载视口 ± 1 页，支持单栏/双栏/IEEE/Beamer 等多种版式）
 * - 精准 SyncTeX 正向高亮带（nonce 驱动，支持同页重复定位）与反向源码跳转（双击 / Ctrl+Click，修复顶左原点 yPt，且不干扰选字复制）
 * - 内置工具条：页码直跳、适宽/适页/百分比缩放（无 794px 硬顶）、Ctrl+滚轮缩放、全文查找高亮、PDF 书签大纲、夜间反色、注解超链接跳转
 */
export default function LatexPdfViewer({
  url,
  downloadUrl,
  downloadFilename,
  jumpTarget,
  onInverseSync,
  building = false,
  stale = false,
  className,
}: LatexPdfViewerProps) {
  const scroller = useRef<HTMLDivElement>(null)
  const findInputRef = useRef<HTMLInputElement>(null)
  const [box, setBox] = useState({ w: 600, h: 800 })
  const [slots, setSlots] = useState<[Slot | null, Slot | null]>([null, null])
  const [active, setActive] = useState<0 | 1>(0)
  const [staging, setStaging] = useState<0 | 1 | null>(null)
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const [retryTick, setRetryTick] = useState(0)
  const activeRef = useRef<0 | 1>(0)
  const retriedFor = useRef<string | null>(null)
  const retryTimer = useRef<number | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const stagingRendered = useRef<Set<number>>(new Set())

  const [fit, setFit] = useState<ZoomFit>('width')
  const [customZoom, setCustomZoom] = useState(1)
  const [currentPage, setCurrentPage] = useState(1)
  const [pageDraft, setPageDraft] = useState<string | null>(null)
  const [range, setRange] = useState({ from: 1, to: 1 + OVERSCAN * 2 })
  const [invert, setInvert] = useState(false)
  const [outlineOpen, setOutlineOpen] = useState(false)

  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findIdx, setFindIdx] = useState(0)

  const [syncHighlight, setSyncHighlight] = useState<SyncHighlight | null>(null)
  const [inversePing, setInversePing] = useState<InversePing | null>(null)
  const lastJumpNonce = useRef<number | null>(null)

  useEffect(() => {
    const el = scroller.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => {
      const w = Math.round(e.contentRect.width)
      const h = Math.round(e.contentRect.height)
      if (w > 0 && h > 0) setBox((b) => (b.w === w && b.h === h ? b : { w, h }))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const shown = url ? slots[active] : null
  const numPages = shown?.numPages ?? 0
  const effectiveFailed = !!url && failedUrl === url

  const scheduleRetry = useCallback((u: string) => {
    if (retriedFor.current === u) {
      setFailedUrl(u)
      return
    }
    retriedFor.current = u
    if (retryTimer.current != null) window.clearTimeout(retryTimer.current)
    retryTimer.current = window.setTimeout(() => {
      retryTimer.current = null
      setRetryTick((t) => t + 1)
    }, 800)
  }, [])

  useEffect(() => () => {
    if (retryTimer.current != null) window.clearTimeout(retryTimer.current)
  }, [])

  useEffect(() => {
    if (!url) {
      abortRef.current?.abort()
      return
    }
    const curActive = slots[activeRef.current]
    if (curActive?.url === url && failedUrl !== url && retryTick === 0) return

    const ctrl = new AbortController()
    abortRef.current?.abort()
    abortRef.current = ctrl
    void (async () => {
      try {
        const res = await fetch(url, { signal: withFetchTimeout(ctrl.signal), cache: 'no-store' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = new Uint8Array(await res.arrayBuffer())
        if (ctrl.signal.aborted) return

        const hasForeground = !!slots[activeRef.current]?.doc
        const nextIdx: 0 | 1 = hasForeground ? (activeRef.current === 0 ? 1 : 0) : activeRef.current
        stagingRendered.current = new Set()
        setFailedUrl((prev) => (prev === url ? null : prev))
        setSlots((s) => {
          const next: [Slot | null, Slot | null] = [s[0], s[1]]
          next[nextIdx] = {
            url,
            file: { data },
            numPages: 0,
            defaultPt: { w: A4_PT_W, h: A4_PT_H },
            pageSizes: {},
          }
          return next
        })
        if (hasForeground) {
          setStaging(nextIdx)
        } else {
          activeRef.current = nextIdx
          setActive(nextIdx)
          setStaging(null)
        }
      } catch {
        if (!ctrl.signal.aborted) scheduleRetry(url)
      }
    })()
    return () => ctrl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, retryTick, scheduleRetry])

  const pageLayouts = useMemo<PageLayout[]>(
    () => computePageLayouts(shown, box, fit, customZoom),
    [shown, box, fit, customZoom],
  )

  const totalHeight = useMemo(() => {
    if (!pageLayouts.length) return 0
    const last = pageLayouts[pageLayouts.length - 1]
    return last.top + last.height
  }, [pageLayouts])

  const effectiveZoom = useMemo(() => {
    if (!pageLayouts.length) return fit === 'custom' ? customZoom : 1
    const first = pageLayouts[0]
    const basePx = first.ptW * (96 / 72)
    return basePx > 0 ? Math.round((first.width / basePx) * 100) / 100 : 1
  }, [pageLayouts, fit, customZoom])

  const maxRenderedWidth = useMemo(
    () => pageLayouts.reduce((mx, l) => Math.max(mx, l.width), MIN_PAGE_WIDTH),
    [pageLayouts],
  )

  const prevTotalH = useRef(0)
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && prevTotalH.current > 0 && totalHeight > 0 && prevTotalH.current !== totalHeight) {
      const anchor = el.scrollTop + el.clientHeight / 3
      const nextTop = (anchor / prevTotalH.current) * totalHeight - el.clientHeight / 3
      scrollToY(el, nextTop, 'auto')
    }
    prevTotalH.current = totalHeight
  }, [totalHeight])

  const updateRange = useCallback(() => {
    const el = scroller.current
    if (!el || !pageLayouts.length) return
    const next = computeVisibleRange(pageLayouts, el.scrollTop, el.clientHeight || box.h)
    setCurrentPage(next.currentPage)
    setRange((r) => (r.from === next.from && r.to === next.to ? r : { from: next.from, to: next.to }))
  }, [pageLayouts, box.h])

  useEffect(() => {
    updateRange()
  }, [updateRange])

  const rafId = useRef(0)
  const onScroll = useCallback(() => {
    if (rafId.current || typeof requestAnimationFrame === 'undefined') return
    rafId.current = requestAnimationFrame(() => {
      rafId.current = 0
      updateRange()
    })
  }, [updateRange])

  const goToPage = useCallback(
    (page: number, behavior: ScrollBehavior = 'smooth') => {
      const el = scroller.current
      if (!el || !pageLayouts.length) return
      const clamped = Math.min(pageLayouts.length, Math.max(1, Math.round(page)))
      const l = pageLayouts[clamped - 1]
      scrollToY(el, l.top - 8, behavior)
      setCurrentPage(clamped)
      setPageDraft(null)
    },
    [pageLayouts],
  )

  useEffect(() => {
    if (!jumpTarget || jumpTarget.nonce === lastJumpNonce.current || !pageLayouts.length) return
    const el = scroller.current
    if (!el) return
    lastJumpNonce.current = jumpTarget.nonce
    const clampedPage = Math.min(pageLayouts.length, Math.max(1, Math.round(jumpTarget.page)))
    const l = pageLayouts[clampedPage - 1]
    const yFrac = jumpTarget.yPt != null && l.ptH > 0 ? clamp01(jumpTarget.yPt / l.ptH) : 0
    const xFrac = jumpTarget.xPt != null && l.ptW > 0 ? clamp01(jumpTarget.xPt / l.ptW) : 0.1
    const yPx = l.top + yFrac * l.height
    const targetTop = jumpTarget.yPt != null ? yPx - (el.clientHeight || box.h) / 3 : l.top - 8
    scrollToY(el, targetTop, 'smooth')
    setCurrentPage(clampedPage)
    setSyncHighlight({ page: clampedPage, xFrac, yFrac, nonce: jumpTarget.nonce })
    const t = window.setTimeout(() => {
      setSyncHighlight((cur) => (cur?.nonce === jumpTarget.nonce ? null : cur))
    }, 1800)
    return () => window.clearTimeout(t)
  }, [jumpTarget, pageLayouts, box.h])

  const trySwap = useCallback(
    (idx: 0 | 1) => {
      const slot = slots[idx]
      if (!slot || !slot.numPages) return
      const to = Math.min(slot.numPages, range.to)
      for (let p = range.from; p <= to; p++) {
        if (!stagingRendered.current.has(p)) return
      }
      activeRef.current = idx
      setActive(idx)
      setStaging(null)
    },
    [slots, range],
  )

  useEffect(() => {
    if (staging !== null) trySwap(staging)
  }, [staging, trySwap])

  useEffect(() => {
    if (staging === null) return
    const t = window.setTimeout(() => {
      const slot = slots[staging]
      if (slot?.numPages) {
        activeRef.current = staging
        setActive(staging)
        setStaging(null)
      } else {
        setStaging(null)
        if (slot) setFailedUrl(slot.url)
      }
    }, SWAP_TIMEOUT_MS)
    return () => window.clearTimeout(t)
  }, [staging, slots])

  const normalizedQuery = findOpen ? findQuery.trim() : ''
  useEffect(() => {
    if (!normalizedQuery || !shown?.doc || shown.texts) return
    let cancelled = false
    const doc = shown.doc
    const targetUrl = shown.url
    void extractPageTexts(doc).then((texts) => {
      if (cancelled) return
      setSlots((s) =>
        s.map((slot) => (slot && slot.url === targetUrl && slot.doc === doc ? { ...slot, texts } : slot)) as [
          Slot | null,
          Slot | null,
        ],
      )
    })
    return () => {
      cancelled = true
    }
  }, [normalizedQuery, shown?.doc, shown?.url, shown?.texts])

  const matches = useMemo(
    () => (normalizedQuery && shown?.texts ? findMatches(shown.texts, normalizedQuery) : []),
    [normalizedQuery, shown?.texts],
  )
  const clampedFindIdx = matches.length ? Math.min(matches.length - 1, Math.max(0, findIdx)) : 0
  const currentMatch = matches.length ? matches[clampedFindIdx] : null

  useEffect(() => {
    const el = scroller.current
    if (!el || !currentMatch || !pageLayouts.length) return
    const l = pageLayouts[currentMatch.page - 1]
    if (!l) return
    const top = l.top + currentMatch.yFrac * l.height - (el.clientHeight || box.h) / 2
    scrollToY(el, top, 'smooth')
  }, [currentMatch, pageLayouts, box.h])

  const textRenderer = useMemo(() => {
    if (!normalizedQuery) return undefined
    return ({ str, pageNumber, itemIndex }: { str: string; pageNumber: number; itemIndex: number }) =>
      highlightHtml(
        str,
        normalizedQuery,
        currentMatch && currentMatch.page === pageNumber && currentMatch.item === itemIndex ? currentMatch.start : -1,
      )
  }, [normalizedQuery, currentMatch])

  const effectiveZoomRef = useRef(effectiveZoom)
  effectiveZoomRef.current = effectiveZoom
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const delta = e.deltaY < 0 ? 0.1 : -0.1
      setFit('custom')
      setCustomZoom(clampZoom(effectiveZoomRef.current + delta))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const onRegionKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const mod = e.ctrlKey || e.metaKey
    if (mod && !e.altKey && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault()
      setFindOpen(true)
      window.setTimeout(() => findInputRef.current?.focus(), 0)
      return
    }
    if (mod && !e.altKey && (e.key === '=' || e.key === '+')) {
      e.preventDefault()
      setFit('custom')
      setCustomZoom(clampZoom(effectiveZoom + 0.15))
      return
    }
    if (mod && !e.altKey && e.key === '-') {
      e.preventDefault()
      setFit('custom')
      setCustomZoom(clampZoom(effectiveZoom - 0.15))
      return
    }
    if (mod && !e.altKey && e.key === '0') {
      e.preventDefault()
      setFit('width')
      return
    }
    if (e.key === 'Escape') {
      if (findOpen) setFindOpen(false)
      if (outlineOpen) setOutlineOpen(false)
    }
  }

  const triggerInverseSync = useCallback(
    (e: MouseEvent<HTMLDivElement>, l: PageLayout) => {
      if (!onInverseSync) return
      const sel = typeof window !== 'undefined' ? window.getSelection()?.toString().trim() : ''
      if (sel) return
      const rect = e.currentTarget.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      const rx = clamp01((e.clientX - rect.left) / rect.width)
      const ry = clamp01((e.clientY - rect.top) / rect.height)
      const nonce = Date.now()
      setInversePing({ page: l.page, xFrac: rx, yFrac: ry, nonce })
      window.setTimeout(() => {
        setInversePing((cur) => (cur?.nonce === nonce ? null : cur))
      }, 700)
      onInverseSync({ page: l.page, xPt: rx * l.ptW, yPt: ry * l.ptH })
    },
    [onInverseSync],
  )

  const selectZoomValue = useCallback((val: string) => {
    if (val === 'width' || val === 'page') {
      setFit(val)
    } else {
      const z = Number.parseFloat(val)
      if (Number.isFinite(z)) {
        setFit('custom')
        setCustomZoom(clampZoom(z))
      }
    }
  }, [])

  const jumpOutlineNode = async (item: OutlineNode) => {
    const doc = shown?.doc
    if (!doc) return
    if (item.url && !item.dest) {
      window.open(item.url, '_blank', 'noopener,noreferrer')
      return
    }
    if (!item.dest) return
    try {
      const dest = typeof item.dest === 'string' ? await doc.getDestination(item.dest) : item.dest
      if (Array.isArray(dest) && dest[0]) {
        const pageIndex = await doc.getPageIndex(dest[0] as never)
        goToPage(pageIndex + 1)
        setOutlineOpen(false)
      }
    } catch {
      /* 忽略无效书签目标 */
    }
  }

  const handleDocLoaded = useCallback(
    (idx: 0 | 1, loadedSlot: Slot, doc: PDFDocumentProxy, defaultPt: PtSize, outline: OutlineNode[]) => {
      setSlots((s) =>
        s.map((cur, si) =>
          si === idx && cur === loadedSlot
            ? { ...cur, numPages: doc.numPages, doc, defaultPt, pageSizes: { 1: defaultPt }, outline }
            : cur,
        ) as [Slot | null, Slot | null],
      )
    },
    [],
  )

  const handlePageSize = useCallback((idx: 0 | 1, page: number, w: number, h: number) => {
    setSlots((s) =>
      s.map((cur, si) => {
        if (si !== idx || !cur) return cur
        const prev = cur.pageSizes[page]
        if (prev && Math.abs(prev.w - w) < 0.5 && Math.abs(prev.h - h) < 0.5) return cur
        return { ...cur, pageSizes: { ...cur.pageSizes, [page]: { w, h } } }
      }) as [Slot | null, Slot | null],
    )
  }, [])

  const handleStagingPageSettled = useCallback(
    (idx: 0 | 1, page: number) => {
      if (idx !== staging) return
      stagingRendered.current.add(page)
      trySwap(idx)
    },
    [staging, trySwap],
  )

  const options = useMemo(() => ({ ...pdfDocumentOptions }), [])
  const zoomSelectValue =
    fit === 'width'
      ? 'width'
      : fit === 'page'
        ? 'page'
        : ZOOM_PRESETS.some((p) => Math.abs(p - customZoom) < 0.01)
          ? String(ZOOM_PRESETS.find((p) => Math.abs(p - customZoom) < 0.01))
          : 'custom'

  if (!url) return null

  const outlineItems = shown?.outline ?? []

  return (
    <div
      className={cn('relative flex h-full min-h-0 flex-col bg-paper-canvas', className)}
      onKeyDown={onRegionKeyDown}
      data-testid="latex-pdf-viewer"
      data-zoom-fit={fit}
    >
      <PdfToolbar
        numPages={numPages}
        currentPage={currentPage}
        pageDraft={pageDraft}
        onPageDraftChange={setPageDraft}
        onGoToPage={goToPage}
        effectiveZoom={effectiveZoom}
        customZoom={customZoom}
        zoomSelectValue={zoomSelectValue}
        onSelectZoomValue={selectZoomValue}
        onStepZoom={(delta) => {
          setFit('custom')
          setCustomZoom(clampZoom(effectiveZoom + delta))
        }}
        building={building}
        stale={stale}
        findOpen={findOpen}
        onToggleFind={() => {
          const next = !findOpen
          setFindOpen(next)
          if (next) window.setTimeout(() => findInputRef.current?.focus(), 0)
        }}
        hasOutline={outlineItems.length > 0}
        outlineOpen={outlineOpen}
        onToggleOutline={() => setOutlineOpen((o) => !o)}
        invert={invert}
        onToggleInvert={() => setInvert((v) => !v)}
        downloadUrl={downloadUrl}
        downloadFilename={downloadFilename}
      />

      {findOpen && (
        <PdfFindBar
          inputRef={findInputRef}
          query={findQuery}
          normalizedQuery={normalizedQuery}
          matchCount={matches.length}
          currentIndex={clampedFindIdx}
          onQueryChange={(q) => {
            setFindQuery(q)
            setFindIdx(0)
          }}
          onStepMatch={(delta) => {
            if (matches.length > 0) setFindIdx((i) => (i + delta + matches.length) % matches.length)
          }}
          onClose={() => setFindOpen(false)}
        />
      )}

      {outlineOpen && outlineItems.length > 0 && (
        <PdfOutlineDrawer
          items={outlineItems}
          onSelect={(it) => void jumpOutlineNode(it)}
          onClose={() => setOutlineOpen(false)}
        />
      )}

      <div
        ref={scroller}
        onScroll={onScroll}
        role="region"
        aria-label="PDF 预览正文"
        tabIndex={0}
        className={cn(
          'relative min-h-0 flex-1 overflow-y-auto p-3',
          maxRenderedWidth > Math.max(MIN_PAGE_WIDTH, box.w - PAD_X) ? 'overflow-x-auto' : 'overflow-x-hidden',
          FOCUS_RING_INSET,
        )}
        data-testid="latex-pdf-scroll"
      >
        {([0, 1] as const).map((idx) => {
          const slot = slots[idx]
          const isActive = idx === active
          const isStaging = idx === staging
          if (!slot || (!isActive && !isStaging)) return null
          return (
            <PdfDocumentSlot
              key={`${idx}-${slot.url}`}
              slot={slot}
              slotIndex={idx}
              isActive={isActive}
              options={options}
              maxRenderedWidth={maxRenderedWidth}
              boxWidth={box.w}
              pageLayouts={pageLayouts}
              range={range}
              invert={invert}
              textRenderer={textRenderer}
              syncHighlight={syncHighlight}
              inversePing={inversePing}
              inverseSyncEnabled={Boolean(onInverseSync)}
              onGoToPage={goToPage}
              onDocLoaded={handleDocLoaded}
              onDocError={scheduleRetry}
              onRetry={() => setRetryTick((t) => t + 1)}
              onPageSize={handlePageSize}
              onStagingPageSettled={handleStagingPageSettled}
              onInverseSyncTrigger={triggerInverseSync}
            />
          )
        })}
        {!shown && !effectiveFailed && (
          <div className="grid min-h-40 place-items-center text-xs text-fg-muted" data-testid="latex-pdf-loading">
            <Loader2 aria-hidden className="size-5 animate-spin" />
          </div>
        )}
        {effectiveFailed && (
          <div className="my-6 flex flex-col items-center gap-2" role="alert" data-testid="latex-pdf-error">
            <p className="text-xs text-danger-fg">PDF 加载失败</p>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setFailedUrl(null)
                setRetryTick((t) => t + 1)
              }}
              data-testid="latex-pdf-retry"
            >
              <RotateCw aria-hidden className="size-3.5" />
              重试
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

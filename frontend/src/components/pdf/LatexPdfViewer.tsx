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
import { Document, Page } from 'react-pdf'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { pdfDocumentOptions } from '@/lib/pdfjs'
import 'react-pdf/dist/Page/TextLayer.css'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  FileDown,
  List,
  Loader2,
  Moon,
  RotateCw,
  Search,
  Sun,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { withFetchTimeout } from '@/lib/api'
import { FOCUS_RING_INSET, cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { type PageText, extractPageTexts, findMatches, highlightHtml } from './pdfFind'
import { A4_PT_H, A4_PT_W, ZOOM_PRESETS, type ZoomFit, clampZoom } from './pdfZoom'

export interface SyncTexTarget {
  page: number
  xPt?: number
  yPt?: number
  nonce: number
}

export interface InverseSyncInfo {
  page: number
  xPt: number
  yPt: number
}

export interface LatexPdfViewerProps {
  url: string | null
  downloadUrl?: string | null
  downloadFilename?: string
  jumpTarget?: SyncTexTarget | null
  onInverseSync?: (info: InverseSyncInfo) => void
  building?: boolean
  stale?: boolean
  className?: string
}

interface OutlineNode {
  title: string
  dest: unknown
  url?: string | null
  items?: OutlineNode[]
}

interface PtSize {
  w: number
  h: number
}

interface Slot {
  url: string
  file: { data: Uint8Array }
  numPages: number
  doc?: PDFDocumentProxy
  defaultPt: PtSize
  pageSizes: Record<number, PtSize>
  texts?: PageText[]
  outline?: OutlineNode[]
}

interface PageLayout {
  page: number
  width: number
  height: number
  top: number
  ptW: number
  ptH: number
}

interface SyncHighlight {
  page: number
  xFrac: number
  yFrac: number
  nonce: number
}

interface InversePing {
  page: number
  xFrac: number
  yFrac: number
  nonce: number
}

const GAP = 14
const PAD_X = 28
const PAD_Y = 24
const OVERSCAN = 1
const MIN_PAGE_WIDTH = 140
const SWAP_TIMEOUT_MS = 20_000

function scrollToY(el: HTMLDivElement, top: number, behavior: ScrollBehavior = 'auto') {
  const safeTop = Math.max(0, top)
  if (typeof el.scrollTo === 'function') el.scrollTo({ top: safeTop, behavior })
  else el.scrollTop = safeTop
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}

function FlatOutlineList({
  items,
  depth = 0,
  onSelect,
}: {
  items: OutlineNode[]
  depth?: number
  onSelect: (item: OutlineNode) => void
}) {
  return (
    <ul className="space-y-0.5">
      {items.map((item, idx) => (
        <li key={`${depth}-${idx}-${item.title}`}>
          <button
            type="button"
            className="w-full truncate rounded px-2 py-1 text-left text-xs text-fg hover:bg-hover hover:text-fg-strong"
            style={{ paddingLeft: `${8 + depth * 12}px` }}
            onClick={() => onSelect(item)}
            title={item.title}
          >
            {item.title || '（无标题）'}
          </button>
          {item.items && item.items.length > 0 && (
            <FlatOutlineList items={item.items} depth={depth + 1} onSelect={onSelect} />
          )}
        </li>
      ))}
    </ul>
  )
}

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

  // 工具条独立状态
  const [fit, setFit] = useState<ZoomFit>('width')
  const [customZoom, setCustomZoom] = useState(1)
  const [currentPage, setCurrentPage] = useState(1)
  const [pageDraft, setPageDraft] = useState<string | null>(null)
  const [range, setRange] = useState({ from: 1, to: 1 + OVERSCAN * 2 })
  const [invert, setInvert] = useState(false)
  const [outlineOpen, setOutlineOpen] = useState(false)

  // PDF 内查找状态
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findIdx, setFindIdx] = useState(0)

  // SyncTeX 正/反向脉冲反馈
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

  // 获取 PDF 字节：首次加载直出，后续重编译进隐藏槽实现零闪白热切换
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

  // 计算每页真实渲染宽高与纵坐标表
  const pageLayouts = useMemo<PageLayout[]>(() => {
    if (!shown || shown.numPages <= 0) return []
    const availW = Math.max(MIN_PAGE_WIDTH, box.w - PAD_X)
    const availH = Math.max(MIN_PAGE_WIDTH, box.h - PAD_Y)
    const layouts: PageLayout[] = []
    let top = 0
    for (let p = 1; p <= shown.numPages; p++) {
      const pt = shown.pageSizes[p] ?? shown.defaultPt
      const aspect = pt.w > 0 ? pt.h / pt.w : A4_PT_H / A4_PT_W
      let width: number
      if (fit === 'width') {
        width = availW
      } else if (fit === 'page') {
        width = Math.min(availW, Math.floor(availH / aspect))
      } else {
        width = Math.round(pt.w * (96 / 72) * customZoom)
      }
      width = Math.max(MIN_PAGE_WIDTH, width)
      const height = Math.max(120, Math.round(width * aspect))
      layouts.push({ page: p, width, height, top, ptW: pt.w, ptH: pt.h })
      top += height + GAP
    }
    return layouts
  }, [shown, box.w, box.h, fit, customZoom])

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

  const maxRenderedWidth = useMemo(() => {
    return pageLayouts.reduce((mx, l) => Math.max(mx, l.width), MIN_PAGE_WIDTH)
  }, [pageLayouts])

  // 缩放 / 面板拖动改变文档总高度时按比例保持视口位置
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

  // 根据滚动位置计算可见页区间与当前页码
  const updateRange = useCallback(() => {
    const el = scroller.current
    if (!el || !pageLayouts.length) return
    const viewTop = el.scrollTop
    const viewBot = viewTop + (el.clientHeight || box.h)
    const midY = viewTop + (el.clientHeight || box.h) / 3
    let first = 1
    let last = pageLayouts.length
    let cur = 1
    for (let i = 0; i < pageLayouts.length; i++) {
      const l = pageLayouts[i]
      const bot = l.top + l.height
      if (bot >= viewTop) {
        first = l.page
        break
      }
    }
    for (let i = pageLayouts.length - 1; i >= 0; i--) {
      if (pageLayouts[i].top <= viewBot) {
        last = pageLayouts[i].page
        break
      }
    }
    for (let i = 0; i < pageLayouts.length; i++) {
      const l = pageLayouts[i]
      if (midY <= l.top + l.height + GAP / 2) {
        cur = l.page
        break
      }
      cur = l.page
    }
    setCurrentPage(cur)
    const from = Math.max(1, first - OVERSCAN)
    const to = Math.min(pageLayouts.length, last + OVERSCAN)
    setRange((r) => (r.from === from && r.to === to ? r : { from, to }))
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

  // SyncTeX 正向定位（由 nonce 驱动，支持同一页多次精确跳转并亮脉冲条）
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

  // 隐藏槽渲染完毕 → 原子切前台；看门狗兜底防悬挂
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

  // PDF 内查找（延迟提取当前激活槽文本）
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

  // Ctrl/Cmd + 滚轮缩放（需 passive: false 以阻断浏览器整页缩放）
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

  const triggerInverseSync = (e: MouseEvent<HTMLDivElement>, l: PageLayout) => {
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
  }

  const selectZoomValue = (val: string) => {
    if (val === 'width' || val === 'page') {
      setFit(val)
    } else {
      const z = Number.parseFloat(val)
      if (Number.isFinite(z)) {
        setFit('custom')
        setCustomZoom(clampZoom(z))
      }
    }
  }

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

  const options = useMemo(() => ({ ...pdfDocumentOptions }), [])
  const zoomSelectValue =
    fit === 'width'
      ? 'width'
      : fit === 'page'
        ? 'page'
        : ZOOM_PRESETS.some((p) => Math.abs(p - customZoom) < 0.01)
          ? String(ZOOM_PRESETS.find((p) => Math.abs(p - customZoom) < 0.01))
          : 'custom'

  const renderSlot = (idx: 0 | 1) => {
    const slot = slots[idx]
    if (!slot) return null
    const isActive = idx === active
    const isStaging = idx === staging
    if (!isActive && !isStaging) return null
    return (
      <div
        key={`${idx}-${slot.url}`}
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
          error={isActive ? <PdfFailBox onRetry={() => setRetryTick((t) => t + 1)} /> : null}
          externalLinkTarget="_blank"
          onItemClick={({ pageNumber }) => {
            if (pageNumber) goToPage(pageNumber)
          }}
          onLoadSuccess={(doc) => {
            void Promise.all([
              doc.getPage(1).then((p) => {
                const v = p.getViewport({ scale: 1 })
                return { w: v.width || A4_PT_W, h: v.height || A4_PT_H }
              }).catch(() => ({ w: A4_PT_W, h: A4_PT_H })),
              typeof doc.getOutline === 'function'
                ? doc.getOutline().catch(() => [])
                : Promise.resolve([]),
            ]).then(([defaultPt, rawOutline]) => {
              const outline = Array.isArray(rawOutline) ? (rawOutline as OutlineNode[]) : []
              setSlots((s) =>
                s.map((cur, si) =>
                  si === idx && cur === slot
                    ? { ...cur, numPages: doc.numPages, doc, defaultPt, pageSizes: { 1: defaultPt }, outline }
                    : cur,
                ) as [Slot | null, Slot | null],
              )
            })
          }}
          onLoadError={() => scheduleRetry(slot.url)}
          className="flex flex-col items-center"
        >
          {Array.from({ length: slot.numPages }, (_, i) => {
            const n = i + 1
            const layout = pageLayouts[i]
            const w = layout?.width ?? Math.max(MIN_PAGE_WIDTH, box.w - PAD_X)
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
                  triggerInverseSync(e, layout)
                }}
                onClick={(e) => {
                  if (!layout || !(e.ctrlKey || e.metaKey)) return
                  triggerInverseSync(e, layout)
                }}
                title={onInverseSync ? '双击或 Ctrl+点击跳转到对应源码行' : undefined}
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
                        setSlots((s) =>
                          s.map((cur, si) => {
                            if (si !== idx || !cur) return cur
                            const prev = cur.pageSizes[n]
                            if (prev && Math.abs(prev.w - v.width) < 0.5 && Math.abs(prev.h - v.height) < 0.5) {
                              return cur
                            }
                            return { ...cur, pageSizes: { ...cur.pageSizes, [n]: { w: v.width, h: v.height } } }
                          }) as [Slot | null, Slot | null],
                        )
                      }}
                      onRenderSuccess={() => {
                        if (idx !== staging) return
                        stagingRendered.current.add(n)
                        trySwap(idx)
                      }}
                      onRenderError={() => {
                        if (idx !== staging) return
                        stagingRendered.current.add(n)
                        trySwap(idx)
                      }}
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

  if (!url) return null

  const outlineItems = shown?.outline ?? []

  return (
    <div
      className={cn('relative flex h-full min-h-0 flex-col bg-paper-canvas', className)}
      onKeyDown={onRegionKeyDown}
      data-testid="latex-pdf-viewer"
      data-zoom-fit={fit}
    >
      {/* 紧凑工具条 */}
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
          onClick={() => goToPage(currentPage - 1)}
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
              setPageDraft(String(currentPage))
              e.currentTarget.select()
            }}
            onChange={(e) => setPageDraft(e.target.value)}
            onBlur={() => {
              if (pageDraft != null) {
                const parsed = Number.parseInt(pageDraft, 10)
                if (Number.isFinite(parsed)) goToPage(parsed)
                else setPageDraft(null)
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const parsed = Number.parseInt(pageDraft ?? '', 10)
                if (Number.isFinite(parsed)) goToPage(parsed)
                e.currentTarget.blur()
              } else if (e.key === 'Escape') {
                setPageDraft(null)
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
          onClick={() => goToPage(currentPage + 1)}
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
          onClick={() => {
            setFit('custom')
            setCustomZoom(clampZoom(effectiveZoom - 0.15))
          }}
          data-testid="latex-pdf-zoom-out"
        >
          <ZoomOut aria-hidden />
        </Button>
        <select
          aria-label="缩放比例"
          data-testid="latex-pdf-zoom-select"
          value={zoomSelectValue}
          onChange={(e) => selectZoomValue(e.target.value)}
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
          onClick={() => {
            setFit('custom')
            setCustomZoom(clampZoom(effectiveZoom + 0.15))
          }}
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
            onClick={() => {
              const next = !findOpen
              setFindOpen(next)
              if (next) window.setTimeout(() => findInputRef.current?.focus(), 0)
            }}
            data-testid="latex-pdf-find-toggle"
          >
            <Search aria-hidden />
          </Button>
          {outlineItems.length > 0 && (
            <Button
              variant={outlineOpen ? 'soft' : 'ghost'}
              size="icon-xs"
              aria-label="PDF 目录书签"
              title="PDF 目录书签"
              onClick={() => setOutlineOpen((o) => !o)}
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
            onClick={() => setInvert((v) => !v)}
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

      {/* 查找浮条 */}
      {findOpen && (
        <div
          className="flex shrink-0 items-center gap-1.5 border-b border-line bg-surface px-2 py-1 text-xs"
          data-testid="latex-pdf-find-bar"
        >
          <Search aria-hidden className="size-3.5 shrink-0 text-fg-muted" />
          <input
            ref={findInputRef}
            type="text"
            value={findQuery}
            onChange={(e) => {
              setFindQuery(e.target.value)
              setFindIdx(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && matches.length > 0) {
                e.preventDefault()
                const delta = e.shiftKey ? -1 : 1
                setFindIdx((i) => (i + delta + matches.length) % matches.length)
              } else if (e.key === 'Escape') {
                setFindOpen(false)
              }
            }}
            placeholder="在 PDF 中查找…"
            aria-label="在 PDF 中查找"
            data-testid="latex-pdf-find-input"
            className="h-xs min-w-0 flex-1 rounded border border-line bg-panel px-2 text-xs text-fg focus:border-accent focus:outline-none"
          />
          <span className="shrink-0 text-2xs tabular-nums text-fg-muted" data-testid="latex-pdf-find-count">
            {normalizedQuery ? (matches.length ? `${clampedFindIdx + 1} / ${matches.length}` : '0 命中') : ''}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="上一处"
            disabled={matches.length === 0}
            onClick={() => setFindIdx((i) => (i - 1 + matches.length) % matches.length)}
            data-testid="latex-pdf-find-prev"
          >
            <ChevronLeft aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="下一处"
            disabled={matches.length === 0}
            onClick={() => setFindIdx((i) => (i + 1) % matches.length)}
            data-testid="latex-pdf-find-next"
          >
            <ChevronRight aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="关闭查找"
            onClick={() => setFindOpen(false)}
          >
            <X aria-hidden />
          </Button>
        </div>
      )}

      {/* 书签大纲抽屉 */}
      {outlineOpen && outlineItems.length > 0 && (
        <aside
          aria-label="PDF 书签大纲"
          data-testid="latex-pdf-outline"
          className="absolute right-2 top-9 z-popover max-h-72 w-64 overflow-y-auto rounded-md border border-line bg-panel p-2 shadow-md"
        >
          <div className="mb-1 flex items-center justify-between px-1 text-2xs font-medium text-fg-muted">
            <span>PDF 书签</span>
            <button type="button" className="hover:text-fg" onClick={() => setOutlineOpen(false)} aria-label="关闭书签">
              <X className="size-3.5" />
            </button>
          </div>
          <FlatOutlineList items={outlineItems} onSelect={(it) => void jumpOutlineNode(it)} />
        </aside>
      )}

      {/* 滚动容器 */}
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
        {renderSlot(0)}
        {renderSlot(1)}
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

function PdfFailBox({ onRetry }: { onRetry: () => void }) {
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

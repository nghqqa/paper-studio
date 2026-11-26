import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { PageText } from './pdfFind'
import { A4_PT_H, A4_PT_W, type ZoomFit } from './pdfZoom'

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

export interface OutlineNode {
  title: string
  dest: unknown
  url?: string | null
  items?: OutlineNode[]
}

export interface PtSize {
  w: number
  h: number
}

export interface Slot {
  url: string
  file: { data: Uint8Array }
  numPages: number
  doc?: PDFDocumentProxy
  defaultPt: PtSize
  pageSizes: Record<number, PtSize>
  texts?: PageText[]
  outline?: OutlineNode[]
}

export interface PageLayout {
  page: number
  width: number
  height: number
  top: number
  ptW: number
  ptH: number
}

export interface SyncHighlight {
  page: number
  xFrac: number
  yFrac: number
  nonce: number
}

export interface InversePing {
  page: number
  xFrac: number
  yFrac: number
  nonce: number
}

export const GAP = 14
export const PAD_X = 28
export const PAD_Y = 24
export const OVERSCAN = 1
export const MIN_PAGE_WIDTH = 140
export const SWAP_TIMEOUT_MS = 20_000

export function scrollToY(el: HTMLDivElement, top: number, behavior: ScrollBehavior = 'auto') {
  const safeTop = Math.max(0, top)
  if (typeof el.scrollTo === 'function') el.scrollTo({ top: safeTop, behavior })
  else el.scrollTop = safeTop
}

export function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}

/** 根据每页实际 point 宽高与当前缩放模式计算渲染尺寸与纵坐标偏移 */
export function computePageLayouts(
  shown: Slot | null,
  box: { w: number; h: number },
  fit: ZoomFit,
  customZoom: number,
): PageLayout[] {
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
}

/** 计算当前视口可见页范围（含上下 OVERSCAN）与读页指示码 */
export function computeVisibleRange(
  pageLayouts: PageLayout[],
  viewTop: number,
  viewHeight: number,
): { currentPage: number; from: number; to: number } {
  const viewBot = viewTop + viewHeight
  const midY = viewTop + viewHeight / 3
  let first = 1
  let last = pageLayouts.length
  let cur = 1
  for (let i = 0; i < pageLayouts.length; i++) {
    const l = pageLayouts[i]
    if (l.top + l.height >= viewTop) {
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
  return {
    currentPage: cur,
    from: Math.max(1, first - OVERSCAN),
    to: Math.min(pageLayouts.length, last + OVERSCAN),
  }
}

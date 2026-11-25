import { useCallback, useEffect, useRef, useState } from 'react'
import type { SyncTexTarget } from '@/components/pdf/LatexPdfViewer'
import { latexApi } from '@/lib/api/latex'
import { errText } from './useLatexSession'

export function useLatexSyncTex({
  pid,
  previewBuildId,
  building,
  active,
  cursorLine,
  openFile,
  jumpTo,
}: {
  pid: string
  previewBuildId: string | null
  building: boolean
  active: string | null
  cursorLine: number | null
  openFile: (rel: string) => Promise<void>
  jumpTo: (file: string, line: number | null) => void
}) {
  const [previewScroll, setPreviewScroll] = useState<SyncTexTarget | null>(null)
  const [locateFlash, setLocateFlash] = useState('')
  const flashTimer = useRef<number | null>(null)

  const flashLocate = useCallback((msg: string) => {
    setLocateFlash(msg)
    if (flashTimer.current != null) window.clearTimeout(flashTimer.current)
    if (msg) {
      flashTimer.current = window.setTimeout(() => {
        flashTimer.current = null
        setLocateFlash('')
      }, 4000)
    }
  }, [])

  useEffect(
    () => () => {
      if (flashTimer.current != null) window.clearTimeout(flashTimer.current)
    },
    [],
  )

  const locateInPdf = useCallback(async () => {
    if (!previewBuildId || building || !active) return
    try {
      const r = await latexApi.synctexView(pid, previewBuildId, active, cursorLine ?? 1)
      setPreviewScroll({ page: r.page, xPt: r.x, yPt: r.y, nonce: Date.now() })
      flashLocate('')
    } catch (e) {
      flashLocate(`PDF 定位失败：${errText(e)}`)
    }
  }, [pid, previewBuildId, active, cursorLine, building, flashLocate])

  const onPdfClickLocate = useCallback(
    async (info: { page: number; xPt: number; yPt: number }) => {
      if (!previewBuildId || building) return
      try {
        const r = await latexApi.synctexEdit(pid, previewBuildId, info.page, info.xPt, info.yPt)
        if (r.file !== active) {
          await openFile(r.file)
          window.setTimeout(() => jumpTo(r.file, r.line), 250)
        } else {
          jumpTo(r.file, r.line)
        }
      } catch {
        /* 点击处无对应源码（图/空白），静默 */
      }
    },
    [pid, previewBuildId, building, active, openFile, jumpTo],
  )

  return {
    previewScroll,
    setPreviewScroll,
    locateFlash,
    flashLocate,
    locateInPdf,
    onPdfClickLocate,
  }
}

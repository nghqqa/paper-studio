import { useCallback, useEffect, useRef, useState } from 'react'
import { CITATION_STYLE_LABELS, type CitationStyle } from '@/components/paper/library/types'
import type { AnchorLike, ApplyOutcome } from '@/components/paper/proposalApply'
import { libraryApi, type LibraryEntry } from '@/lib/api/library'
import { bridgeAlive, refreshDocKey, runRefsTaskAuto } from '@/lib/api/refsPlugin'
import type { WordRenumberResult } from '@/lib/api/word'
import { mergeCitationBrackets } from './citationBrackets'

const ASSISTANT_SOURCE = 'paper-studio-assistant'
const REFS_SOURCE = 'paper-studio-refs'
const MAX_CHARS = 8000

export function useWordRefsBridge({
  pid,
  docKeyProp,
  onRenumberCitations,
}: {
  pid: string
  docKeyProp: string | null
  onRenumberCitations?: (style?: CitationStyle) => Promise<WordRenumberResult | null>
}) {
  const [selection, setSelection] = useState('')
  const [mode, setMode] = useState<'sdt' | 'plain' | null>(null)
  const [bridgeError, setBridgeError] = useState('')
  const [bibMessage, setBibMessage] = useState('')
  const [ready, setReady] = useState(false)
  const [bibBusy, setBibBusy] = useState(false)
  const [superscript, setSuperscript] = useState(true)
  const [citationStyle, setCitationStyle] = useState<CitationStyle>('gb-t-7714-2015')
  const [bibWarnings, setBibWarnings] = useState<string[]>([])
  const [stripBusy, setStripBusy] = useState(false)
  const [docKey, setDocKey] = useState<string | null>(docKeyProp)
  const docKeyRef = useRef<string | null>(docKeyProp)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    setDocKey(docKeyProp)
    docKeyRef.current = docKeyProp
  }, [docKeyProp])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const d = event.data as { source?: string; type?: string; text?: unknown; docKey?: unknown } | null
      if (!d) return
      if (d.source === ASSISTANT_SOURCE && d.type === 'selection' && typeof d.text === 'string') {
        setSelection(d.text.slice(0, MAX_CHARS))
      }
      if (d.source === REFS_SOURCE && d.type === 'ready' && typeof d.docKey === 'string' && d.docKey === docKey) {
        setReady(true)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [docKey])

  useEffect(() => {
    if (!docKey) return
    let alive = true
    const poll = async () => {
      const k = docKeyRef.current
      let ok = k ? await bridgeAlive(k) : false
      if (!ok) {
        const fresh = await refreshDocKey(pid)
        if (fresh && fresh !== k) {
          docKeyRef.current = fresh
          setDocKey(fresh)
          ok = await bridgeAlive(fresh)
        }
      }
      if (alive) setReady(ok)
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 3000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [docKey, pid])

  const effectiveReady = Boolean(docKey) && ready

  const requireReady = useCallback(() => {
    if (!docKey) {
      setBridgeError('编辑器会话未就绪（缺少文档会话键），请重开工程后再试')
      return false
    }
    if (!effectiveReady) {
      setBridgeError('文献桥插件未就绪（未收到编辑器插件心跳）。请确认：①使用可编辑账号 ②编辑器已完全加载 ③点「重试探测」。生产部署首次加载后刷新一次页面即可。')
      return false
    }
    return true
  }, [docKey, effectiveReady])

  const insertCitations = useCallback(
    async (entries: LibraryEntry[]) => {
      if (!requireReady()) return
      setBridgeError('')
      try {
        const rids = entries.map((e) => e.reference_id)
        const reg = await libraryApi.registerCitations(pid, rids)
        const bib = await libraryApi.bibliography(pid, reg.order, citationStyle)
        let label = rids
          .map((r) => bib.labels[r] ?? '')
          .filter(Boolean)
          .join(', ')
        if (!label) throw new Error('参考文献渲染为空')
        if (superscript) label = mergeCitationBrackets(label)
        const res = await runRefsTaskAuto<{ mode?: string }>(
          pid,
          () => docKeyRef.current,
          setDocKey,
          'insert-citation',
          { rids, label, superscript },
        )
        setMode(res.mode === 'plain' ? 'plain' : 'sdt')
        setBibMessage(`已插入引用 ${label}（写完一段后点「更新文末参考文献」同步文末列表）`)
      } catch (e) {
        setBridgeError(e instanceof Error ? e.message : String(e))
      }
    },
    [pid, requireReady, superscript, citationStyle],
  )

  const refreshBibliography = useCallback(async () => {
    if (!requireReady()) return
    setBridgeError('')
    setBibMessage('')
    setBibWarnings([])
    setBibBusy(true)
    try {
      const collected = await runRefsTaskAuto<{ numbers?: number[]; appear_order?: number[]; in_table_count?: number }>(
        pid,
        () => docKeyRef.current,
        setDocKey,
        'collect-refs',
        {},
      )
      const numbers = collected.numbers ?? []
      const appearOrder = collected.appear_order ?? numbers
      if (!numbers.length) throw new Error('文中没有引用标记 [n]（插入引用后可更新参考文献表）')
      const reg = await libraryApi.registerCitations(pid, [])
      const order = reg.order ?? []
      const cited = order.filter((_, i) => numbers.includes(i + 1))
      const stale = numbers.filter((n) => n < 1 || n > order.length)
      if (!cited.length) throw new Error('扫描到引用编号但在文献库中找不到对应条目——请检查编号或重新插入引用')
      const bib = await libraryApi.bibliography(pid, cited, citationStyle)
      const numOf = new Map<string, number>()
      order.forEach((rid, i) => numOf.set(rid, i + 1))
      const items = bib.bibliography.map((text, k) =>
        text.replace(/^(\s*)\[\d+\]/, (_m, sp: string) => `${sp}[${numOf.get(cited[k]) ?? k + 1}]`),
      )
      await runRefsTaskAuto(pid, () => docKeyRef.current, setDocKey, 'set-bibliography', { items })
      setMode('sdt')
      const warnings: string[] = []
      let inverted = false
      for (let i = 1; i < appearOrder.length; i += 1) {
        if (appearOrder[i] <= appearOrder[i - 1]) {
          inverted = true
          break
        }
      }
      if (inverted) {
        warnings.push(
          `检测到顺序标引倒置：正文引用首次出现顺序为 [${appearOrder.join(',')}]，与编号升序不符——` +
            '顺序编码制要求编号按首次出现顺序递增，请检查引用位置或重新插入引用',
        )
      }
      const uniq = [...new Set(numbers)].sort((a, b) => a - b)
      const missing: number[] = []
      for (let n = uniq[0]; n <= uniq[uniq.length - 1]; n += 1) {
        if (!uniq.includes(n)) missing.push(n)
      }
      if (missing.length) {
        const missingText = missing.length <= 5 ? `[${missing.join('],[')}]` : `${missing.length} 个编号`
        warnings.push(`检测到编号断号：正文缺少 ${missingText}——对应引用可能已被删除但正文未同步，请检查引用标记`)
      }
      setBibWarnings(warnings)
      const staleText =
        stale.length === 0
          ? ''
          : stale.length <= 3
            ? `；忽略失效标记 [${stale.join(',')}]`
            : `；忽略失效标记 ${stale.length} 处（多为模板示例文字，无对应文献）`
      setBibMessage(`已更新参考文献表：识别 ${numbers.length} 处引用标记 → 收录 ${cited.length} 条${staleText}`)
    } catch (e) {
      setBridgeError(e instanceof Error ? e.message : String(e))
    } finally {
      setBibBusy(false)
    }
  }, [pid, requireReady, citationStyle])

  const stripBibMarkers = useCallback(async () => {
    if (!requireReady()) return
    setBridgeError('')
    setBibMessage('')
    setBibWarnings([])
    setStripBusy(true)
    try {
      const res = await runRefsTaskAuto<{ removed?: number; entries?: number }>(
        pid,
        () => docKeyRef.current,
        setDocKey,
        'strip-bib-markers',
        {},
      )
      setBibMessage(`已清理参考文献托管标记（${res.removed ?? 0} 个），${res.entries ?? 0} 条文献条目原样保留——定稿版不再带平台标记`)
    } catch (e) {
      setBridgeError(e instanceof Error ? e.message : String(e))
    } finally {
      setStripBusy(false)
    }
  }, [pid, requireReady])

  const renumberCitations = useCallback(
    async (style?: CitationStyle): Promise<WordRenumberResult | null> => {
      if (!onRenumberCitations) return null
      setBridgeError('')
      setBibMessage('')
      setBibWarnings([])
      const res = await onRenumberCitations(style)
      if (!res) return null
      setBibWarnings(res.warnings ?? [])
      setBibMessage(
        res.changed
          ? `已按出现顺序重排 ${Object.keys(res.mapping).length} 处引用编号` +
              (res.rebuilt_block
                ? `，托管参考文献表已按「${CITATION_STYLE_LABELS[style ?? 'gb-t-7714-2015'].replace('（默认）', '')}」样式重建`
                : '')
          : '引用已按出现顺序排列，无需修改。',
      )
      return res
    },
    [onRenumberCitations],
  )

  const applyWordProposal = useCallback(
    async (anchor: AnchorLike, suggested: string): Promise<ApplyOutcome> => {
      if (!docKey) return { ok: false, reason: 'no_view' }
      try {
        await runRefsTaskAuto<{ reason?: string; mode?: string }>(
          pid,
          () => docKeyRef.current,
          setDocKey,
          'apply-proposal',
          { original_text: anchor.original_text, suggested_text: suggested },
        )
        return { ok: true, reason: 'unique' }
      } catch (e) {
        const reason = (e as { reason?: string }).reason
        const msg = e instanceof Error ? e.message : String(e)
        if (reason === 'not_found' || msg.includes('not_found')) return { ok: false, reason: 'not_found' }
        if (reason === 'ambiguous' || msg.includes('ambiguous')) return { ok: false, reason: 'ambiguous' }
        if (reason === 'multi_paragraph') {
          setBridgeError('该提案原文跨段落（可能含公式/表格结构），已拒绝整段纯文本覆盖——请按单段选中后分别润色，或在正文中手动调整')
          return { ok: false, reason: 'not_found' }
        }
        setBridgeError(msg)
        return { ok: false, reason: 'no_view' }
      }
    },
    [pid, docKey],
  )

  const revertWordProposal = useCallback(
    async (anchor: AnchorLike, appliedText: string): Promise<ApplyOutcome> => {
      if (!docKey) return { ok: false, reason: 'no_view' }
      try {
        await runRefsTaskAuto<{ reason?: string }>(
          pid,
          () => docKeyRef.current,
          setDocKey,
          'apply-proposal',
          { original_text: appliedText, suggested_text: anchor.original_text },
        )
        return { ok: true, reason: 'unique' }
      } catch (e) {
        const reason = (e as { reason?: string }).reason
        const msg = e instanceof Error ? e.message : String(e)
        if (reason === 'not_found' || msg.includes('not_found')) return { ok: false, reason: 'not_found' }
        if (reason === 'ambiguous' || msg.includes('ambiguous')) return { ok: false, reason: 'ambiguous' }
        setBridgeError(msg)
        return { ok: false, reason: 'no_view' }
      }
    },
    [pid, docKey],
  )

  const getWordSelection = useCallback(() => {
    const text = selection.trim()
    if (!text) return null
    return { text, doc: text, from: 0, to: text.length }
  }, [selection])

  const retryBridge = useCallback(() => {
    setChecking(true)
    void (async () => {
      if (docKey) setReady(await bridgeAlive(docKey))
      setChecking(false)
    })()
  }, [docKey])

  return {
    selection,
    mode,
    bridgeError,
    bibMessage,
    ready: effectiveReady,
    bibBusy,
    superscript,
    setSuperscript,
    citationStyle,
    setCitationStyle,
    bibWarnings,
    stripBusy,
    checking,
    retryBridge,
    insertCitations,
    refreshBibliography,
    stripBibMarkers,
    renumberCitations,
    applyWordProposal,
    revertWordProposal,
    getWordSelection,
  }
}

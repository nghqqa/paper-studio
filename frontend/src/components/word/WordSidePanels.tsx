import { useCallback, useEffect, useRef, useState } from 'react'
import { BookOpen, Loader2, Plug, Sparkles, X } from 'lucide-react'
import { libraryApi, type LibraryEntry } from '@/lib/api/library'
import { bridgeAlive, refreshDocKey, runRefsTaskAuto } from '@/lib/api/refsPlugin'
import { LibraryPanel, CITATION_STYLE_LABELS, type CitationStyle } from '@/components/latex/LibraryPanel'
import { ProposalPanel } from '@/components/latex/ProposalPanel'
import { WordPreflightPanel } from './WordPreflightPanel'
import { RebuttalPanel } from '@/components/rebuttal/RebuttalPanel'
import type { AnchorLike, ApplyOutcome } from '@/components/latex/proposalApply'
import type { WordRenumberResult } from '@/lib/api/word'

/** GB/T 7714-2015 连号压缩：升序去重后仅 ≥3 连续整数压为起止范围（1-3）；2 连号保持 1,2。 */
export function compressCitationNumbers(nums: number[]): string {
  const uniq = [...new Set(nums)].sort((a, b) => a - b)
  const parts: string[] = []
  let start = 0
  while (start < uniq.length) {
    let end = start
    while (end + 1 < uniq.length && uniq[end + 1] === uniq[end] + 1) end += 1
    if (end - start + 1 >= 3) parts.push(`${uniq[start]}-${uniq[end]}`)
    else for (let i = start; i <= end; i += 1) parts.push(String(uniq[i]))
    start = end + 1
  }
  return parts.join(',')
}

/** 上标引用惯例（GB/T 7714）：[1], [2], [3] 合并为单个上标 [1-3]（≥3 连号压缩，2 连号 [1,2]）。
 *  仅当所有标签都是纯编号括号时合并（升序去重后压缩）；带文字的标签原样上标，不猜结构。 */
export function mergeCitationBrackets(label: string): string {
  const parts = label.split(',').map((s) => s.trim()).filter(Boolean)
  if (parts.length > 1 && parts.every((p) => /^\[\d+\]$/.test(p))) {
    const nums = parts.map((p) => parseInt(p.slice(1, -1), 10))
    return '[' + compressCitationNumbers(nums) + ']'
  }
  return label
}

/**
 * Word 工作台侧栏（v0.4.1）：文献 + 论文助手（精读/写作/润色/去AI味）。
 * - 插件就绪以服务端心跳为准（bridgeAlive）：未就绪时插入/更新入口禁用并给出重试，
 *   不伪装可执行；应用提案入口独立于插件（生成不需要插件）。
 * - 文献插入 → /library/bibliography 按当前样式（默认 GB/T 7714-2015，可切 IEEE）取标签
 *   → 任务箱 insert-citation（上标引用按 GB/T 7714 连号压缩 [1-3]）。
 * - 更新参考文献表 → collect-refs（含表格/范围/appear_order）→ 顺序倒置与断号醒目提示
 *   → set-bibliography 托管块替换；strip-bib-markers 定稿前剥离托管标记。
 * - AI 提案应用 → 插件按原文全文精确检索（与采纳时的当前选区无关）：唯一命中才
 *   PasteHtml（保留段落样式，字符级格式不保留——面板如实提示）；
 *   not_found/ambiguous/multi_paragraph 明确阻断。
 */

const ASSISTANT_SOURCE = 'paper-studio-assistant'
const REFS_SOURCE = 'paper-studio-refs'
const MAX_CHARS = 8000

type Tab = 'library' | 'proposals' | 'preflight' | 'rebuttal'

interface Props {
  pid: string
  docKey: string | null // DS 文档会话键（editorConfig.document.key）
  canEdit: boolean
  saving: boolean
  stateSha: string | null
  stateVersion: number | null
  open: Tab | null
  onClose: () => void
  /** Word 模式：服务端引用重排（P1-0-B）；不依赖文献桥（服务端 OOXML 直改），LaTeX 模式不传 */
  onRenumberCitations?: (style?: CitationStyle) => Promise<WordRenumberResult | null>
  renumberBusy?: boolean
}

export function WordSidePanels({ pid, docKey: docKeyProp, canEdit, saving, stateSha, stateVersion, open, onClose,
  onRenumberCitations, renumberBusy = false }: Props) {
  const [selection, setSelection] = useState('')
  const [mode, setMode] = useState<'sdt' | 'plain' | null>(null)
  const [bridgeError, setBridgeError] = useState('')
  const [bibMessage, setBibMessage] = useState('')
  const [ready, setReady] = useState(false)
  const [bibBusy, setBibBusy] = useState(false)
  const [superscript, setSuperscript] = useState(true)
  // 引用样式与清理诊断（P1-0-A）：默认国标样式；顺序/断号警示与托管标记清理动作。
  const [citationStyle, setCitationStyle] = useState<CitationStyle>('gb-t-7714-2015')
  const [bibWarnings, setBibWarnings] = useState<string[]>([])
  const [stripBusy, setStripBusy] = useState(false)
  const [docKey, setDocKey] = useState<string | null>(docKeyProp)
  useEffect(() => { setDocKey(docKeyProp) }, [docKeyProp])
  const docKeyRef = useRef<string | null>(docKeyProp)
  useEffect(() => { docKeyRef.current = docKey }, [docKey])
  const [checking, setChecking] = useState(false)

  // 选区桥（office_plugin_ai 推送）+ 文献桥 ready postMessage（加速首次感知；权威=服务端心跳）
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

  // 心跳轮询：插件未就绪时定期探测（也覆盖 postMessage 丢失）
  useEffect(() => {
    if (!docKey) {
      setReady(false)
      return
    }
    let alive = true
    const poll = async () => {
      let k = docKeyRef.current
      let ok = k ? await bridgeAlive(k) : false
      if (!ok) {
        // 会话键可能已轮换：对齐后重探一次（插件心跳打在最新会话上）
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
  }, [docKey])

  const requireReady = useCallback(() => {
    if (!docKey) {
      setBridgeError('编辑器会话未就绪（缺少文档会话键），请重开工程后再试')
      return false
    }
    if (!ready) {
      setBridgeError('文献桥插件未就绪（未收到编辑器插件心跳）。请确认：①使用可编辑账号 ②编辑器已完全加载 ③点「重试探测」。生产部署首次加载后刷新一次页面即可。')
      return false
    }
    return true
  }, [docKey, ready])

  /** 选中文本 → 插入引用：先登记全局引用顺序（编号=全局位置，防多次插入都编成 [1]），
   *  再按全局顺序取标签 → 插件任务。 */
  const insertCitations = useCallback(async (entries: LibraryEntry[]) => {
    if (!requireReady()) return
    setBridgeError('')
    try {
      const rids = entries.map((e) => e.reference_id)
      const reg = await libraryApi.registerCitations(pid, rids)
      const bib = await libraryApi.bibliography(pid, reg.order, citationStyle)
      let label = rids.map((r) => bib.labels[r] ?? '').filter(Boolean).join(', ')
      if (!label) throw new Error('参考文献渲染为空')
      if (superscript) label = mergeCitationBrackets(label)
      const res = await runRefsTaskAuto<{ mode?: string }>(pid, () => docKeyRef.current, setDocKey, 'insert-citation', { rids, label, superscript })
      setMode(res.mode === 'plain' ? 'plain' : 'sdt')
    } catch (e) {
      setBridgeError(e instanceof Error ? e.message : String(e))
    }
  }, [pid, docKey, requireReady, superscript, citationStyle])

  /** 更新参考文献表（静态文本闭环）：扫描正文 [n]/[1,2]/[1-3] 引用编号 → 按全局引用顺序表
   *  映射回条目 → 只保留文中实际出现的条目按当前样式重渲染 → 插件替换托管文献表块。
   *  编号在插入时即固定（静态文本无绑定），正文重排后编号不追随——如实报失效编号。
   *  同时检测两类中文期刊常见硬伤（P1-0-A）：顺序标引倒置（appear_order 非严格升序）、编号断号。 */
  const refreshBibliography = useCallback(async () => {
    if (!requireReady()) return
    setBridgeError('')
    setBibMessage('')
    setBibWarnings([])
    setBibBusy(true)
    try {
      const collected = await runRefsTaskAuto<{ numbers?: number[]; appear_order?: number[]; in_table_count?: number }>(
        pid, () => docKeyRef.current, setDocKey, 'collect-refs', {})
      const numbers = collected.numbers ?? []
      const appearOrder = collected.appear_order ?? numbers
      if (!numbers.length) throw new Error('文中没有引用标记 [n]（插入引用后可更新参考文献表）')
      const reg = await libraryApi.registerCitations(pid, [])
      const order = reg.order ?? []
      const cited = order.filter((_, i) => numbers.includes(i + 1))
      const stale = numbers.filter((n) => n < 1 || n > order.length)
      if (!cited.length) throw new Error('扫描到引用编号但在文献库中找不到对应条目——请检查编号或重新插入引用')
      const bib = await libraryApi.bibliography(pid, cited, citationStyle)
      // 编号跟随全局引用顺序（含空号），与正文静态标签严格一致：
      // 正文是 [1]、[3] 时文献表也是 [1]、[3]——不重排成 [1]、[2]。
      const numOf = new Map<string, number>()
      order.forEach((rid, i) => numOf.set(rid, i + 1))
      const items = bib.bibliography.map((text, k) =>
        text.replace(/^(\s*)\[\d+\]/, (_m, sp: string) => `${sp}[${numOf.get(cited[k]) ?? k + 1}]`),
      )
      await runRefsTaskAuto(pid, () => docKeyRef.current, setDocKey, 'set-bibliography', { items })
      setMode('sdt')
      // 中文期刊硬伤检测（不阻断更新——文献表照常重建，问题醒目提示由作者处置）
      const warnings: string[] = []
      let inverted = false
      for (let i = 1; i < appearOrder.length; i += 1) {
        if (appearOrder[i] <= appearOrder[i - 1]) { inverted = true; break }
      }
      if (inverted) {
        warnings.push(`检测到顺序标引倒置：正文引用首次出现顺序为 [${appearOrder.join(',')}]，与编号升序不符——`
          + '顺序编码制要求编号按首次出现顺序递增，请检查引用位置或重新插入引用')
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
      // 模板示例文字常含 [4]-[13] 一类编号，误识别很常见——失效多于 3 个只报数量不逐个罗列
      const staleText = stale.length === 0 ? '' : stale.length <= 3 ? `；忽略失效标记 [${stale.join(',')}]` : `；忽略失效标记 ${stale.length} 处（多为模板示例文字，无对应文献）`
      setBibMessage(`已更新参考文献表：识别 ${numbers.length} 处引用标记 → 收录 ${cited.length} 条${staleText}`)
    } catch (e) {
      setBridgeError(e instanceof Error ? e.message : String(e))
    } finally {
      setBibBusy(false)
    }
  }, [pid, docKey, requireReady, citationStyle])

  /** 定稿前清理托管标记（strip-bib-markers）：仅移除「[参考文献-平台生成]」头标记与「（完）」尾标记
   *  两个可见提示段，格式化好的 [1] … 文献条目原样保留；异常形态由插件 fail-closed 拒绝。 */
  const stripBibMarkers = useCallback(async () => {
    if (!requireReady()) return
    setBridgeError('')
    setBibMessage('')
    setBibWarnings([])
    setStripBusy(true)
    try {
      const res = await runRefsTaskAuto<{ removed?: number; entries?: number }>(
        pid, () => docKeyRef.current, setDocKey, 'strip-bib-markers', {})
      setBibMessage(`已清理参考文献托管标记（${res.removed ?? 0} 个），${res.entries ?? 0} 条文献条目原样保留——定稿版不再带平台标记`)
    } catch (e) {
      setBridgeError(e instanceof Error ? e.message : String(e))
    } finally {
      setStripBusy(false)
    }
  }, [pid, docKey, requireReady])

  /** 服务端引用重排（P1-0-B）：不依赖文献桥；结果落面板消息与警示，失败信息由工作台统一展示。 */
  const renumberCitations = useCallback(async (style?: CitationStyle): Promise<WordRenumberResult | null> => {
    if (!onRenumberCitations) return null
    setBridgeError(''); setBibMessage(''); setBibWarnings([])
    const res = await onRenumberCitations(style)
    if (!res) return null
    setBibWarnings(res.warnings ?? [])
    setBibMessage(res.changed
      ? `已按出现顺序重排 ${Object.keys(res.mapping).length} 处引用编号`
        + (res.rebuilt_block ? `，托管参考文献表已按「${CITATION_STYLE_LABELS[style ?? 'gb-t-7714-2015'].replace('（默认）', '')}」样式重建` : '')
      : '引用已按出现顺序排列，无需修改。')
    return res
  }, [onRenumberCitations])

  /** 提案应用（异步）：插件按原文全文精确检索，唯一命中才替换。 */
  const applyWordProposal = useCallback(async (anchor: AnchorLike, suggested: string): Promise<ApplyOutcome> => {
    if (!docKey) return { ok: false, reason: 'no_view' }
    try {
      await runRefsTaskAuto<{ reason?: string; mode?: string }>(pid, () => docKeyRef.current, setDocKey, 'apply-proposal', {
        original_text: anchor.original_text,
        suggested_text: suggested,
      })
      return { ok: true, reason: 'unique' }
    } catch (e) {
      const reason = (e as { reason?: string }).reason
      const msg = e instanceof Error ? e.message : String(e)
      if (reason === 'not_found' || msg.includes('not_found')) return { ok: false, reason: 'not_found' }
      if (reason === 'ambiguous' || msg.includes('ambiguous')) return { ok: false, reason: 'ambiguous' }
      if (reason === 'multi_paragraph') {
        setBridgeError('该提案原文跨段落（可能含公式/表格结构），已拒绝整段纯文本覆盖——请在 LaTeX/拆分后处理')
        return { ok: false, reason: 'not_found' }
      }
      setBridgeError(msg)
      return { ok: false, reason: 'no_view' }
    }
  }, [pid, docKey])

  /** 撤销（反向替换建议文本→原文）；失败提示在编辑器 Ctrl+Z。 */
  const revertWordProposal = useCallback(async (anchor: AnchorLike, appliedText: string): Promise<ApplyOutcome> => {
    if (!docKey) return { ok: false, reason: 'no_view' }
    try {
      await runRefsTaskAuto<{ reason?: string }>(pid, () => docKeyRef.current, setDocKey, 'apply-proposal', {
        original_text: appliedText,
        suggested_text: anchor.original_text,
      })
      return { ok: true, reason: 'unique' }
    } catch (e) {
      const reason = (e as { reason?: string }).reason
      const msg = e instanceof Error ? e.message : String(e)
      if (reason === 'not_found' || msg.includes('not_found')) return { ok: false, reason: 'not_found' }
      if (reason === 'ambiguous' || msg.includes('ambiguous')) return { ok: false, reason: 'ambiguous' }
      setBridgeError(msg)
      return { ok: false, reason: 'no_view' }
    }
  }, [pid, docKey])

  const getWordSelection = useCallback(() => {
    const text = selection.trim()
    if (!text) return null
    // Word 模式无 char 偏移：应用按「原文精确检索」定位，不依赖偏移/当前选区
    return { text, doc: text, from: 0, to: text.length }
  }, [selection])

  return (
    <aside className="flex w-96 max-w-[90vw] min-h-0 flex-col border-l border-border bg-panel" data-testid="word-side-panel">
      <div className="flex h-panel-header shrink-0 items-center gap-1 border-b border-border px-2">
        <span className="inline-flex items-center gap-1 text-xs font-medium text-fg-strong" data-testid="word-panel-title">
          {open === 'library' ? (
            <><BookOpen aria-hidden className="size-3.5" />文献</>
          ) : (
            <><Sparkles aria-hidden className="size-3.5" />论文助手</>
          )}
        </span>
        <button className="ml-auto rounded p-1 text-fg-muted hover:bg-hover" onClick={onClose} aria-label="收起面板" data-testid="word-panel-close">
          <X aria-hidden className="size-4" />
        </button>
      </div>
      {open === 'library' && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-2 py-1.5 text-xs" data-testid="word-bridge-status">
          {ready ? (
            <span className="inline-flex items-center gap-1 text-ok"><Plug aria-hidden className="size-3" />文献桥已就绪</span>
          ) : checking ? (
            <span className="inline-flex items-center gap-1 text-fg-muted"><Loader2 aria-hidden className="size-3 animate-spin" />探测插件…</span>
          ) : (
            <span className="inline-flex items-center gap-1 text-warning">
              <Plug aria-hidden className="size-3" />文献桥未就绪——插入/更新不可用
              <button
                className="rounded border border-line px-1 hover:bg-hover"
                onClick={() => {
                  setChecking(true)
                  void (async () => {
                    if (docKey) setReady(await bridgeAlive(docKey))
                    setChecking(false)
                  })()
                }}
                data-testid="word-bridge-retry"
              >
                重试探测
              </button>
            </span>
          )}
        </div>
      )}
      {bridgeError && (
        <div role="alert" className="shrink-0 border-b border-border px-2 py-1 text-xs text-danger-fg" data-testid="word-bridge-error">
          {bridgeError}
        </div>
      )}
      {bibWarnings.length > 0 && (
        <div role="alert" className="shrink-0 border-b border-border px-2 py-1.5 text-xs text-warning" data-testid="word-bib-warnings">
          {bibWarnings.map((w, i) => <div key={i}>{w}</div>)}
        </div>
      )}
      {bibMessage && (
        <div role="status" className="shrink-0 border-b border-border px-2 py-1.5 text-xs text-ok" data-testid="word-bib-message">
          {bibMessage}
        </div>
      )}
      {mode === 'plain' && (
        <div role="status" className="shrink-0 border-b border-border px-2 py-1.5 text-xs text-fg-muted">
          当前文档服务不支持引用内容控件——已插入静态文本标签（未绑定引用对象；重编号需删除后重新插入）。如实提示，非自动管理闭环。
        </div>
      )}
      {open === 'library' && (
        <label
          className="flex shrink-0 cursor-pointer items-center gap-1.5 border-b border-border px-2 py-1.5 text-xs text-fg-muted"
          data-testid="word-ref-superscript-row"
          title="勾选后插入的引用为上标格式，多个引用合并为一个编号（GB/T 7714 惯例）"
        >
          <input
            className="size-4"
            type="checkbox"
            checked={superscript}
            onChange={(e) => setSuperscript(e.target.checked)}
            data-testid="word-ref-superscript"
          />
          上标引用（[1-3] 连号压缩，GB/T 7714）
        </label>
      )}
      {open === 'library' && (
        <LibraryPanel
          pid={pid}
          canEdit={canEdit}
          activePath={null}
          onInsertCitations={(keys) => void insertCitations(keys)}
          onUpdateBibliography={() => void refreshBibliography()}
          bibliographyBusy={bibBusy}
          citationStyle={citationStyle}
          onCitationStyleChange={setCitationStyle}
          onStripBibMarkers={() => void stripBibMarkers()}
          stripBibMarkersBusy={stripBusy}
          onRenumberCitations={renumberCitations}
          renumberBusy={renumberBusy}
        />
      )}
      {open === 'preflight' && <WordPreflightPanel pid={pid} canEdit={canEdit} saving={saving} stateSha={stateSha} stateVersion={stateVersion} />}
      {open === 'rebuttal' && (
        <div className="flex min-h-0 flex-1 flex-col">
          <RebuttalPanel pid={pid} canEdit={canEdit} activeFile={null} cursorLine={null}
            onJump={() => { /* Word 模式无源码跳转 */ }} mode="word" />
        </div>
      )}
      {open === 'proposals' && (
        <ProposalPanel
          pid={pid}
          canEdit={canEdit}
          activePath="document.docx"
          dirty={false}
          saving={false}
          mode="word"
          hideSectionOption
          getSelection={getWordSelection}
          applyProposal={applyWordProposal}
          revertProposal={revertWordProposal}
          locateProposal={() => { /* Word 模式定位=应用内检索，由采纳路径完成 */ }}
          headerNote={`Word 采纳为「原文全文精确检索 + 纯文本替换」（与采纳时的选区无关；保留段落样式，字符级格式不保留）；原文变化/多处命中/跨段一律阻断。${selection.trim() ? `已捕获选区 ${selection.trim().length} 字。` : '在左侧正文选中文字后生成。'}`}
        />
      )}
    </aside>
  )
}

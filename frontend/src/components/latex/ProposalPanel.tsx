import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUp, BookOpen, CheckCheck, CheckCircle2, ChevronDown, ChevronRight, Copy, Download,
  FileWarning, Loader2, Lock, PenLine, RotateCcw, ShieldCheck, Sparkles, Undo2, Wand2, X, XCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  paperProposalApi,
  PROPOSAL_ACTION_LABELS,
  PROPOSAL_STATUS_LABELS,
  PROTECTION_LABELS,
  type AiDisclosureResponse,
  type FixVerification,
  type PaperProposal,
  type ProposalAction,
} from '@/lib/api/paperProposals'
import { assistantApi } from '@/lib/api/paperProposals'
import type { ApplyOutcome, AnchorLike } from './proposalApply'
import { computeDiff } from './proposalDiff'

/**
 * AI 修改提案面板（v0.4）：选区生成 → 差异审阅 → 安全采纳/拒绝/撤销。
 * 落地在编辑器事务（proposalApply.ts）：服务端从不改源文件；「已采纳到草稿」与「已保存服务器」分开反馈。
 * 保护规则：数值/引用/公式/ref 被改动的提案必须显式勾选确认才能采纳（不静默当润色）。
 */

const errText = (e: unknown): string => {
  const anyErr = e as { message?: string; detail?: { message?: string } }
  return anyErr?.detail?.message || anyErr?.message || String(e)
}

export interface SelectionSnapshot {
  text: string
  doc: string
  from: number
  to: number
}

interface Props {
  pid: string
  canEdit: boolean
  activePath: string | null
  dirty: boolean
  saving: boolean
  getSelection: () => SelectionSnapshot | null
  /** LaTeX=同步 CM 事务；Word=插件任务往返（Promise）。 */
  applyProposal: (anchor: AnchorLike, suggested: string) => ApplyOutcome | Promise<ApplyOutcome>
  revertProposal: (anchor: AnchorLike, appliedText: string) => ApplyOutcome | Promise<ApplyOutcome>
  locateProposal: (anchor: AnchorLike & { file: string }) => void
  reloadSignal?: number
  /** 面板顶部提示（Word 模式：桥接可用性等）。 */
  headerNote?: string
  /** 写作模式（生成载荷与文案用；默认 latex）。 */
  mode?: 'latex' | 'word'
  /** 「按章节生成」仅 LaTeX 有意义。 */
  hideSectionOption?: boolean
  /** 修复验证闭环（仅 LaTeX；工作台实现：等保存落定→重编译→对照错误→刷新构建面板）。 */
  verifyFix?: (proposalId: string) => Promise<FixVerification>
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function ProposalPanel(props: Props) {
  const { pid, canEdit, activePath, dirty, saving, getSelection, applyProposal, revertProposal, locateProposal, reloadSignal = 0, headerNote, mode = 'latex', hideSectionOption = false, verifyFix } = props
  const [proposals, setProposals] = useState<PaperProposal[] | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [scopeAll, setScopeAll] = useState(false)
  const [batchSel, setBatchSel] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<string | null>(null)
  const [protectedAck, setProtectedAck] = useState<Set<string>>(new Set())
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editedText, setEditedText] = useState('')
  const [bottomMode, setBottomMode] = useState<'custom' | 'writing'>('custom')
  const [writingFocus, setWritingFocus] = useState(0)
  const [activeTask, setActiveTask] = useState<string | null>(null)
  const [reading, setReading] = useState<{ answer: string; model: string } | null>(null)
  const [readingBusy, setReadingBusy] = useState(false)
  const [readingError, setReadingError] = useState('')
  const [disclosureOpen, setDisclosureOpen] = useState(false)
  const [disclosureLang, setDisclosureLang] = useState<'zh' | 'en'>('zh')
  const [disclosureFmt, setDisclosureFmt] = useState<'markdown' | 'latex'>('markdown')
  const [disclosure, setDisclosure] = useState<AiDisclosureResponse | null>(null)
  const [disclosureBusy, setDisclosureBusy] = useState(false)
  const [disclosureCopied, setDisclosureCopied] = useState(false)

  const loadDisclosure = useCallback(async (lang: 'zh' | 'en', fmt: 'markdown' | 'latex') => {
    setDisclosureBusy(true)
    try {
      const r = await paperProposalApi.disclosure(pid, { lang, format: fmt })
      setDisclosure(r)
    } catch (e) {
      setError(errText(e))
    } finally {
      setDisclosureBusy(false)
    }
  }, [pid])

  useEffect(() => {
    if (disclosureOpen) {
      void loadDisclosure(disclosureLang, disclosureFmt)
    }
  }, [disclosureOpen, disclosureLang, disclosureFmt, loadDisclosure, proposals])

  const refresh = useCallback(async () => {
    try {
      const r = await paperProposalApi.list(pid)
      setProposals(r.proposals)
      setError('')
    } catch (e) {
      setError(errText(e))
    }
  }, [pid])

  useEffect(() => {
    void refresh()
  }, [refresh, reloadSignal])

  const visible = useMemo(() => {
    const all = proposals ?? []
    return scopeAll ? all : all.filter((p) => p.anchor.file === activePath)
  }, [proposals, scopeAll, activePath])

  const pending = visible.filter((p) => p.status === 'pending')
  const processed = visible.filter((p) => ['applied', 'rejected', 'undone', 'stale', 'failed'].includes(p.status))

  const generate = useCallback(async (action: ProposalAction, instruction?: string, useSection = false) => {
    const sel = getSelection()
    if (action !== 'writing' && (!sel || !sel.text.trim())) {
      setNotice('请先在编辑器中选中要修改的文字')
      return
    }
    if (!activePath) return
    setBusy(true)
    setActiveTask(action)
    setError('')
    setNotice('')
    try {
      const insertMode = action === 'writing'
      let text = sel ? sel.text : ''
      if (!insertMode && useSection) {
        // 以光标所在 section 为范围（选区起点所在节）
        const range = sectionRangeOf(sel!.doc, sel!.from)
        if (range) text = sel!.doc.slice(range.from, range.to)
      }
      if (text.length > 8000) {
        setError('选区过长（>8000 字符），请缩小范围（不支持外发整篇论文）')
        return
      }
      const payloadSel = insertMode
        ? { original_text: '', context_before: '', context_after: '' }
        : payloadFor(sel!.doc, text)
      const baseSha = await sha256Hex(sel ? sel.doc : '')
      const r = await paperProposalApi.generate(pid, {
        mode,
        file: activePath,
        base_sha: baseSha,
        original_text: payloadSel.original_text,
        context_before: payloadSel.context_before,
        context_after: payloadSel.context_after,
        action,
        instruction,
      })
      setNotice(`已生成提案（${PROPOSAL_ACTION_LABELS[action]}），请在下方审阅`)
      setExpanded(r.proposal.proposal_id)
      await refresh()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
      setActiveTask(null)
    }
  }, [getSelection, pid, activePath, refresh, mode])

  const runReading = useCallback(async () => {
    const sel = getSelection()
    if (!sel || !sel.text.trim()) {
      setNotice('请先在编辑器中选中要精读的文字')
      return
    }
    if (!activePath) return
    if (sel.text.length > 20000) {
      setReadingError('选区过长（>2 万字符），请缩小范围')
      return
    }
    setReadingBusy(true)
    setReadingError('')
    setActiveTask('read')
    try {
      const r = await assistantApi.read(pid, { mode, file: activePath, text: sel.text })
      setReading({ answer: r.answer, model: r.model })
    } catch (e) {
      setReadingError(errText(e))
    } finally {
      setReadingBusy(false)
      setActiveTask(null)
    }
  }, [getSelection, pid, activePath, mode])

  const [verifyingId, setVerifyingId] = useState<string | null>(null)
  const runVerify = useCallback(async (proposalId: string) => {
    if (!verifyFix) return
    setVerifyingId(proposalId)
    setNotice('已采纳，正在重编译验证修复…')
    setError('')
    try {
      const ver = await verifyFix(proposalId)
      setNotice(ver.resolved
        ? `修复已验证：重编译通过，目标编译错误已消失${ver.issue_resolved ? '；关联 Issue 已标记解决' : ''}`
        : '重编译仍报错——请到 Issues 页签查看当前编译错误，可继续修改后「再次验证」')
      await refresh()
    } catch (e) {
      setError(`修复验证失败：${errText(e)}`)
    } finally {
      setVerifyingId(null)
    }
  }, [verifyFix, refresh])

  const doApply = useCallback(async (p: PaperProposal, suggestedOverride?: string) => {
    const suggested = suggestedOverride ?? p.suggested_text
    const flags = p.protection_flags ?? []
    if (flags.length && !suggestedOverride && !protectedAck.has(p.proposal_id)) {
      setNotice('该提案包含数值/引用等敏感改动——请先勾选确认')
      return
    }
    const outcome = await applyProposal({ original_text: p.anchor.original_text, context_before: p.anchor.context_before, context_after: p.anchor.context_after }, suggested)
    if (!outcome.ok) {
      const msg = outcome.reason === 'not_found' ? '原文已变化（找不到提案时的原文）——已标记为「原文已变化」'
        : outcome.reason === 'ambiguous' ? '原文出现多处且无法消歧——已阻止采纳（不自动猜位置）'
          : outcome.reason === 'file_mismatch' ? `该提案属于文件 ${p.anchor.file}，请先打开该文件再采纳`
            : outcome.reason === 'composing' ? '输入法输入中，请稍候再试'
              : outcome.reason === 'readonly' ? '当前为只读模式，不能采纳'
                : '无法在当前文档定位提案原文'
      setNotice(msg)
      if (outcome.reason === 'not_found' || outcome.reason === 'ambiguous') {
        try {
          await paperProposalApi.setStatus(pid, p.proposal_id, 'stale')
          await refresh()
        } catch (e) {
          setError(errText(e))
        }
      }
      return
    }
    try {
      await paperProposalApi.setStatus(pid, p.proposal_id, 'applied', suggested)
      setNotice('已采纳到草稿（自动保存进行中；保存成功前不会写入服务器）')
      setProtectedAck((prev) => {
        const next = new Set(prev)
        next.delete(p.proposal_id)
        return next
      })
      await refresh()
    } catch (e) {
      setError(`提案已写入草稿，但状态记录失败：${errText(e)}`)
      return
    }
    // 修复闭环：修复类提案（带编译错误快照）采纳后自动重编译验证；验证失败不影响已采纳的事实
    if (mode === 'latex' && p.error_context && verifyFix) {
      await runVerify(p.proposal_id)
    }
  }, [applyProposal, pid, protectedAck, refresh, mode, verifyFix, runVerify])

  const doUndo = useCallback(async (p: PaperProposal) => {
    const applied = p.applied_text ?? p.suggested_text
    const outcome = await revertProposal({ original_text: p.anchor.original_text, context_before: '', context_after: '' }, applied)
    if (!outcome.ok) {
      setNotice('无法自动撤销（正文已变化）——请在编辑器中 Ctrl+Z 撤销')
      return
    }
    try {
      await paperProposalApi.setStatus(pid, p.proposal_id, 'undone')
      setNotice('已撤销（回到采纳前的文本，仍可在编辑器中 Ctrl+Z 恢复）')
      await refresh()
    } catch (e) {
      setError(errText(e))
    }
  }, [revertProposal, pid, refresh])

  const doReject = useCallback(async (p: PaperProposal) => {
    try {
      await paperProposalApi.setStatus(pid, p.proposal_id, 'rejected')
      await refresh()
    } catch (e) {
      setError(errText(e))
    }
  }, [pid, refresh])

  const doBatch = useCallback(async () => {
    if (!batchSel.size) return
    const chosen = pending.filter((p) => batchSel.has(p.proposal_id))
    // 逐条独立定位（文本定位天然抗偏移）；Word 路径按序往返
    let applied = 0
    const skipped: string[] = []
    for (const p of chosen) {
      if (p.protection_flags.length && !protectedAck.has(p.proposal_id)) {
        skipped.push(`${p.proposal_id}（含敏感改动未确认）`)
        continue
      }
      const outcome = await applyProposal({ original_text: p.anchor.original_text, context_before: p.anchor.context_before, context_after: p.anchor.context_after }, p.suggested_text)
      if (!outcome.ok) {
        skipped.push(`${truncate(p.anchor.original_text)}（${outcome.reason === 'ambiguous' ? '位置歧义' : '原文已变化'}）`)
        continue
      }
      try {
        await paperProposalApi.setStatus(pid, p.proposal_id, 'applied')
        applied += 1
      } catch {
        skipped.push(`${truncate(p.anchor.original_text)}（状态记录失败）`)
      }
    }
    setBatchSel(new Set())
    setNotice(`批量采纳完成：${applied} 条写入草稿${skipped.length ? `；跳过 ${skipped.length} 条（${skipped.join('；')}）` : ''}`)
    await refresh()
  }, [batchSel, pending, protectedAck, applyProposal, pid, refresh])

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="proposal-panel">
      <div className="flex h-panel-header shrink-0 items-center gap-2 border-b border-line bg-panel px-2.5 text-xs">
        <span className="grid size-5 shrink-0 place-items-center rounded-md bg-primary-soft text-primary">
          <Sparkles aria-hidden className="size-3" />
        </span>
        <span className="font-semibold text-fg-strong">论文助手</span>
        {pending.length > 0 && (
          <span className="rounded-full bg-primary-soft px-1.5 py-px text-2xs font-medium text-primary">
            {pending.length} 待审阅
          </span>
        )}
        <Button variant="ghost" size="icon-xs" className="ml-auto" onClick={() => void refresh()} aria-label="刷新提案" data-testid="proposal-refresh">
          <RotateCcw aria-hidden className="size-3" />
        </Button>
      </div>
      {headerNote && <div className="shrink-0 border-b border-line px-2.5 py-1.5 text-2xs leading-4 text-fg-muted">{headerNote}</div>}

      {/* 生成区：论文助手四能力（常驻；有提案时收进紧凑卡） */}
      <div className="shrink-0 border-b border-line px-2.5 pb-2.5 pt-2" data-testid="proposal-generate">
        {pending.length === 0 && processed.length === 0 && (
          <div className="mb-2 flex items-center justify-center gap-1.5 text-sm font-medium text-fg-strong" data-testid="assistant-hero-title">
            <Sparkles aria-hidden className="size-4 text-primary" />
            从一个快捷任务开始
          </div>
        )}
        <div className="grid grid-cols-2 gap-2" data-testid="assistant-hero">
          <QuickTaskCard
            testid="assistant-card-read"
            chip="bg-info-bg text-info-fg"
            icon={<BookOpen aria-hidden className="size-4" />}
            title="论文精读"
            desc="解读选中文段并给出分析建议"
            loading={activeTask === 'read'}
            disabled={busy || readingBusy}
            onClick={() => void runReading()}
          />
          <QuickTaskCard
            testid="assistant-card-writing"
            chip="bg-violet-bg text-violet-fg"
            icon={<PenLine aria-hidden className="size-4" />}
            title="论文写作"
            desc="起草段落或规划论证结构"
            loading={false}
            disabled={busy || !canEdit}
            onClick={() => { setBottomMode('writing'); setWritingFocus((v) => v + 1) }}
          />
          <QuickTaskCard
            testid="assistant-card-polish"
            chip="bg-primary-soft text-primary"
            icon={<Sparkles aria-hidden className="size-4" />}
            title="论文润色"
            desc="润色选中文本，保留原意"
            loading={activeTask === 'polish'}
            disabled={busy || readingBusy}
            onClick={() => void generate('polish')}
          />
          <QuickTaskCard
            testid="assistant-card-deai"
            chip="bg-orange-bg text-orange-fg"
            icon={<Wand2 aria-hidden className="size-4" />}
            title="去 AI 味"
            desc="让选中的学术表达更自然"
            loading={activeTask === 'deai'}
            disabled={busy || readingBusy}
            onClick={() => void generate('deai')}
          />
        </div>
        {!hideSectionOption && (
          <div className="mt-1.5 flex items-center gap-1 px-0.5 text-2xs text-fg-muted">
            <span className="shrink-0">学术改写</span>
            {(['academic', 'condense', 'expand'] as ProposalAction[]).map((a) => (
              <button
                key={a}
                type="button"
                className="rounded px-1.5 py-0.5 text-2xs text-fg-muted transition-colors hover:bg-hover hover:text-fg-strong disabled:opacity-50"
                disabled={busy || readingBusy}
                onClick={() => void generate(a)}
                data-testid={`proposal-gen-${a}`}
              >
                {activeTask === a && <Loader2 aria-hidden className="mr-0.5 inline size-3 animate-spin" />}
                {PROPOSAL_ACTION_LABELS[a]}
              </button>
            ))}
          </div>
        )}
        <ReadingOutput reading={reading} readingError={readingError} onClear={() => setReading(null)} />
      </div>

      {error && <div role="alert" className="shrink-0 border-b border-line px-2.5 py-1.5 text-xs text-danger" data-testid="proposal-error">{error}</div>}
      {notice && <div role="status" className="shrink-0 border-b border-line px-2.5 py-1.5 text-xs text-fg-muted" data-testid="proposal-notice">{notice}</div>}

      <div className="flex shrink-0 items-center border-b border-line px-2.5 py-1.5">
        <div className="inline-flex rounded-md bg-sunken p-0.5" role="group" aria-label="提案范围">
          <button
            type="button"
            className={cn('rounded-sm px-2 py-0.5 text-2xs transition-colors', !scopeAll ? 'bg-panel font-medium text-fg-strong shadow-sm' : 'text-fg-muted hover:text-fg')}
            onClick={() => setScopeAll(false)}
          >
            当前文件
          </button>
          <button
            type="button"
            className={cn('rounded-sm px-2 py-0.5 text-2xs transition-colors', scopeAll ? 'bg-panel font-medium text-fg-strong shadow-sm' : 'text-fg-muted hover:text-fg')}
            onClick={() => setScopeAll(true)}
          >
            全部文件
          </button>
        </div>
        {saving && <span className="ml-auto text-2xs text-fg-muted">保存中…</span>}
        {!saving && dirty && <span className="ml-auto text-2xs text-warning">待保存</span>}
        <button
          type="button"
          className={cn(
            'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-2xs transition-colors',
            !saving && !dirty ? 'ml-auto' : 'ml-2',
            disclosureOpen
              ? 'border-primary/40 bg-primary/10 font-medium text-primary'
              : 'border-line bg-panel text-fg-muted hover:text-fg-strong',
          )}
          onClick={() => setDisclosureOpen((v) => !v)}
          data-testid="ai-disclosure-btn"
          title="基于提案审计台账生成可投稿的 AI 使用披露声明"
        >
          <ShieldCheck aria-hidden className="size-3" /> AI 披露声明
        </button>
      </div>

      {disclosureOpen && (
        <div className="shrink-0 border-b border-line bg-sunken/40 p-2.5 text-xs" data-testid="ai-disclosure-panel">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium text-fg-strong">AI 使用披露声明</span>
            <div className="inline-flex rounded bg-panel p-0.5 border border-line">
              {(['zh', 'en'] as const).map((l) => (
                <button
                  key={l}
                  type="button"
                  onClick={() => setDisclosureLang(l)}
                  className={cn('rounded px-1.5 py-0.5 text-2xs', disclosureLang === l ? 'bg-primary text-primary-fg' : 'text-fg-muted hover:text-fg')}
                  data-testid={`ai-disclosure-lang-${l}`}
                >
                  {l === 'zh' ? '中文' : 'English'}
                </button>
              ))}
            </div>
            <div className="inline-flex rounded bg-panel p-0.5 border border-line">
              {(['markdown', 'latex'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setDisclosureFmt(f)}
                  className={cn('rounded px-1.5 py-0.5 text-2xs', disclosureFmt === f ? 'bg-primary text-primary-fg' : 'text-fg-muted hover:text-fg')}
                  data-testid={`ai-disclosure-fmt-${f}`}
                >
                  {f === 'markdown' ? 'Markdown' : 'LaTeX'}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="ml-auto rounded p-0.5 text-fg-muted hover:bg-hover hover:text-fg"
              onClick={() => setDisclosureOpen(false)}
              aria-label="关闭 AI 披露声明"
            >
              <X aria-hidden className="size-3.5" />
            </button>
          </div>
          {disclosureBusy && !disclosure && <div className="mt-2 text-2xs text-fg-muted">汇总提案台账中…</div>}
          {disclosure && (
            <>
              <div className="mt-1.5 flex flex-wrap gap-1.5 text-2xs text-fg-muted">
                <span className="rounded bg-panel px-1.5 py-0.5 border border-line">
                  已采纳 {disclosure.summary.applied_count}/{disclosure.summary.total_proposals}
                </span>
                <span className="rounded bg-panel px-1.5 py-0.5 border border-line">
                  人工改写 {disclosure.summary.human_edited_count}
                </span>
                <span className="rounded bg-panel px-1.5 py-0.5 border border-line">
                  保护项复核 {disclosure.summary.protected_applied_count}
                </span>
              </div>
              <pre
                className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap rounded border border-line bg-panel p-2 font-mono text-2xs leading-4 text-fg"
                data-testid="ai-disclosure-content"
              >
                {disclosure.content}
              </pre>
              <div className="mt-1.5 flex items-center gap-1.5">
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    void navigator.clipboard?.writeText(disclosure.content)
                    setDisclosureCopied(true)
                    setTimeout(() => setDisclosureCopied(false), 1800)
                  }}
                  data-testid="ai-disclosure-copy"
                >
                  <Copy aria-hidden className="size-3" /> {disclosureCopied ? '已复制' : '复制声明'}
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    const blob = new Blob([disclosure.content], { type: 'text/plain;charset=utf-8' })
                    const url = URL.createObjectURL(blob)
                    const a = document.createElement('a')
                    a.href = url
                    a.download = disclosure.filename
                    a.click()
                    URL.revokeObjectURL(url)
                  }}
                  data-testid="ai-disclosure-download"
                >
                  <Download aria-hidden className="size-3" /> 下载 {disclosure.filename}
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto p-2" data-testid="proposal-list">
        {proposals === null && <div className="p-2 text-xs text-fg-muted">加载中…</div>}
        {proposals !== null && pending.length === 0 && processed.length === 0 && (
          <div className="p-2 text-xs leading-5 text-fg-muted">
            暂无提案——在编辑器选中一段文字，点上方能力卡或底部输入指令生成。
            {dirty && '（当前文件有未保存修改，生成锚点以编辑器当前内容为准）'}
          </div>
        )}
        {pending.length > 1 && (
          <div className="mb-1.5 flex items-center gap-1.5 rounded-md border border-line bg-panel px-2 py-1 text-xs">
            <input
              type="checkbox"
              className="accent-primary"
              checked={batchSel.size === pending.length && batchSel.size > 0}
              onChange={(e) => setBatchSel(e.target.checked ? new Set(pending.map((p) => p.proposal_id)) : new Set())}
              aria-label="全选待审阅"
            />
            <span>全选（{batchSel.size}/{pending.length}）</span>
            <Button size="xs" className="ml-auto" disabled={busy || !canEdit || batchSel.size === 0} onClick={() => void doBatch()} data-testid="proposal-batch">
              <CheckCheck aria-hidden className="size-3" /> 批量采纳（自动跳过冲突）
            </Button>
          </div>
        )}
        <ul className="space-y-1.5">
          {pending.map((p) => (
            <ProposalCard
              key={p.proposal_id}
              p={p}
              expanded={expanded === p.proposal_id}
              onToggle={() => setExpanded(expanded === p.proposal_id ? null : p.proposal_id)}
              canEdit={canEdit}
              acked={protectedAck.has(p.proposal_id)}
              onAck={() => setProtectedAck((prev) => new Set(prev).add(p.proposal_id))}
              batchChecked={batchSel.has(p.proposal_id)}
              onBatchCheck={() => setBatchSel((prev) => {
                const next = new Set(prev)
                if (next.has(p.proposal_id)) next.delete(p.proposal_id)
                else next.add(p.proposal_id)
                return next
              })}
              showBatch={pending.length > 1}
              onLocate={() => locateProposal({ file: p.anchor.file, original_text: p.anchor.original_text, context_before: p.anchor.context_before, context_after: p.anchor.context_after })}
              onApply={() => void doApply(p)}
              onReject={() => void doReject(p)}
              editing={editingId === p.proposal_id}
              onStartEdit={() => { setEditingId(p.proposal_id); setEditedText(p.suggested_text) }}
              editedText={editedText}
              onEditedText={setEditedText}
              onCancelEdit={() => setEditingId(null)}
              onApplyEdited={() => { void doApply(p, editedText); setEditingId(null) }}
            />
          ))}
        </ul>
        {processed.length > 0 && (
          <details className="mt-2" data-testid="proposal-processed">
            <summary className="cursor-pointer text-xs text-fg-muted">已处理记录（{processed.length}）</summary>
            <ul className="mt-1 space-y-1">
              {processed.map((p) => (
                <li key={p.proposal_id} className="rounded-md border border-line bg-panel p-1.5 text-xs">
                  <div className="flex items-center gap-1.5">
                    <StatusChip p={p} />
                    <span className="truncate text-fg-muted" title={p.anchor.original_text}>{truncate(p.anchor.original_text)}</span>
                    {p.status === 'applied' && canEdit && (
                      <Button variant="ghost" size="xs" className="ml-auto h-5 px-1" onClick={() => void doUndo(p)} data-testid={`proposal-undo-${p.proposal_id}`}>
                        <Undo2 aria-hidden className="size-3" /> 撤销
                      </Button>
                    )}
                  </div>
                  {p.status === 'failed' && p.error && <div className="mt-0.5 text-danger">{p.error}</div>}
                  <div className="mt-0.5 text-2xs text-fg-muted">
                    {new Date(p.created_at * 1000).toLocaleString()} · {PROPOSAL_ACTION_LABELS[p.action]} · {p.model || '—'}
                    {p.applied_at && ` · 采纳于 ${new Date(p.applied_at * 1000).toLocaleTimeString()}`}
                  </div>
                  {/* 修复验证历史（修复类提案可回看；显式触发再次验证） */}
                  {mode === 'latex' && p.status === 'applied' && p.error_context && (
                    <div className="mt-1 border-t border-line pt-1" data-testid={`proposal-verify-${p.proposal_id}`}>
                      <div className="flex items-center gap-1.5">
                        <span className="text-2xs font-medium text-fg-muted">修复验证</span>
                        {(p.verifications ?? []).slice(-1).map((v, i) => (
                          <span key={i} className={cn('rounded px-1 text-2xs',
                            v.resolved ? 'bg-ok/10 text-ok' : 'bg-warning/10 text-warning')}>
                            {v.resolved ? '✓ 错误已消失' : '⚠ 仍报错'}
                          </span>
                        ))}
                        {(p.verifications?.length ?? 0) > 1 && (
                          <span className="text-2xs text-fg-muted">共 {p.verifications!.length} 次</span>
                        )}
                        {verifyFix && canEdit && (
                          <Button variant="ghost" size="xs" className="ml-auto h-5 px-1" disabled={verifyingId === p.proposal_id}
                            onClick={() => void runVerify(p.proposal_id)} data-testid={`proposal-reverify-${p.proposal_id}`}>
                            {verifyingId === p.proposal_id
                              ? <Loader2 aria-hidden className="size-3 animate-spin" />
                              : <RotateCcw aria-hidden className="size-3" />}
                            再次验证
                          </Button>
                        )}
                      </div>
                      {(p.verifications ?? []).slice(-3).map((v, i) => (
                        <div key={i} className="mt-0.5 text-2xs text-fg-muted">
                          {new Date(v.at * 1000).toLocaleTimeString()} · {v.resolved ? '编译通过，目标错误消失' : '编译仍失败'} · 构建 {v.build_id.slice(-6)}
                          {v.issue_resolved && ' · Issue 已解决'}
                        </div>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>

      <InstructionBar
        busy={busy}
        canEdit={canEdit}
        mode={bottomMode}
        onMode={setBottomMode}
        focusSignal={writingFocus}
        section={!hideSectionOption ? (
          <label className="flex items-center gap-1 text-2xs text-fg-muted">
            <input type="checkbox" className="accent-primary" disabled={busy} onChange={(e) => {
              if (e.target.checked) void generate('polish', undefined, true)
            }} data-testid="proposal-gen-section" />
            按当前章节整体生成
          </label>
        ) : null}
        onSend={(text, m) => void generate(m === 'writing' ? 'writing' : 'custom', text)}
      />
    </div>
  )
}

function truncate(s: string, n = 40): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

function payloadFor(doc: string, text: string): { original_text: string; context_before: string; context_after: string } {
  const from = doc.indexOf(text)
  if (from === -1) return { original_text: text, context_before: '', context_after: '' }
  return {
    original_text: text,
    context_before: doc.slice(Math.max(0, from - 400), from),
    context_after: doc.slice(from + text.length, from + text.length + 400),
  }
}

function sectionRangeOf(doc: string, pos: number): { from: number; to: number } | null {
  const lines = doc.split('\n')
  let offset = 0
  let start = -1
  let startOffset = 0
  let endOffset = doc.length
  let level = -1
  for (const line of lines) {
    const m = /^\\(section|subsection)\*?\{/.exec(line)
    if (m) {
      const lvl = m[1] === 'subsection' ? 2 : 1
      if (start === -1 && offset <= pos) {
        start = offset
        startOffset = offset
        level = lvl
      } else if (start !== -1 && lvl <= level) {
        endOffset = offset
        break
      }
    }
    offset += line.length + 1
  }
  if (start === -1) return null
  return { from: startOffset, to: endOffset }
}

function StatusChip({ p }: { p: PaperProposal }) {
  const cls = p.status === 'applied' ? 'bg-ok/10 text-ok'
    : p.status === 'rejected' ? 'bg-sunken text-fg-muted'
      : p.status === 'stale' ? 'bg-warning/10 text-warning'
        : p.status === 'failed' ? 'bg-danger/10 text-danger'
          : 'bg-sunken text-fg-muted'
  return <span className={cn('rounded px-1 text-2xs', cls)}>{PROPOSAL_STATUS_LABELS[p.status]}</span>
}

function ProposalCard({
  p, expanded, onToggle, canEdit, acked, onAck, batchChecked, onBatchCheck, showBatch,
  onLocate, onApply, onReject, editing, onStartEdit, editedText, onEditedText, onCancelEdit, onApplyEdited,
}: {
  p: PaperProposal
  expanded: boolean
  onToggle(): void
  canEdit: boolean
  acked: boolean
  onAck(): void
  batchChecked: boolean
  onBatchCheck(): void
  showBatch: boolean
  onLocate(): void
  onApply(): void
  onReject(): void
  editing: boolean
  onStartEdit(): void
  editedText: string
  onEditedText(s: string): void
  onCancelEdit(): void
  onApplyEdited(): void
}) {
  const parts = useMemo(() => computeDiff(p.anchor.original_text, p.suggested_text), [p.anchor.original_text, p.suggested_text])
  const hasProtection = (p.protection_flags ?? []).length > 0
  return (
    <li className="rounded-lg border border-line bg-panel text-xs shadow-sm transition-colors hover:border-border-strong" data-testid={`proposal-${p.proposal_id}`}>
      <div className="flex items-center gap-1.5 p-2">
        {showBatch && (
          <input type="checkbox" className="shrink-0 accent-primary" checked={batchChecked} onChange={onBatchCheck} aria-label="加入批量" />
        )}
        <button className="min-w-0 flex-1 text-left" onClick={onToggle}>
          <span className="block truncate font-medium text-fg-strong" title={p.anchor.original_text}>{truncate(p.anchor.original_text, 36)}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-1 text-2xs text-fg-muted">
            <span className="rounded bg-sunken px-1 font-medium text-fg">{PROPOSAL_ACTION_LABELS[p.action]}</span>
            <span>· {p.model || '—'}</span>
            <span>· {p.anchor.file}</span>
            {hasProtection && (
              <span className="inline-flex items-center gap-0.5 rounded bg-warning-soft px-1 text-warning-foreground" data-testid={`proposal-flags-${p.proposal_id}`}>
                <FileWarning aria-hidden className="size-3" />
                {(p.protection_flags ?? []).map((f) => PROTECTION_LABELS[f] ?? f).join('、')}
              </span>
            )}
          </span>
        </button>
        <button className="shrink-0 rounded p-0.5 text-fg-muted transition-colors hover:bg-hover hover:text-fg" onClick={onToggle} aria-label="展开差异">
          {expanded ? <ChevronDown aria-hidden className="size-3.5" /> : <ChevronRight aria-hidden className="size-3.5" />}
        </button>
      </div>
      {expanded && (
        <div className="border-t border-line px-2 py-2">
          {p.rationale && <div className="mb-1 text-2xs leading-4 text-fg-muted">理由：{p.rationale}</div>}
          {/* 差异：删除线=原文，高亮=建议 */}
          <div className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-sunken p-2 text-xs leading-5" data-testid={`proposal-diff-${p.proposal_id}`}>
            {parts.map((part, i) => {
              if (part.type === 'same') return <span key={i}>{part.text}</span>
              if (part.type === 'del') return <del key={i} className="bg-danger/10 text-danger">{part.text}</del>
              return <ins key={i} className="bg-ok/10 text-ok no-underline">{part.text}</ins>
            })}
          </div>
          {hasProtection && (
            <div className="mt-1.5 rounded-md bg-warning-soft px-2 py-1.5 text-warning-foreground" role="alert" data-testid={`proposal-protect-warn-${p.proposal_id}`}>
              <Lock aria-hidden className="mr-1 inline size-3" />
              检测到{(p.protection_flags ?? []).map((f) => PROTECTION_LABELS[f] ?? f).join('、')}——默认不改变实验数字、公式与引用。确认保留这些改动才能采纳：
              <label className="ml-1 inline-flex items-center gap-0.5">
                <input type="checkbox" className="accent-primary" checked={acked} onChange={onAck} data-testid={`proposal-ack-${p.proposal_id}`} />
                我已核对
              </label>
            </div>
          )}
          {editing ? (
            <div className="mt-1.5">
              <textarea
                className="h-24 w-full rounded-md border border-line bg-app p-2 text-xs"
                value={editedText}
                onChange={(e) => onEditedText(e.target.value)}
                data-testid={`proposal-edit-text-${p.proposal_id}`}
              />
              <div className="mt-1 flex gap-1">
                <Button size="xs" disabled={!editedText.trim()} onClick={onApplyEdited} data-testid={`proposal-apply-edited-${p.proposal_id}`}>按编辑后文本采纳</Button>
                <Button variant="ghost" size="xs" onClick={onCancelEdit}>取消</Button>
              </div>
            </div>
          ) : (
            <div className="mt-2 flex flex-wrap items-center gap-1">
              <Button variant="ghost" size="xs" onClick={onLocate} data-testid={`proposal-locate-${p.proposal_id}`}>定位原文</Button>
              {canEdit && (
                <>
                  <Button size="xs" onClick={onApply} disabled={hasProtection && !acked} data-testid={`proposal-apply-${p.proposal_id}`}>
                    <CheckCircle2 aria-hidden className="size-3" /> 采纳
                  </Button>
                  <Button variant="outline" size="xs" onClick={onStartEdit} data-testid={`proposal-edit-${p.proposal_id}`}>编辑建议后采纳</Button>
                  <Button variant="ghost" size="xs" className="ml-auto" onClick={onReject} data-testid={`proposal-reject-${p.proposal_id}`}>
                    <XCircle aria-hidden className="size-3" /> 拒绝
                  </Button>
                </>
              )}
              {!canEdit && <span className="ml-auto inline-flex items-center gap-0.5 text-2xs text-fg-muted"><X aria-hidden className="size-3" />只读：不能采纳</span>}
            </div>
          )}
        </div>
      )}
    </li>
  )
}

function ReadingOutput({ reading, readingError, onClear }: {
  reading: { answer: string; model: string } | null
  readingError: string
  onClear(): void
}) {
  if (!reading && !readingError) return null
  return (
    <div className="mt-2 overflow-hidden rounded-lg border border-line bg-panel shadow-sm" data-testid="assistant-reading">
      <div className="flex items-center gap-1.5 border-b border-line px-2 py-1.5 text-xs">
        <span className="grid size-4.5 place-items-center rounded bg-info-bg text-info-fg">
          <BookOpen aria-hidden className="size-3" />
        </span>
        <span className="font-semibold text-fg-strong">精读分析</span>
        {reading && <span className="text-2xs text-fg-muted">· {reading.model}</span>}
        <button className="ml-auto rounded p-0.5 text-fg-muted transition-colors hover:bg-hover hover:text-fg" onClick={onClear} aria-label="收起精读">
          <X aria-hidden className="size-3" />
        </button>
      </div>
      {readingError && <div role="alert" className="px-2 py-1.5 text-xs text-danger">{readingError}</div>}
      {reading && (
        <div className="max-h-72 overflow-auto whitespace-pre-wrap px-2.5 py-2 text-xs leading-5">{reading.answer}</div>
      )}
    </div>
  )
}

function QuickTaskCard({ testid, chip, icon, title, desc, loading, disabled, onClick }: {
  testid: string
  chip: string
  icon: React.ReactNode
  title: string
  desc: string
  loading: boolean
  disabled: boolean
  onClick(): void
}) {
  return (
    <button
      type="button"
      className="group rounded-lg border border-line bg-panel p-2.5 text-left shadow-sm transition-colors hover:border-border-strong hover:bg-hover disabled:opacity-50"
      disabled={disabled}
      onClick={onClick}
      data-testid={testid}
    >
      <span className={`mb-1.5 grid size-7 place-items-center rounded-md ${chip}`}>
        {loading ? <Loader2 aria-hidden className="size-4 animate-spin" /> : icon}
      </span>
      <span className="block text-xs font-semibold leading-4 text-fg-strong">{title}</span>
      <span className="mt-1 block text-2xs leading-4 text-fg-muted">{desc}</span>
    </button>
  )
}

function InstructionBar({ busy, canEdit, mode, onMode, focusSignal, section, onSend }: {
  busy: boolean
  canEdit: boolean
  mode: 'custom' | 'writing'
  onMode(m: 'custom' | 'writing'): void
  focusSignal: number
  section: React.ReactNode
  onSend(text: string, mode: 'custom' | 'writing'): void
}) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [text, setText] = useState('')
  useEffect(() => {
    if (focusSignal > 0) inputRef.current?.focus()
  }, [focusSignal])
  const send = () => {
    const t = text.trim()
    if (!t || busy || !canEdit) return
    onSend(t, mode)
    setText('')
  }
  return (
    <div className="shrink-0 border-t border-line bg-panel p-2" data-testid="assistant-bottombar">
      <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
        <div className="inline-flex items-center gap-1">
          <button
            type="button"
            className={cn(
              'rounded-full border px-2 py-0.5 text-2xs transition-colors',
              mode === 'custom' ? 'border-primary/30 bg-primary-soft font-medium text-primary' : 'border-line text-fg-muted hover:bg-hover hover:text-fg',
            )}
            onClick={() => onMode('custom')}
            aria-pressed={mode === 'custom'}
            data-testid="assistant-mode-custom"
          >
            润色 / 修改指令
          </button>
          <button
            type="button"
            className={cn(
              'rounded-full border px-2 py-0.5 text-2xs transition-colors',
              mode === 'writing' ? 'border-primary/30 bg-primary-soft font-medium text-primary' : 'border-line text-fg-muted hover:bg-hover hover:text-fg',
            )}
            onClick={() => onMode('writing')}
            aria-pressed={mode === 'writing'}
            data-testid="assistant-mode-writing"
          >
            论文写作
          </button>
        </div>
        {section}
      </div>
      <div className="flex items-center gap-1.5 rounded-lg border border-line bg-app py-1 pl-2 pr-1 transition-colors focus-within:border-border-strong">
        <input
          ref={inputRef}
          className="h-6 min-w-0 flex-1 border-0 bg-transparent text-xs outline-none"
          placeholder={mode === 'writing'
            ? '想让 AI 写什么？（如：写一段引言的研究背景）'
            : '修改指令（如：把这段改成方法描述的语气）'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) send() }}
          data-testid="proposal-custom-input"
        />
        <button
          type="button"
          className="grid size-7 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary-hover active:bg-primary-active disabled:bg-sunken disabled:text-fg-disabled"
          disabled={busy || !canEdit || !text.trim()}
          onClick={send}
          aria-label={mode === 'writing' ? '生成' : '执行'}
          data-testid="proposal-custom-go"
        >
          {busy ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <ArrowUp aria-hidden className="size-4" />}
        </button>
      </div>
    </div>
  )
}

import { useCallback, useEffect, useState } from 'react'
import {
  PROPOSAL_ACTION_LABELS,
  assistantApi,
  paperProposalApi,
  type FixVerification,
  type PaperProposal,
  type ProposalAction,
} from '@/lib/api/paperProposals'
import type { AnchorLike, ApplyOutcome } from '../proposalApply'
import { type SelectionSnapshot, errText, payloadFor, sectionRangeOf, sha256Hex, truncate } from './anchorUtils'

export function useProposalActions({
  pid,
  activePath,
  reloadSignal,
  mode,
  getSelection,
  applyProposal,
  revertProposal,
  verifyFix,
}: {
  pid: string
  activePath: string | null
  reloadSignal: number
  mode: 'latex' | 'word'
  getSelection: () => SelectionSnapshot | null
  applyProposal: (anchor: AnchorLike, suggested: string) => ApplyOutcome | Promise<ApplyOutcome>
  revertProposal: (anchor: AnchorLike, appliedText: string) => ApplyOutcome | Promise<ApplyOutcome>
  verifyFix?: (proposalId: string) => Promise<FixVerification>
}) {
  const [proposals, setProposals] = useState<PaperProposal[] | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [protectedAck, setProtectedAck] = useState<Set<string>>(new Set())
  const [batchSel, setBatchSel] = useState<Set<string>>(new Set())
  const [activeTask, setActiveTask] = useState<string | null>(null)
  const [reading, setReading] = useState<{ answer: string; model: string } | null>(null)
  const [readingBusy, setReadingBusy] = useState(false)
  const [readingError, setReadingError] = useState('')
  const [verifyingId, setVerifyingId] = useState<string | null>(null)

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

  const generate = useCallback(
    async (action: ProposalAction, instruction?: string, useSection = false) => {
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
    },
    [getSelection, pid, activePath, refresh, mode],
  )

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

  const runVerify = useCallback(
    async (proposalId: string) => {
      if (!verifyFix) return
      setVerifyingId(proposalId)
      setNotice('已采纳，正在重编译验证修复…')
      setError('')
      try {
        const ver = await verifyFix(proposalId)
        setNotice(
          ver.resolved
            ? `修复已验证：重编译通过，目标编译错误已消失${ver.issue_resolved ? '；关联 Issue 已标记解决' : ''}`
            : '重编译仍报错——请到 Issues 页签查看当前编译错误，可继续修改后「再次验证」',
        )
        await refresh()
      } catch (e) {
        setError(`修复验证失败：${errText(e)}`)
      } finally {
        setVerifyingId(null)
      }
    },
    [verifyFix, refresh],
  )

  const doApply = useCallback(
    async (p: PaperProposal, suggestedOverride?: string) => {
      const suggested = suggestedOverride ?? p.suggested_text
      const flags = p.protection_flags ?? []
      if (flags.length && !suggestedOverride && !protectedAck.has(p.proposal_id)) {
        setNotice('该提案包含数值/引用等敏感改动——请先勾选确认')
        return
      }
      const outcome = await applyProposal(
        { original_text: p.anchor.original_text, context_before: p.anchor.context_before, context_after: p.anchor.context_after },
        suggested,
      )
      if (!outcome.ok) {
        const msg =
          outcome.reason === 'not_found'
            ? '原文已变化（找不到提案时的原文）——已标记为「原文已变化」'
            : outcome.reason === 'ambiguous'
              ? '原文出现多处且无法消歧——已阻止采纳（不自动猜位置）'
              : outcome.reason === 'file_mismatch'
                ? `该提案属于文件 ${p.anchor.file}，请先打开该文件再采纳`
                : outcome.reason === 'composing'
                  ? '输入法输入中，请稍候再试'
                  : outcome.reason === 'readonly'
                    ? '当前为只读模式，不能采纳'
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
      if (mode === 'latex' && p.error_context && verifyFix) {
        await runVerify(p.proposal_id)
      }
    },
    [applyProposal, pid, protectedAck, refresh, mode, verifyFix, runVerify],
  )

  const doUndo = useCallback(
    async (p: PaperProposal) => {
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
    },
    [revertProposal, pid, refresh],
  )

  const doReject = useCallback(
    async (p: PaperProposal) => {
      try {
        await paperProposalApi.setStatus(pid, p.proposal_id, 'rejected')
        await refresh()
      } catch (e) {
        setError(errText(e))
      }
    },
    [pid, refresh],
  )

  const doBatch = useCallback(
    async (pending: PaperProposal[]) => {
      if (!batchSel.size) return
      const chosen = pending.filter((p) => batchSel.has(p.proposal_id))
      let applied = 0
      const skipped: string[] = []
      for (const p of chosen) {
        if (p.protection_flags.length && !protectedAck.has(p.proposal_id)) {
          skipped.push(`${p.proposal_id}（含敏感改动未确认）`)
          continue
        }
        const outcome = await applyProposal(
          { original_text: p.anchor.original_text, context_before: p.anchor.context_before, context_after: p.anchor.context_after },
          p.suggested_text,
        )
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
    },
    [batchSel, protectedAck, applyProposal, pid, refresh],
  )

  return {
    proposals,
    error,
    setError,
    notice,
    busy,
    expanded,
    setExpanded,
    protectedAck,
    setProtectedAck,
    batchSel,
    setBatchSel,
    activeTask,
    reading,
    setReading,
    readingBusy,
    readingError,
    verifyingId,
    refresh,
    generate,
    runReading,
    runVerify,
    doApply,
    doUndo,
    doReject,
    doBatch,
  }
}

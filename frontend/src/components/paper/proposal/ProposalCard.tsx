import { useMemo, useState } from 'react'
import { CheckCircle2, ChevronDown, ChevronRight, FileWarning, Lock, Sparkles, X, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PROPOSAL_ACTION_LABELS, PROTECTION_LABELS, type PaperProposal } from '@/lib/api/paperProposals'
import { computeDiff } from '../proposalDiff'
import { truncate } from './anchorUtils'

const REFINE_CHIPS = ['更简洁', '更学术', '保留原术语'] as const

export function ProposalCard({
  p,
  expanded,
  onToggle,
  canEdit,
  busy = false,
  acked,
  onAck,
  batchChecked,
  onBatchCheck,
  showBatch,
  onLocate,
  onApply,
  onReject,
  onRefine,
  editing,
  onStartEdit,
  editedText,
  onEditedText,
  onCancelEdit,
  onApplyEdited,
}: {
  p: PaperProposal
  expanded: boolean
  onToggle(): void
  canEdit: boolean
  busy?: boolean
  acked: boolean
  onAck(): void
  batchChecked: boolean
  onBatchCheck(): void
  showBatch: boolean
  onLocate(): void
  onApply(): void
  onReject(): void
  onRefine?(instruction: string): void
  editing: boolean
  onStartEdit(): void
  editedText: string
  onEditedText(s: string): void
  onCancelEdit(): void
  onApplyEdited(): void
}) {
  const [refining, setRefining] = useState(false)
  const [refineText, setRefineText] = useState('')
  const parts = useMemo(() => computeDiff(p.anchor.original_text, p.suggested_text), [p.anchor.original_text, p.suggested_text])
  const hasProtection = (p.protection_flags ?? []).length > 0
  return (
    <li className="rounded-lg border border-line bg-panel text-xs shadow-sm transition-colors hover:border-border-strong" data-testid={`proposal-${p.proposal_id}`}>
      <div className="flex items-center gap-1.5 p-2">
        {showBatch && <input type="checkbox" className="shrink-0 accent-primary" checked={batchChecked} onChange={onBatchCheck} aria-label="加入批量" />}
        <button className="min-w-0 flex-1 text-left" onClick={onToggle}>
          <span className="block truncate font-medium text-fg-strong" title={p.anchor.original_text}>
            {truncate(p.anchor.original_text, 36)}
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-1 text-2xs text-fg-muted">
            <span className="rounded bg-sunken px-1 font-medium text-fg">{PROPOSAL_ACTION_LABELS[p.action]}</span>
            {p.parent_proposal_id && (
              <span className="rounded bg-primary-soft px-1 text-primary">微调迭代</span>
            )}
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
                <Button size="xs" disabled={!editedText.trim()} onClick={onApplyEdited} data-testid={`proposal-apply-edited-${p.proposal_id}`}>
                  按编辑后文本采纳
                </Button>
                <Button variant="ghost" size="xs" onClick={onCancelEdit}>
                  取消
                </Button>
              </div>
            </div>
          ) : (
            <div className="mt-2 space-y-1.5">
              <div className="flex flex-wrap items-center gap-1">
                <Button variant="ghost" size="xs" onClick={onLocate} data-testid={`proposal-locate-${p.proposal_id}`}>
                  定位原文
                </Button>
                {canEdit && (
                  <>
                    <Button size="xs" onClick={onApply} disabled={hasProtection && !acked} data-testid={`proposal-apply-${p.proposal_id}`}>
                      <CheckCircle2 aria-hidden className="size-3" /> 采纳
                    </Button>
                    <Button variant="outline" size="xs" onClick={onStartEdit} data-testid={`proposal-edit-${p.proposal_id}`}>
                      编辑建议后采纳
                    </Button>
                    {onRefine && (
                      <Button
                        variant="ghost"
                        size="xs"
                        disabled={busy}
                        onClick={() => setRefining((v) => !v)}
                        data-testid={`proposal-refine-${p.proposal_id}`}
                        title="基于当前建议继续微调，生成新版本供对比"
                      >
                        <Sparkles aria-hidden className="size-3" /> 微调
                      </Button>
                    )}
                    <Button variant="ghost" size="xs" className="ml-auto" onClick={onReject} data-testid={`proposal-reject-${p.proposal_id}`}>
                      <XCircle aria-hidden className="size-3" /> 拒绝
                    </Button>
                  </>
                )}
                {!canEdit && (
                  <span className="ml-auto inline-flex items-center gap-0.5 text-2xs text-fg-muted">
                    <X aria-hidden className="size-3" />
                    只读：不能采纳
                  </span>
                )}
              </div>
              {refining && canEdit && onRefine && (
                <div className="space-y-1 rounded-md border border-line bg-sunken p-1.5" data-testid={`proposal-refine-box-${p.proposal_id}`}>
                  <div className="flex flex-wrap items-center gap-1">
                    {REFINE_CHIPS.map((chip) => (
                      <button
                        key={chip}
                        type="button"
                        disabled={busy}
                        className="rounded border border-line bg-panel px-1.5 py-0.5 text-2xs text-fg-muted hover:border-border-strong hover:text-fg"
                        onClick={() => {
                          onRefine(chip)
                          setRefining(false)
                        }}
                      >
                        {chip}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-1">
                    <input
                      className="h-6 min-w-0 flex-1 rounded border border-line bg-panel px-1.5 text-2xs outline-none"
                      value={refineText}
                      onChange={(e) => setRefineText(e.target.value)}
                      placeholder="微调指令（如：再精简 20%）"
                      data-testid={`proposal-refine-input-${p.proposal_id}`}
                    />
                    <Button
                      size="xs"
                      disabled={busy || !refineText.trim()}
                      onClick={() => {
                        onRefine(refineText)
                        setRefineText('')
                        setRefining(false)
                      }}
                      data-testid={`proposal-refine-go-${p.proposal_id}`}
                    >
                      生成新版
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  )
}

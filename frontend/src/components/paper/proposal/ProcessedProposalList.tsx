import { Loader2, RotateCcw, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PROPOSAL_ACTION_LABELS, PROPOSAL_STATUS_LABELS, type PaperProposal } from '@/lib/api/paperProposals'
import { cn } from '@/lib/utils'
import { truncate } from './anchorUtils'

function StatusChip({ p }: { p: PaperProposal }) {
  const cls =
    p.status === 'applied'
      ? 'bg-ok/10 text-ok'
      : p.status === 'rejected'
        ? 'bg-sunken text-fg-muted'
        : p.status === 'stale'
          ? 'bg-warning/10 text-warning'
          : p.status === 'failed'
            ? 'bg-danger/10 text-danger'
            : 'bg-sunken text-fg-muted'
  return <span className={cn('rounded px-1 text-2xs', cls)}>{PROPOSAL_STATUS_LABELS[p.status]}</span>
}

export function ProcessedProposalList({
  processed,
  canEdit,
  mode,
  verifyingId,
  hasVerifyFix,
  onUndo,
  onVerify,
}: {
  processed: PaperProposal[]
  canEdit: boolean
  mode: 'latex' | 'word'
  verifyingId: string | null
  hasVerifyFix: boolean
  onUndo: (p: PaperProposal) => void
  onVerify: (proposalId: string) => void
}) {
  if (processed.length === 0) return null
  return (
    <details className="mt-2" data-testid="proposal-processed">
      <summary className="cursor-pointer text-xs text-fg-muted">已处理记录（{processed.length}）</summary>
      <ul className="mt-1 space-y-1">
        {processed.map((p) => (
          <li key={p.proposal_id} className="rounded-md border border-line bg-panel p-1.5 text-xs">
            <div className="flex items-center gap-1.5">
              <StatusChip p={p} />
              <span className="truncate text-fg-muted" title={p.anchor.original_text}>
                {truncate(p.anchor.original_text)}
              </span>
              {p.status === 'applied' && canEdit && (
                <Button variant="ghost" size="xs" className="ml-auto h-5 px-1" onClick={() => onUndo(p)} data-testid={`proposal-undo-${p.proposal_id}`}>
                  <Undo2 aria-hidden className="size-3" /> 撤销
                </Button>
              )}
            </div>
            {p.status === 'failed' && p.error && <div className="mt-0.5 text-danger">{p.error}</div>}
            <div className="mt-0.5 text-2xs text-fg-muted">
              {new Date(p.created_at * 1000).toLocaleString()} · {PROPOSAL_ACTION_LABELS[p.action]} · {p.model || '—'}
              {p.applied_at && ` · 采纳于 ${new Date(p.applied_at * 1000).toLocaleTimeString()}`}
            </div>
            {mode === 'latex' && p.status === 'applied' && p.error_context && (
              <div className="mt-1 border-t border-line pt-1" data-testid={`proposal-verify-${p.proposal_id}`}>
                <div className="flex items-center gap-1.5">
                  <span className="text-2xs font-medium text-fg-muted">修复验证</span>
                  {(p.verifications ?? []).slice(-1).map((v, i) => (
                    <span key={i} className={cn('rounded px-1 text-2xs', v.resolved ? 'bg-ok/10 text-ok' : 'bg-warning/10 text-warning')}>
                      {v.resolved ? '✓ 错误已消失' : '⚠ 仍报错'}
                    </span>
                  ))}
                  {(p.verifications?.length ?? 0) > 1 && (
                    <span className="text-2xs text-fg-muted">共 {p.verifications!.length} 次</span>
                  )}
                  {hasVerifyFix && canEdit && (
                    <Button
                      variant="ghost"
                      size="xs"
                      className="ml-auto h-5 px-1"
                      disabled={verifyingId === p.proposal_id}
                      onClick={() => onVerify(p.proposal_id)}
                      data-testid={`proposal-reverify-${p.proposal_id}`}
                    >
                      {verifyingId === p.proposal_id ? <Loader2 aria-hidden className="size-3 animate-spin" /> : <RotateCcw aria-hidden className="size-3" />}
                      再次验证
                    </Button>
                  )}
                </div>
                {(p.verifications ?? []).slice(-3).map((v, i) => (
                  <div key={i} className="mt-0.5 text-2xs text-fg-muted">
                    {new Date(v.at * 1000).toLocaleTimeString()} · {v.resolved ? '编译通过，目标错误消失' : '编译仍失败'} · 构建{' '}
                    {v.build_id.slice(-6)}
                    {v.issue_resolved && ' · Issue 已解决'}
                  </div>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </details>
  )
}

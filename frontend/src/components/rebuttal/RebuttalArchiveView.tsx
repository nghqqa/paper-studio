import type { RebuttalRoundDetail, RebuttalStatus } from '@/lib/api/rebuttal'
import { cn } from '@/lib/utils'

export function StatusBadge({ status }: { status: RebuttalStatus }) {
  if (status === 'addressed') return <span className="rounded bg-ok/10 px-1.5 py-0.5 text-2xs text-ok">已修改</span>
  if (status === 'drafted') return <span className="rounded bg-primary-soft px-1.5 py-0.5 text-2xs text-primary">草稿</span>
  return <span className="rounded bg-sunken px-1.5 py-0.5 text-2xs text-fg-muted">待处理</span>
}

export function RebuttalPill({
  active,
  onClick,
  children,
  testid,
  title,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
  testid?: string
  title?: string
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      title={title}
      data-testid={testid}
      className={cn(
        'rounded-full px-2 py-0.5 text-2xs transition-colors',
        active ? 'bg-primary-soft font-medium text-primary' : 'text-fg-muted hover:bg-hover hover:text-fg',
      )}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

export function RebuttalArchiveView({ roundDetail }: { roundDetail: RebuttalRoundDetail }) {
  return (
    <div className="space-y-2" data-testid="rebuttal-round-readonly">
      <p className="text-2xs text-fg-muted">第 {roundDetail.round} 轮归档（只读；不提供恢复到当前）</p>
      {roundDetail.items.map((it) => (
        <div key={it.id} className="rounded-md border border-line p-2">
          <div className="flex items-center gap-1">
            <span className="font-mono text-2xs text-fg-muted">{it.id}</span>
            <span className="text-2xs text-fg-muted">{it.reviewer}</span>
            <StatusBadge status={it.status} />
          </div>
          <p className="mt-1 whitespace-pre-wrap leading-5">{it.text}</p>
          {it.response && <p className="mt-1 whitespace-pre-wrap rounded bg-sunken p-1.5 leading-5">{it.response}</p>}
          {it.edits_summary && <p className="mt-1 text-2xs text-fg-muted">Changes: {it.edits_summary}</p>}
          {(it.comment_ids?.length || it.snapshot) && (
            <p className="mt-1 text-2xs text-fg-muted">
              锚点：{it.comment_ids?.length ? `批注 ${it.comment_ids.length} 条` : ''}
              {it.comment_ids?.length && it.snapshot ? '；' : ''}
              {it.snapshot ? `快照 ${it.snapshot.type} ${it.snapshot.vid || it.snapshot.sha.slice(0, 12)}` : ''}
            </p>
          )}
        </div>
      ))}
    </div>
  )
}

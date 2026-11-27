import type { PresencePeer } from '@/lib/api/presence'

export function PresenceAvatars({
  peers,
  selfClientId,
}: {
  peers: PresencePeer[]
  selfClientId?: string
}) {
  if (!peers.length) return null
  const shown = peers.slice(0, 4)
  const extra = peers.length - shown.length

  return (
    <div
      className="flex items-center -space-x-1.5"
      aria-label="当前在线协作者"
      data-testid="presence-avatars"
    >
      {shown.map((p) => {
        const isSelf = Boolean(selfClientId && p.client_id === selfClientId)
        const initial = (p.name || '?').trim().slice(0, 1).toUpperCase()
        const tip = [
          p.name + (isSelf ? '（我）' : ''),
          p.file ? `${p.file}${p.line ? `:${p.line}` : ''}` : null,
        ]
          .filter(Boolean)
          .join(' · ')
        return (
          <span
            key={p.client_id}
            title={tip}
            data-testid={`presence-peer-${p.client_id}`}
            className={
              isSelf
                ? 'inline-flex size-6 items-center justify-center rounded-full border border-primary/50 bg-primary/15 text-2xs font-semibold text-primary'
                : 'inline-flex size-6 items-center justify-center rounded-full border border-border bg-sunken text-2xs font-medium text-fg-strong'
            }
          >
            {initial}
          </span>
        )
      })}
      {extra > 0 && (
        <span
          className="inline-flex size-6 items-center justify-center rounded-full border border-border bg-panel text-2xs text-fg-muted"
          title={`另有 ${extra} 位协作者在线`}
        >
          +{extra}
        </span>
      )}
    </div>
  )
}

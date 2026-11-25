import { AlertTriangle, CheckCircle2, CircleAlert, ShieldAlert, ShieldCheck } from 'lucide-react'
import type { CitationVerifyItem, LibraryEntry } from '@/lib/api/library'

export function FactCheckBadge({ item }: { item?: CitationVerifyItem }) {
  if (!item) return null
  if (item.status === 'verified') {
    return (
      <span
        className="inline-flex items-center gap-0.5 rounded bg-ok/10 px-1 text-ok"
        title={item.reason}
        data-testid={`factcheck-badge-${item.citation_key}`}
      >
        <ShieldCheck aria-hidden className="size-3" /> 源已核验
      </span>
    )
  }
  if (item.status === 'retracted') {
    return (
      <span
        className="inline-flex items-center gap-0.5 rounded bg-danger/10 px-1 text-danger"
        title={item.reason}
        data-testid={`factcheck-badge-${item.citation_key}`}
      >
        <ShieldAlert aria-hidden className="size-3" /> 权威源撤稿
      </span>
    )
  }
  if (item.status === 'mismatch') {
    const detail = item.diffs.map((d) => `${d.field}: ${d.local} → ${d.remote}`).join('; ')
    return (
      <span
        className="inline-flex items-center gap-0.5 rounded bg-warning/15 px-1 text-warning"
        title={`${item.reason}${detail ? ` (${detail})` : ''}`}
        data-testid={`factcheck-badge-${item.citation_key}`}
      >
        <AlertTriangle aria-hidden className="size-3" /> 字段偏差
      </span>
    )
  }
  if (item.status === 'unverified') {
    return (
      <span
        className="inline-flex items-center gap-0.5 rounded bg-danger/10 px-1 text-danger"
        title={item.reason}
        data-testid={`factcheck-badge-${item.citation_key}`}
      >
        <CircleAlert aria-hidden className="size-3" /> 未检出
      </span>
    )
  }
  return (
    <span
      className="inline-flex items-center gap-0.5 rounded bg-sunken px-1 text-fg-muted"
      title={item.reason}
      data-testid={`factcheck-badge-${item.citation_key}`}
    >
      核验异常
    </span>
  )
}

export function VerifiedBadge({ entry, factCheck }: { entry: LibraryEntry; factCheck?: CitationVerifyItem }) {
  if (entry.retraction?.status === 'retracted') {
    return (
      <span className="inline-flex items-center gap-0.5 rounded bg-danger/10 px-1 text-danger" title="来源记录显示已撤稿">
        <ShieldAlert aria-hidden className="size-3" /> 已撤稿
      </span>
    )
  }
  if (entry.verified === 'verified') {
    return (
      <span className="inline-flex items-center gap-0.5 text-ok" title="字段已人工确认">
        <CheckCircle2 aria-hidden className="size-3" />
      </span>
    )
  }
  if (factCheck?.status === 'verified') return null
  return (
    <span className="text-fg-muted" title="未验证：仅表示尚未经外部来源/人工确认，不代表文献不存在">
      未验证
    </span>
  )
}

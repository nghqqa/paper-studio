import { useCallback, useEffect, useState, type ClipboardEvent, type CSSProperties } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Download,
  FileCheck2,
  FileText,
  Link2Off,
  MessageSquarePlus,
  MessageSquareText,
  RefreshCw,
} from 'lucide-react'
import { Toasts } from '@/components/shell/Toasts'
import { Button } from '@/components/ui/button'
import { Count } from '@/components/ui/count'
import { Countdown } from '@/components/ui/countdown'
import { EmptyState, NOT_IMPLEMENTED_TITLE } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { StatusDot } from '@/components/ui/status-dot'
import { useIsDesktop } from '@/hooks/useMisc'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { pageTitle } from '@/lib/brand'
import { fmtDateTime } from '@/lib/format'
import { useStudio } from '@/store'
import type { PublicShareMeta } from '@/types/public-share'
import type { PublicAnchor } from './anchor'
import { ClientPdfView } from './ClientPdfView'
import { CommentSheet } from './CommentSheet'
import { CommentThreads } from './CommentThreads'
import { ConfirmDialog } from './ConfirmDialog'

const DAY = 86400

function daysLeft(expiresAt: number | null): number | null {
  if (!expiresAt) return null
  return Math.ceil((expiresAt - Date.now() / 1000) / DAY)
}

function fmtDate(sec: number): string {
  return fmtDateTime(sec).slice(0, 10)
}

const XML_ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
}
const escapeXml = (s: string) => s.replace(/[&<>"']/g, (c) => XML_ESC[c])

const watermarkText = (meta: PublicShareMeta) => `审阅版 · ${meta.org_name} · v${meta.version} · 仅供确认，请勿外传`

function watermarkMask(text: string): string {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="420" height="240" viewBox="0 0 420 240">' +
    '<text x="210" y="120" text-anchor="middle" dominant-baseline="middle" font-family="system-ui, sans-serif" font-size="12" fill="currentColor" transform="rotate(-30 210 120)">' +
    escapeXml(text) +
    '</text></svg>'
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
}

function permissionText(meta: PublicShareMeta): string {
  const parts = [meta.scope === 'read' ? '仅阅读' : meta.allow_comment ? '可批注' : '不可批注']
  if (meta.allow_download) parts.push('可下载')
  if (!meta.allow_copy) parts.push('禁复制')
  if (meta.scope === 'confirm') parts.push('需确认定稿')
  return parts.join(' · ')
}

/** `#/c/<token>` 免登录公开论文审阅页（纯 PDF 审阅 + 页级批注 + 确认定稿） */
export function ClientReviewPage({ token }: { token: string }) {
  const desktop = useIsDesktop()
  const meta = useStudio((s) => s.publicMeta)
  const comments = useStudio((s) => s.publicComments)
  const loading = useStudio((s) => s.publicLoading)
  const expired = useStudio((s) => s.publicExpired)
  const invalid = useStudio((s) => s.publicInvalid)
  const unavailable = useStudio((s) => s.publicUnavailable)
  const error = useStudio((s) => s.publicError)
  const guestName = useStudio((s) => s.guestName)
  const toast = useStudio((s) => s.toast)
  const st = useStudio.getState

  const [composer, setComposer] = useState<{ open: boolean; anchor: PublicAnchor | null }>({ open: false, anchor: null })
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [page, setPage] = useState<{ current: number; total: number }>({ current: 1, total: 0 })
  const onPage = useCallback((current: number, total: number) => setPage({ current, total }), [])

  useEffect(() => {
    void st().openPublic(token)
    return () => st().resetPublic()
  }, [token, st])

  useEffect(() => {
    document.title = meta ? `${meta.title} · 论文审阅` : pageTitle('论文审阅')
  }, [meta])

  const openComposer = (anchor: PublicAnchor | null) => {
    setComposer({ open: true, anchor })
  }

  const allowCopy = meta?.allow_copy ?? true
  const onCopy = (e: ClipboardEvent) => {
    if (allowCopy) return
    e.preventDefault()
    toast('此链接不允许复制内容', 'info')
  }

  const pdfUrl = api.publicPdfUrl(token)
  const canComment = meta != null && meta.scope !== 'read' && meta.allow_comment
  const canConfirm = meta?.scope === 'confirm'
  const confirmedThis = meta?.confirmation != null && meta.confirmation.version === meta.version
  const left = daysLeft(meta?.expires_at ?? null)
  const openCount = comments.filter((c) => !c.resolved).length
  const owner = '项目所有者'
  const ready = meta != null && !expired && !invalid

  const pageAnchor = useCallback((): PublicAnchor => {
    const n = Math.max(1, page.current || 1)
    return { block_id: `pdf:page-${n}`, line: n, quote: `第 ${n} 页` }
  }, [page.current])

  const watermark = meta && (
    <div
      role="presentation"
      data-testid="client-watermark"
      data-text={watermarkText(meta)}
      className="pointer-events-none absolute inset-0 z-base bg-fg-subtle/40 [-webkit-mask-image:var(--client-watermark)] [mask-image:var(--client-watermark)] [print-color-adjust:exact]"
      style={{ '--client-watermark': watermarkMask(watermarkText(meta)) } as CSSProperties}
    />
  )

  return (
    <div data-slot="page" data-testid="page-client" className="grid h-dvh grid-cols-[minmax(0,1fr)] grid-rows-[auto_1fr_auto] bg-app text-fg" onCopy={onCopy} onCut={onCopy}>
      <span hidden data-testid="client-token">{token}</span>

      <header className="flex h-mobile-topbar shrink-0 items-center gap-group-m border-b border-border bg-app px-page-m md:h-14 md:gap-3 md:px-4" data-testid="client-header">
        <span aria-hidden className="inline-flex size-7 shrink-0 items-center justify-center rounded-sm bg-primary text-primary-foreground md:size-8 md:rounded-md">
          <FileCheck2 className="size-4" strokeWidth={2.2} />
        </span>
        {meta ? (
          <div className="flex min-w-0 flex-1 flex-col">
            <h1 className="truncate text-sm font-semibold text-fg-strong md:text-base" data-testid="client-title" title={meta.title}>{meta.title}</h1>
            <p className="flex min-w-0 items-center gap-1 truncate text-xs text-fg-muted" title={[meta.case_no, meta.org_name, `审阅版 v${meta.version}`].filter(Boolean).join(' · ')}>
              {meta.case_no && (
                <>
                  <span className="font-mono tabular-nums">{meta.case_no}</span>
                  <span aria-hidden>·</span>
                </>
              )}
              <span data-testid="client-org">{meta.org_name}</span>
              <span aria-hidden>·</span>
              <span>
                审阅版 <span className="tabular-nums" data-testid="client-version">v{meta.version}</span>
              </span>
            </p>
          </div>
        ) : (
          <h1 className="flex-1 text-sm font-semibold text-fg-strong">论文审阅</h1>
        )}
        {ready && meta.allow_download && (
          <Button asChild variant="ghost" size={desktop ? 'md' : 'icon-md'} aria-label="下载 PDF" title="下载 PDF" data-testid="client-download">
            <a href={pdfUrl} download>
              <Download aria-hidden />
              {desktop && '下载 PDF'}
            </a>
          </Button>
        )}
        {ready && !desktop && canComment && (
          <Button variant="ghost" size="icon-md" aria-label={`批注 ${comments.length} 条`} title={`批注 ${comments.length} 条`} onClick={() => openComposer(pageAnchor())} data-testid="client-comments-toggle" className="relative">
            <MessageSquareText aria-hidden />
            <Count value={comments.length} tone="brand" className="absolute top-0 right-0" />
          </Button>
        )}
      </header>

      {ready ? (
        <>
          <div className="grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_var(--w-companion)]">
            <main aria-label="文稿" className="flex min-h-0 min-w-0 flex-col">
              <div
                className={cn(
                  'flex shrink-0 items-center whitespace-nowrap bg-app text-xs text-fg-muted',
                  desktop ? 'h-pdftb gap-2 border-b border-border px-3' : 'min-h-xs-control gap-card-m px-page-m pb-3',
                )}
                data-testid="client-doctb"
              >
                {page.total > 0 ? (
                  <span className="tabular-nums">
                    第 {page.current} / {page.total} 页
                  </span>
                ) : (
                  <span>PDF</span>
                )}
                <span className="flex-1" />
                {!desktop && meta.expires_at && (
                  <span className={cn('inline-flex items-center gap-inline-m tabular-nums', left != null && left <= 3 ? 'text-danger-fg' : 'text-fg-muted')} data-testid="client-deadline">
                    <Clock className="size-3.5" aria-hidden />
                    {fmtDate(meta.expires_at)} 前{canConfirm ? '确认' : '查看'}
                  </span>
                )}
                {!desktop && (
                  <span className="inline-flex items-center gap-inline-m tabular-nums">
                    <MessageSquareText className="size-3.5" aria-hidden />
                    批注 {comments.length}
                  </span>
                )}
              </div>

              <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-paper-canvas" data-testid="client-main" data-view="pdf">
                <div className="mx-auto h-full w-full max-w-page">
                  {!meta.pdf_ready ? (
                    <div className="flex h-full items-center justify-center bg-paper-canvas p-page-m" data-testid="client-pdf-pending-paper">
                      <EmptyState icon={FileText} title="PDF 尚未生成" reason="作者尚未编译或导出当前版本 PDF，请联系项目所有者生成后再试。" />
                    </div>
                  ) : (
                    <ClientPdfView url={pdfUrl} ready={meta.pdf_ready} onPage={onPage} />
                  )}
                </div>
                {watermark}
              </div>
            </main>

            <aside aria-label="批注" className="hidden min-h-0 flex-col border-l border-border bg-panel lg:flex" data-testid="client-side">
              <div className="flex h-row shrink-0 items-center gap-2 border-b border-border px-4 text-sm font-medium text-fg-strong">
                <MessageSquareText className="size-4 text-fg-icon" aria-hidden />
                批注
                <span className="text-xs font-normal text-fg-muted tabular-nums">{comments.length} 条 · {openCount} 待处理</span>
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-b border-border px-4 py-3 text-xs" data-testid="client-side-meta">
                <dt className="text-fg-subtle">状态</dt>
                <dd className="text-fg">
                  <StatusDot status={meta.status} size="sm" />
                </dd>
                <dt className="text-fg-subtle">截止</dt>
                <dd className="text-fg">
                  {meta.expires_at ? (
                    <Countdown daysLeft={left} size="md" date={`${fmtDate(meta.expires_at)} 前${canConfirm ? '确认定稿' : '查看'}`} className="[&>[data-slot=countdown-value]]:text-sm" />
                  ) : (
                    '长期有效'
                  )}
                </dd>
                <dt className="text-fg-subtle">权限</dt>
                <dd className="text-fg">{permissionText(meta)}</dd>
              </dl>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <CommentThreads comments={comments} canComment={canComment} />
              </div>
            </aside>
          </div>

          <footer aria-label="确认操作" className="z-sticky shrink-0 border-t border-border bg-panel pb-[env(safe-area-inset-bottom)]" data-testid="client-actionbar">
            <div className="flex h-action-bar items-center gap-group-m px-page-m md:gap-3 md:px-4">
              {confirmedThis && meta.confirmation ? (
                <p className="flex min-w-0 flex-1 items-center gap-2 text-sm text-fg" data-testid="client-confirmed">
                  <CheckCircle2 className="size-4 shrink-0 text-ok-dot" aria-hidden />
                  <span className="flex min-w-0 flex-col md:flex-row md:items-baseline md:gap-1">
                    <span className="truncate font-medium text-fg-strong" title={meta.confirmation.name}>{meta.confirmation.name}</span>
                    <span className="truncate text-xs text-fg-muted md:text-sm md:text-fg">
                      已于 {fmtDateTime(meta.confirmation.confirmed_at)} 确认 v{meta.confirmation.version}
                    </span>
                  </span>
                </p>
              ) : meta.scope === 'read' ? (
                <p className="flex-1 text-sm text-fg-muted" data-testid="client-readonly-hint">此链接仅供阅读；如有意见请直接联系{owner}。</p>
              ) : meta.confirmation ? (
                <p className="hidden min-w-0 flex-1 truncate text-xs text-fg-muted md:block" data-testid="client-confirmed-old">
                  v{meta.confirmation.version} 已于 {fmtDateTime(meta.confirmation.confirmed_at)} 确认，本版 v{meta.version} 有更新
                </p>
              ) : (
                <p className="hidden min-w-0 flex-1 truncate text-xs text-fg-muted md:block">
                  {!desktop && openCount > 0 ? `${openCount} 条批注待${owner}处理 · ` : ''}
                  {canConfirm ? `确认定稿后${owner}将进入投稿流程；仍可继续批注。` : `意见会实时同步给${owner}。`}
                </p>
              )}
              {canComment && (
                <Button
                  variant={!desktop && !(canConfirm && !confirmedThis) ? 'default' : 'secondary'}
                  size="lg"
                  className={cn(!desktop && (confirmedThis ? 'shrink-0' : 'flex-1'))}
                  onClick={() => openComposer(pageAnchor())}
                  data-testid="client-comment"
                >
                  <MessageSquarePlus aria-hidden />
                  有意见
                  {!desktop && comments.length > 0 && <span className="tabular-nums">({comments.length})</span>}
                </Button>
              )}
              {canConfirm && !confirmedThis && (
                <Button size="lg" className={cn('md:min-w-40', !desktop && 'flex-1')} onClick={() => setConfirmOpen(true)} data-testid="client-confirm">
                  <CheckCircle2 aria-hidden />
                  确认定稿
                </Button>
              )}
            </div>
          </footer>

          <CommentSheet
            open={composer.open}
            onOpenChange={(open) => setComposer((c) => ({ ...c, open }))}
            anchor={composer.anchor}
            comments={comments}
            guestName={guestName}
            ownerLabel={owner}
            onGuestName={(n) => st().setGuestName(n)}
            onSubmit={async (body) => {
              const anchor = composer.anchor ?? pageAnchor()
              const ok = await st().addPublicComment({ anchor, body })
              if (ok) toast(`意见已发送给${owner}`, 'success')
              return ok
            }}
          />
          <ConfirmDialog
            open={confirmOpen}
            onOpenChange={setConfirmOpen}
            version={meta.version}
            guestName={guestName}
            ownerLabel={owner}
            isPaper
            onGuestName={(n) => st().setGuestName(n)}
            onConfirm={async (note) => {
              const ok = await st().confirmPublic(note)
              if (ok) toast(`已确认定稿 v${meta.version}`, 'success')
              return ok
            }}
          />
        </>
      ) : (
        <main className="row-span-2 flex min-h-0 items-start justify-center overflow-y-auto bg-paper-canvas p-4" data-testid="client-main">
          {loading || (!error && !meta) ? (
            <div className="flex w-full max-w-sm flex-col gap-4 pt-6" data-testid="client-loading" role="status" aria-label="正在打开审阅链接">
              <Skeleton className="h-8 w-40 self-center" />
              <Skeleton className="aspect-[210/297] w-full bg-paper shadow-paper" />
            </div>
          ) : expired ? (
            <EmptyState icon={Clock} title={`链接已过期，请联系${owner}`} reason={`审阅链接已过期或已被撤销；如需继续查看，请让${owner}重新发送链接。`} className="pt-10" data-testid="client-expired" />
          ) : invalid ? (
            <EmptyState icon={Link2Off} title="链接失效" reason={`这个审阅链接不存在或已被删除；请核对链接是否完整，或让${owner}重新发送。`} className="pt-10" data-testid="client-invalid" />
          ) : unavailable ? (
            <EmptyState icon={FileCheck2} title={NOT_IMPLEMENTED_TITLE} reason={`公开审阅链接尚未在此部署开放，请联系${owner}获取文件。`} className="pt-10" data-testid="client-unavailable" />
          ) : (
            <EmptyState
              icon={AlertTriangle}
              title="无法打开审阅链接"
              reason={error ?? `请检查链接是否完整，或联系${owner}。`}
              className="pt-10"
              data-testid="client-error"
              action={
                <Button variant="secondary" size={desktop ? 'md' : 'xl'} onClick={() => void st().openPublic(token)} data-testid="client-retry">
                  <RefreshCw aria-hidden />
                  重试
                </Button>
              }
            />
          )}
        </main>
      )}
      <Toasts />
    </div>
  )
}

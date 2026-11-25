import { useCallback, useEffect, useState } from 'react'
import { AtSign, Bell, Check, CheckCircle2, MessageSquare, UserPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type AppNotification,
} from '@/lib/api/notifications'
import { fmtRelativeWords } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useStudio } from '@/store'

function kindIcon(kind: AppNotification['kind']) {
  if (kind === 'invite') return <UserPlus className="size-3.5 text-primary" aria-hidden />
  if (kind === 'mention') return <AtSign className="size-3.5 text-warn-fg" aria-hidden />
  if (kind === 'confirm') return <CheckCircle2 className="size-3.5 text-ok-fg" aria-hidden />
  return <MessageSquare className="size-3.5 text-info-fg" aria-hidden />
}

/**
 * 顶栏站内通知铃铛（仅 auth=on 已登录态展示）：
 * 提醒项目邀请、批注 @提及、新批注及外部审阅定稿确认。
 */
export function NotificationBell({ className }: { className?: string }) {
  const status = useStudio((s) => s.authStatus)
  const user = useStudio((s) => s.user)
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<AppNotification[]>([])
  const [unread, setUnread] = useState(0)
  const [loading, setLoading] = useState(false)

  const authed = status === 'authed' && !!user

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!authed) return
    setLoading(true)
    try {
      const data = await listNotifications(20, signal)
      setItems(Array.isArray(data.items) ? data.items : [])
      setUnread(typeof data.unread_count === 'number' ? data.unread_count : 0)
    } catch {
      /* 静默兜底：网络波动或单测未 mock /api/notifications 时不阻断顶栏 */
    } finally {
      setLoading(false)
    }
  }, [authed])

  useEffect(() => {
    if (!authed) {
      setItems([])
      setUnread(0)
      return
    }
    const ctrl = new AbortController()
    void refresh(ctrl.signal)
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, 60_000)
    return () => {
      ctrl.abort()
      window.clearInterval(timer)
    }
  }, [authed, refresh])

  if (!authed) return null

  const onOpenChange = (next: boolean) => {
    setOpen(next)
    if (next) void refresh()
  }

  const onPickItem = async (item: AppNotification) => {
    if (!item.read_at) {
      setItems((prev) => prev.map((x) => (x.id === item.id ? { ...x, read_at: new Date().toISOString() } : x)))
      setUnread((c) => Math.max(0, c - 1))
      try {
        const res = await markNotificationRead(item.id)
        setUnread(res.unread_count)
      } catch {
        /* ignore */
      }
    }
    setOpen(false)
    if (item.href) window.location.hash = item.href.replace(/^#/, '')
  }

  const onReadAll = async () => {
    setItems((prev) => prev.map((x) => (x.read_at ? x : { ...x, read_at: new Date().toISOString() })))
    setUnread(0)
    try {
      await markAllNotificationsRead()
    } catch {
      /* ignore */
    }
  }

  const badgeLabel = unread > 99 ? '99+' : String(unread)

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger>
        <Button
          type="button"
          variant="ghost"
          size="icon-md"
          className={cn('relative shrink-0 in-data-[density=touch]:size-touch', className)}
          aria-label={unread > 0 ? `通知（${unread} 条未读）` : '通知'}
          data-testid="notification-bell"
        >
          <Bell className="size-4" aria-hidden />
          {unread > 0 && (
            <span
              aria-hidden
              data-testid="notification-badge"
              className="absolute -top-0.5 -right-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-danger-solid px-1 text-2xs font-medium tabular-nums text-danger-solid-fg"
            >
              {badgeLabel}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" aria-label="站内通知" className="w-80 p-0" data-testid="notification-popover">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-xs font-semibold text-fg-strong">站内通知</span>
          <button
            type="button"
            disabled={unread === 0}
            onClick={() => void onReadAll()}
            data-testid="notifications-read-all"
            className="inline-flex items-center gap-1 text-xs text-link hover:underline disabled:cursor-default disabled:text-fg-muted disabled:no-underline"
          >
            <Check className="size-3" aria-hidden />
            全部已读
          </button>
        </div>

        <div className="max-h-80 overflow-y-auto divide-y divide-border" data-testid="notification-list">
          {loading && items.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-fg-muted">加载中…</p>
          ) : items.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-fg-muted" data-testid="notification-empty">
              暂无通知
            </p>
          ) : (
            items.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => void onPickItem(item)}
                data-testid={`notification-item-${item.id}`}
                data-unread={item.read_at ? 'false' : 'true'}
                className={cn(
                  'flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-hover',
                  !item.read_at && 'bg-primary-soft/40',
                )}
              >
                <span className="mt-0.5 shrink-0">{kindIcon(item.kind)}</span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    {!item.read_at && <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden />}
                    <span className={cn('truncate text-xs text-fg-strong', !item.read_at && 'font-semibold')}>
                      {item.title}
                    </span>
                  </span>
                  {item.body && <span className="mt-0.5 line-clamp-2 block text-2xs text-fg-muted">{item.body}</span>}
                  {item.created_at > 0 && (
                    <span className="mt-1 block text-2xs text-fg-muted">{fmtRelativeWords(item.created_at * 1000)}</span>
                  )}
                </span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

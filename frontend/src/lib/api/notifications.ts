export type NotificationKind = 'invite' | 'mention' | 'comment' | 'confirm' | (string & {})

export interface AppNotification {
  id: string
  kind: NotificationKind
  title: string
  body: string
  href: string | null
  project_id: string | null
  read_at: string | null
  created_at: number
}

export interface NotificationsResponse {
  items: AppNotification[]
  unread_count: number
}

export async function listNotifications(limit = 20, signal?: AbortSignal): Promise<NotificationsResponse> {
  const res = await fetch(`/api/notifications?limit=${limit}`, { credentials: 'same-origin', signal })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as NotificationsResponse
}

export async function markNotificationRead(id: string): Promise<{ ok: boolean; unread_count: number }> {
  const res = await fetch(`/api/notifications/${encodeURIComponent(id)}/read`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as { ok: boolean; unread_count: number }
}

export async function markAllNotificationsRead(): Promise<{ ok: boolean; updated: number; unread_count: number }> {
  const res = await fetch('/api/notifications/read-all', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as { ok: boolean; updated: number; unread_count: number }
}

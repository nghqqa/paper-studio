import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, Circle, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { commentsApi } from '@/lib/api/comments'
import type { Comment } from '@/lib/types'
import { cn } from '@/lib/utils'

export function WordCommentsPanel({ pid, canEdit }: { pid: string; canEdit: boolean }) {
  const [comments, setComments] = useState<Comment[] | null>(null)
  const [status, setStatus] = useState<'open' | 'resolved' | 'all'>('open')
  const [error, setError] = useState('')
  const [replyFor, setReplyFor] = useState<string | null>(null)
  const [replyBody, setReplyBody] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const all = await commentsApi.comments(pid)
      setComments(all)
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [pid])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const visible = (comments ?? []).filter((c) => {
    if (status === 'open' && c.resolved) return false
    if (status === 'resolved' && !c.resolved) return false
    return true
  })

  const reply = useCallback(
    async (cid: string) => {
      if (!replyBody.trim()) return
      setBusy(true)
      setError('')
      try {
        await commentsApi.replyComment(pid, cid, replyBody.trim())
        setReplyBody('')
        setReplyFor(null)
        await refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    },
    [pid, refresh, replyBody],
  )

  const setResolved = useCallback(
    async (cid: string, resolved: boolean) => {
      setBusy(true)
      setError('')
      try {
        await commentsApi.resolveComment(pid, cid, resolved)
        await refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    },
    [pid, refresh],
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="word-comments-panel">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5 text-xs">
        <div className="flex overflow-hidden rounded border border-border">
          {(['open', 'resolved', 'all'] as const).map((o) => (
            <button
              key={o}
              type="button"
              className={cn('px-1.5 py-0.5', status === o ? 'bg-sunken text-fg-strong' : 'text-fg-muted hover:bg-hover')}
              onClick={() => setStatus(o)}
              data-testid={`word-comments-seg-${o}`}
            >
              {o === 'open' ? '未解决' : o === 'resolved' ? '已解决' : '全部'}
            </button>
          ))}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-6 px-1.5"
          onClick={() => void refresh()}
          data-testid="word-comments-refresh"
          title="刷新批注"
        >
          <RotateCw aria-hidden className="size-3" />
        </Button>
      </div>
      <p className="shrink-0 border-b border-border px-2 py-1 text-2xs text-fg-muted">
        查看来自公开审阅链接的页级批注；Word 正文内批注可直接在编辑器左侧审阅栏查看。
      </p>
      {error && (
        <div role="alert" className="shrink-0 border-b border-border px-2 py-1 text-xs text-danger-fg" data-testid="word-comments-error">
          {error}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-2" data-testid="word-comment-list">
        {comments === null ? (
          <div className="px-1 text-xs text-fg-muted">正在加载批注…</div>
        ) : visible.length === 0 ? (
          <div className="px-1 text-xs text-fg-muted">暂无平台批注</div>
        ) : (
          <ul className="space-y-2">
            {visible.map((c) => (
              <li key={c.id} className="rounded border border-border bg-panel p-2 text-xs" data-testid={`word-comment-${c.id}`}>
                <div className="mb-1 flex items-center gap-1 text-fg-muted">
                  {c.resolved ? <CheckCircle2 aria-hidden className="size-3.5 text-ok" /> : <Circle aria-hidden className="size-3.5 text-warning" />}
                  <span className="font-medium text-fg-strong">{c.author.name}</span>
                  {c.source === 'client' && <span className="rounded bg-sunken px-1 text-2xs text-fg-muted">外部审阅</span>}
                  <span>· {new Date(c.created_at * 1000).toLocaleString('zh-CN')}</span>
                  <span className={cn('ml-auto', c.resolved ? 'text-ok' : 'text-warning')}>{c.resolved ? '已解决' : '未解决'}</span>
                </div>
                <div className="whitespace-pre-wrap text-fg">{c.body}</div>
                {(c.anchor?.quote || c.anchor?.block_id) && (
                  <div className="mt-1 rounded bg-app px-1.5 py-1 text-2xs text-fg-muted">{c.anchor.quote || c.anchor.block_id}</div>
                )}
                {c.replies.length > 0 && (
                  <ul className="mt-1 space-y-1 border-l border-border pl-2">
                    {c.replies.map((rp) => (
                      <li key={rp.id} className="text-fg">
                        <span className="font-medium">{rp.author.name}</span>
                        <span className="ml-1 text-fg-muted">{new Date(rp.created_at * 1000).toLocaleString('zh-CN')}</span>
                        <div className="whitespace-pre-wrap">{rp.body}</div>
                      </li>
                    ))}
                  </ul>
                )}
                {canEdit && (
                  <div className="mt-1.5 flex items-center gap-1">
                    {replyFor !== c.id ? (
                      <Button variant="ghost" size="sm" className="h-6 px-1.5" onClick={() => setReplyFor(c.id)} data-testid={`word-comment-reply-${c.id}`}>
                        回复
                      </Button>
                    ) : (
                      <>
                        <input
                          className="min-w-0 flex-1 rounded border border-border bg-app px-1.5 py-1 text-fg"
                          value={replyBody}
                          onChange={(e) => setReplyBody(e.target.value)}
                          placeholder="回复…"
                          data-testid={`word-comment-reply-body-${c.id}`}
                        />
                        <Button
                          size="sm"
                          className="h-6 px-1.5"
                          onClick={() => void reply(c.id)}
                          disabled={busy || !replyBody.trim()}
                          data-testid={`word-comment-reply-send-${c.id}`}
                        >
                          发送
                        </Button>
                      </>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-auto h-6 px-1.5"
                      onClick={() => void setResolved(c.id, !c.resolved)}
                      disabled={busy}
                      data-testid={`word-comment-resolve-${c.id}`}
                    >
                      {c.resolved ? '重开' : '标记已解决'}
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

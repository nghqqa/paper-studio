import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, Circle, ListTodo, MessageSquarePlus, Reply, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { commentsApi } from '@/lib/api/comments'

/**
 * w21：LaTeX 工作台批注侧栏（学生/导师最小闭环）。
 * 列表（当前文件/全部 × 未解决/已解决）、定位（复用工作台跳转）、回复、解决/重开。
 * 创建基于「已保存的服务器版本」：dirty（未保存）时禁用，sha 由父组件提供（最后保存确认的版本）。
 * 权限：读=后端校验；创建/回复/解决失败（403 等）时原样展示后端消息（只读表现）。
 */
export interface LatexCommentAnchor {
  file?: string | null
  block_id?: string | null
  line?: number | null
  line_start?: number | null
  line_end?: number | null
  quote?: string | null
  sha?: string | null
  stale?: boolean
  [k: string]: unknown
}

export interface LatexCommentItem {
  id: string
  body: string
  resolved: boolean
  anchor: LatexCommentAnchor
  author: { id: string | null; name: string }
  created_at: number
  source?: string
  linked_issue_id?: string | null
  linked_rebuttal_id?: string | null
  replies: Array<{ id: string; body: string; author: { name: string }; created_at: number }>
}

interface Props {
  pid: string
  activePath: string | null
  /** 最后一次保存确认的服务器文件 sha；null/未保存时不允许创建 */
  savedSha: string | null
  dirty: boolean
  /** 当前光标行（创建锚点用）；null 时创建按钮禁用 */
  currentLine: number | null
  canEdit?: boolean
  onJump(file: string, line: number): void
  onJumpPage?(page: number): void
  reloadSignal: number
}

function timeOf(ts: number): string {
  return new Date(ts * 1000).toLocaleString()
}

export function CommentsSidebar({ pid, activePath, savedSha, dirty, currentLine, canEdit = true, onJump, onJumpPage, reloadSignal }: Props) {
  const [comments, setComments] = useState<LatexCommentItem[] | null>(null)
  const [scope, setScope] = useState<'current' | 'all'>('current')
  const [status, setStatus] = useState<'open' | 'resolved' | 'all'>('open')
  const [error, setError] = useState('')
  const [newBody, setNewBody] = useState('')
  const [replyFor, setReplyFor] = useState<string | null>(null)
  const [replyBody, setReplyBody] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const all = (await commentsApi.comments(pid)) as unknown as LatexCommentItem[]
      // 保留 LaTeX 文件锚点 + 免登录外部审阅 / PDF 页级锚点；专利块锚点不在本工作台
      setComments(all.filter((c) => !!c.anchor?.file || c.source === 'client' || (c.anchor?.block_id ?? '').startsWith('pdf:')))
      setError('')
    } catch (e) {
      setError(errTextLocal(e))
    }
  }, [pid])

  useEffect(() => {
    void refresh()
  }, [refresh, reloadSignal])

  const visible = (comments ?? []).filter((c) => {
    if (scope === 'current' && c.anchor?.file && c.anchor.file !== activePath) return false
    if (status === 'open' && c.resolved) return false
    if (status === 'resolved' && !c.resolved) return false
    return true
  })

  const create = useCallback(async () => {
    if (!activePath || !savedSha || dirty || currentLine == null || !newBody.trim()) return
    setBusy(true)
    setError('')
    try {
      await commentsApi.addComment(
        pid,
        {
          file: activePath,
          line: currentLine,
          line_start: currentLine,
          line_end: currentLine,
          sha: savedSha,
        } as unknown as Parameters<typeof commentsApi.addComment>[1],
        newBody.trim(),
      )
      setNewBody('')
      await refresh()
    } catch (e) {
      // 409（版本不一致）/403（权限）原样展示，不静默
      setError(errTextLocal(e))
    } finally {
      setBusy(false)
    }
  }, [activePath, currentLine, dirty, newBody, pid, refresh, savedSha])

  const baseReady = !dirty && !!activePath && currentLine != null && !!savedSha
  const canCreate = baseReady && !!newBody.trim()

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
        setError(errTextLocal(e))
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
        setError(errTextLocal(e))
      } finally {
        setBusy(false)
      }
    },
    [pid, refresh],
  )

  const promoteIssue = useCallback(
    async (cid: string) => {
      setBusy(true)
      setError('')
      try {
        await commentsApi.promoteToIssue(pid, cid)
        await refresh()
      } catch (e) {
        setError(errTextLocal(e))
      } finally {
        setBusy(false)
      }
    },
    [pid, refresh],
  )

  const promoteRebuttal = useCallback(
    async (cid: string) => {
      setBusy(true)
      setError('')
      try {
        await commentsApi.promoteToRebuttal(pid, cid)
        await refresh()
      } catch (e) {
        setError(errTextLocal(e))
      } finally {
        setBusy(false)
      }
    },
    [pid, refresh],
  )

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="latex-comments">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-2 text-xs text-fg-muted">
        批注
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-6 px-1.5"
          onClick={() => void refresh()}
          data-testid="latex-comments-refresh"
          title="刷新批注"
        >
          <RotateCw aria-hidden className="size-3" />
        </Button>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line px-2 py-1 text-xs">
        <Seg options={['current', 'all']} value={scope} onChange={setScope} labels={{ current: '当前文件', all: '全部文件' }} />
        <Seg
          options={['open', 'resolved', 'all']}
          value={status}
          onChange={setStatus}
          labels={{ open: '未解决', resolved: '已解决', all: '全部' }}
        />
      </div>
      {error && (
        <div role="alert" className="shrink-0 border-b border-line px-2 py-1 text-xs text-danger" data-testid="latex-comments-error">
          {error}
        </div>
      )}
      {/* 新建批注（基于已保存版本；未保存时禁用） */}
      <div className="shrink-0 border-b border-line px-2 py-1.5" data-testid="latex-comment-new">
        <div className="mb-1 text-xs text-fg-muted">
          {dirty
            ? '有未保存修改——请先保存，再基于服务器版本创建批注'
            : activePath
              ? currentLine != null
                ? `在 ${activePath} 第 ${currentLine} 行创建批注`
                : `请先在编辑器中点击 ${activePath} 要批注的源码行`
              : '未打开文件'}
        </div>
        <textarea
          className="w-full rounded border border-line bg-panel p-1.5 text-xs text-fg"
          rows={2}
          placeholder={baseReady ? '批注内容…' : dirty ? '先保存后可创建' : '请先在左侧编辑器中点击要批注的源码行'}
          value={newBody}
          onChange={(e) => setNewBody(e.target.value)}
          disabled={!baseReady}
          data-testid="latex-comment-new-body"
        />
        <Button
          size="sm"
          className="mt-1 w-full"
          onClick={() => void create()}
          disabled={!canCreate || busy}
          data-testid="latex-comment-create"
        >
          <MessageSquarePlus aria-hidden className="size-3.5" />
          创建批注
        </Button>
      </div>
      {/* 列表 */}
      <div className="min-h-0 flex-1 overflow-auto p-2" data-testid="latex-comment-list">
        {visible.length === 0 && <div className="px-1 text-xs text-fg-muted">暂无批注</div>}
        <ul className="space-y-2">
          {visible.map((c) => (
            <li key={c.id} className="rounded border border-line bg-panel p-2 text-xs" data-testid={`latex-comment-${c.id}`}>
              <div className="mb-1 flex items-center gap-1 text-fg-muted">
                {c.resolved ? (
                  <CheckCircle2 aria-hidden className="size-3.5 text-ok" />
                ) : (
                  <Circle aria-hidden className="size-3.5 text-warning" />
                )}
                <span className="font-medium text-fg-strong">{c.author.name}</span>
                {c.source === 'client' && (
                  <span className="rounded bg-sunken px-1 text-2xs text-fg-muted">外部审阅</span>
                )}
                <span>· {timeOf(c.created_at)}</span>
                <span
                  className={cn('ml-auto', c.resolved ? 'text-ok' : 'text-warning')}
                  data-testid={`latex-comment-state-${c.id}`}
                >
                  {c.resolved ? '已解决' : '未解决'}
                </span>
              </div>
              <div className="whitespace-pre-wrap text-fg">{c.body}</div>
              {c.anchor?.file && (
                <div className="mt-1 flex items-center gap-1 text-fg-muted">
                  <button
                    className="truncate hover:underline"
                    disabled={busy}
                    title={c.anchor.stale ? '源码已变化：此为原行号参考，非准确定位' : '点击定位到该行'}
                    onClick={() => c.anchor.file && onJump(c.anchor.file, c.anchor.line_start ?? c.anchor.line ?? 1)}
                    data-testid={`latex-comment-jump-${c.id}`}
                  >
                    {c.anchor.file}:{c.anchor.line_start ?? c.anchor.line ?? '?'}
                  </button>
                  {c.anchor.stale && <span className="text-warning">位置待核对</span>}
                </div>
              )}
              {!c.anchor?.file && c.anchor?.block_id?.startsWith('pdf:page-') && (() => {
                const m = c.anchor.block_id.match(/^pdf:page-(\d+)$/)
                const pageNum = m ? Number(m[1]) : null
                return (
                  <div className="mt-1 flex items-center gap-1 text-fg-muted">
                    {pageNum && onJumpPage ? (
                      <button
                        className="truncate hover:underline"
                        disabled={busy}
                        title={`跳转到 PDF 第 ${pageNum} 页`}
                        onClick={() => onJumpPage(pageNum)}
                        data-testid={`latex-comment-jump-page-${c.id}`}
                      >
                        PDF 第 {pageNum} 页
                      </button>
                    ) : (
                      <span>{c.anchor.quote || c.anchor.block_id}</span>
                    )}
                  </div>
                )
              })()}
              {c.anchor?.quote && (
                <div className="mt-1 rounded bg-app px-1.5 py-1 text-fg-muted" title="创建时的源码上下文">
                  {c.anchor.quote}
                </div>
              )}
              {c.replies.length > 0 && (
                <ul className="mt-1 space-y-1 border-l border-line pl-2">
                  {c.replies.map((rp) => (
                    <li key={rp.id} className="text-fg">
                      <span className="font-medium">{rp.author.name}</span>
                      <span className="ml-1 text-fg-muted">{timeOf(rp.created_at)}</span>
                      <div className="whitespace-pre-wrap">{rp.body}</div>
                    </li>
                  ))}
                </ul>
              )}
              {(c.linked_issue_id || c.linked_rebuttal_id) && (
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-2xs">
                  {c.linked_issue_id && (
                    <span className="rounded bg-sunken px-1.5 py-0.5 text-primary" data-testid={`latex-comment-linked-issue-${c.id}`}>
                      已转待办 #{c.linked_issue_id}
                    </span>
                  )}
                  {c.linked_rebuttal_id && (
                    <span className="rounded bg-sunken px-1.5 py-0.5 text-ok" data-testid={`latex-comment-linked-rebuttal-${c.id}`}>
                      已入回复信 {c.linked_rebuttal_id}
                    </span>
                  )}
                </div>
              )}
              <div className="mt-1.5 flex flex-wrap items-center gap-1">
                {replyFor !== c.id && (
                  <Button variant="ghost" size="sm" className="h-6 px-1.5" onClick={() => setReplyFor(c.id)} data-testid={`latex-comment-reply-${c.id}`}>
                    回复
                  </Button>
                )}
                {replyFor === c.id && (
                  <>
                    <input
                      className="min-w-0 flex-1 rounded border border-line bg-app px-1.5 py-1 text-fg"
                      value={replyBody}
                      onChange={(e) => setReplyBody(e.target.value)}
                      placeholder="回复…"
                      data-testid={`latex-comment-reply-body-${c.id}`}
                    />
                    <Button size="sm" className="h-6 px-1.5" onClick={() => void reply(c.id)} disabled={busy || !replyBody.trim()} data-testid={`latex-comment-reply-send-${c.id}`}>
                      发送
                    </Button>
                  </>
                )}
                {canEdit && replyFor !== c.id && (
                  <>
                    {!c.linked_issue_id && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-1.5 text-fg-muted hover:text-fg"
                        onClick={() => void promoteIssue(c.id)}
                        disabled={busy}
                        title="转为待办 Issue"
                        data-testid={`latex-comment-to-issue-${c.id}`}
                      >
                        <ListTodo aria-hidden className="size-3" />
                        转待办
                      </Button>
                    )}
                    {!c.linked_rebuttal_id && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-1.5 text-fg-muted hover:text-fg"
                        onClick={() => void promoteRebuttal(c.id)}
                        disabled={busy}
                        title="纳入审稿回复信"
                        data-testid={`latex-comment-to-rebuttal-${c.id}`}
                      >
                        <Reply aria-hidden className="size-3" />
                        转回复信
                      </Button>
                    )}
                  </>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto h-6 px-1.5"
                  onClick={() => void setResolved(c.id, !c.resolved)}
                  disabled={busy}
                  data-testid={`latex-comment-resolve-${c.id}`}
                >
                  {c.resolved ? '重开' : '标记已解决'}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function Seg<T extends string>({
  options,
  value,
  onChange,
  labels,
}: {
  options: T[]
  value: T
  onChange: (v: T) => void
  labels: Record<T, string>
}) {
  return (
    <div className="flex overflow-hidden rounded border border-line">
      {options.map((o) => (
        <button
          key={o}
          className={cn('px-1.5 py-0.5', value === o ? 'bg-panel text-fg-strong' : 'text-fg-muted hover:bg-panel')}
          onClick={() => onChange(o)}
          data-testid={`latex-comments-seg-${o}`}
        >
          {labels[o]}
        </button>
      ))}
    </div>
  )
}

function errTextLocal(e: unknown): string {
  const anyErr = e as { message?: string; detail?: { message?: string } }
  return anyErr?.detail?.message || anyErr?.message || String(e)
}

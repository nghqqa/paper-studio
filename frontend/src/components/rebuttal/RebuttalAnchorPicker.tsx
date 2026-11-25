import { useEffect, useState } from 'react'
import { commentsApi } from '@/lib/api/comments'
import { latexApi } from '@/lib/api/latex'
import { rebuttalApi, type RebuttalItem, type RebuttalSnapshot } from '@/lib/api/rebuttal'
import { wordApi } from '@/lib/api/word'
import { cn } from '@/lib/utils'
import { FIELD_CLS, msgOf } from './rebuttalHelpers'

/** 工程锚点关联器：LaTeX 读 /comments + /latex/history；Word 模式挂 Word 版本列表。 */
export function RebuttalAnchorPicker({
  pid,
  mode,
  item,
  canEdit,
  onChanged,
}: {
  pid: string
  mode: 'latex' | 'word'
  item: RebuttalItem
  canEdit: boolean
  onChanged: () => void
}) {
  const [comments, setComments] = useState<{ id: string; body?: string }[] | null>(null)
  const [versions, setVersions] = useState<{ value: string; label: string; sha: string }[] | null>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    let alive = true
    if (mode === 'latex') {
      commentsApi
        .comments(pid)
        .then((cs) => {
          if (alive) setComments((cs as unknown as { id: string; body?: string }[]).filter((c) => c.id).slice(0, 30))
        })
        .catch(() => {
          if (alive) setComments([])
        })
      latexApi
        .history(pid)
        .then((vs) => {
          if (!alive) return
          const mapped = (vs ?? [])
            .filter((v) => v.sha)
            .map((v) => {
              const rawAt = v.at as unknown
              const dt = typeof rawAt === 'number' ? new Date(rawAt < 1e12 ? rawAt * 1000 : rawAt) : new Date(String(rawAt))
              return {
                value: String(v.sha),
                label: `${String(v.sha).slice(0, 10)} · ${dt.toLocaleString('zh-CN')}`,
                sha: String(v.sha),
              }
            })
          setVersions(mapped)
        })
        .catch(() => {
          if (alive) setVersions([])
        })
    } else {
      wordApi
        .state(pid)
        .then((st) => {
          if (alive) {
            setVersions(
              (st.versions ?? []).map((v) => ({
                value: v.id,
                label: `${v.id} · ${new Date(v.created_at).toLocaleString('zh-CN')}`,
                sha: v.sha,
              })),
            )
          }
        })
        .catch(() => {
          if (alive) setVersions([])
        })
    }
    return () => {
      alive = false
    }
  }, [pid, mode])

  async function applySnapshot(snap: RebuttalSnapshot | null) {
    try {
      await rebuttalApi.updateItem(pid, item.id, { snapshot: snap })
      onChanged()
    } catch (e) {
      setErr(msgOf(e))
    }
  }

  async function toggleComment(cid: string) {
    const next = (item.comment_ids ?? []).includes(cid)
      ? (item.comment_ids ?? []).filter((x) => x !== cid)
      : [...(item.comment_ids ?? []), cid]
    try {
      await rebuttalApi.updateItem(pid, item.id, { comment_ids: next })
      onChanged()
    } catch (e) {
      setErr(msgOf(e))
    }
  }

  const snap = item.snapshot ?? null
  const ids = item.comment_ids ?? []

  return (
    <div className="space-y-1 rounded-md border border-line p-2" data-testid="rebuttal-anchors">
      <span className="text-2xs text-fg-muted">工程锚点</span>
      {err && (
        <p role="alert" className="text-2xs text-danger">
          {err}
        </p>
      )}
      {mode === 'latex' && comments !== null && (
        <div>
          <p className="text-2xs text-fg-muted">关联批注（平台批注线程）</p>
          {comments.length === 0 && <p className="text-2xs text-fg-muted">工程内暂无批注线程。</p>}
          {comments.slice(0, 12).map((c) => (
            <label key={c.id} className="flex items-center gap-1 py-0.5">
              <input
                type="checkbox"
                disabled={!canEdit}
                checked={ids.includes(c.id)}
                onChange={() => void toggleComment(c.id)}
                data-testid={`rebuttal-anchor-comment-${c.id}`}
              />
              <span className="truncate font-mono text-2xs">{c.id}</span>
              <span className="truncate text-2xs text-fg-muted">{(c.body ?? '').slice(0, 30)}</span>
            </label>
          ))}
        </div>
      )}
      <div>
        <p className="text-2xs text-fg-muted">{mode === 'word' ? '关联 Word 版本快照' : '关联 LaTeX 历史快照'}</p>
        <select
          className={cn(FIELD_CLS, 'py-1')}
          value={snap ? snap.vid || snap.sha : ''}
          disabled={!canEdit}
          onChange={(e) => {
            const v = e.target.value
            if (!v) return void applySnapshot(null)
            if (mode === 'word') {
              const hit = (versions ?? []).find((x) => x.value === v)
              return void applySnapshot({ type: 'word-version', sha: hit?.sha ?? '', vid: v })
            }
            void applySnapshot({ type: 'latex-history', sha: v })
          }}
          data-testid="rebuttal-anchor-snapshot"
        >
          <option value="">未关联快照</option>
          {(versions ?? []).map((v) => (
            <option key={v.value} value={v.value}>
              {v.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}

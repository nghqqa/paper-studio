import { useCallback, useEffect, useState } from 'react'
import { CloudDownload, CloudUpload, Loader2, RefreshCw, Unlink } from 'lucide-react'
import { cn } from '@/lib/utils'
import { latexApi } from '@/lib/api/latex'
import { Button } from '@/components/ui/button'

/**
 * per-project GitHub/Gitea 推拉面板（v0.6.8，#5）：
 * 配置远端（https + PAT token，token 永不回传只显 has_token）→ 推送（先自动快照提交）/
 * 拉取（仅 fast-forward，分叉拒绝并给明语义）→ 变更后由工作台刷新文件/编辑器。
 */

type GitInfo = {
  remote: { url: string; branch: string; has_token: boolean } | null
  ahead: number | null
  behind: number | null
  head: string | null
}

export function LatexGitPanel({ pid, canEdit, onPulled }: {
  pid: string
  canEdit: boolean
  /** 拉取实际更新了工作区时回调（刷新文件清单/编辑器/索引） */
  onPulled: () => void
}) {
  const [info, setInfo] = useState<GitInfo | null>(null)
  const [loadErr, setLoadErr] = useState('')
  const [url, setUrl] = useState('')
  const [branch, setBranch] = useState('main')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState<'save' | 'push' | 'pull' | 'remove' | null>(null)
  const [msg, setMsg] = useState<{ text: string; err: boolean } | null>(null)

  const load = useCallback(async () => {
    setLoadErr('')
    try {
      const r = await latexApi.gitStatus(pid)
      setInfo(r)
      if (r.remote) {
        setUrl((cur) => cur || r.remote!.url)
        setBranch(r.remote.branch)
      }
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e))
    }
  }, [pid])

  useEffect(() => {
    setInfo(null)
    setUrl('')
    setBranch('main')
    setToken('')
    setMsg(null)
    void load()
  }, [load])

  const act = async (kind: 'save' | 'push' | 'pull' | 'remove', force = false) => {
    setBusy(kind)
    setMsg(null)
    try {
      if (kind === 'save') {
        const r = await latexApi.gitSetRemote(pid, url, branch, token)
        setToken('')
        setMsg({ text: '远端已保存', err: false })
        setInfo((cur) => ({ ...(cur ?? { ahead: null, behind: null, head: null }), remote: r.remote }))
      } else if (kind === 'push') {
        const r = await latexApi.gitPush(pid, force)
        setMsg({ text: `已推送到远端（${r.sha.slice(0, 7)}）${r.forced ? '（已覆盖远端）' : r.committed ? '，本地修改已先自动快照' : ''}`, err: false })
        await load()
      } else if (kind === 'pull') {
        const r = await latexApi.gitPull(pid, force)
        if (r.changed) {
          setMsg({ text: r.forced ? '已强制拉取：本地独立提交已放弃，工作区回到远端版本' : '已拉取并更新工作区', err: false })
          onPulled()
        } else {
          setMsg({ text: r.note === 'remote_empty' ? '远端分支还没有提交（空仓库），推送后即可同步' : '远端无新提交，本地已是最新', err: false })
        }
        await load()
      } else {
        await latexApi.gitDeleteRemote(pid)
        setUrl('')
        setBranch('main')
        setToken('')
        setMsg({ text: '已解除远端关联', err: false })
        await load()
      }
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e)
      // 非快进拒绝：显式确认后覆盖远端（防丢稿默认拒绝，覆盖必须二次确认）
      if (kind === 'push' && !force && text.includes('强制推送')) {
        setBusy(null)
        if (window.confirm('远端已有本地没有的提交（例如建仓库时初始化的 README）。\n确认用当前工程内容完全覆盖远端？远端现有版本将不可恢复。')) {
          await act('push', true)
        }
        return
      }
      // 分叉拒绝：拉取方向的显式逃生门——放弃本地独立提交、回到远端版本
      if (kind === 'pull' && !force && text.includes('各有修改')) {
        setBusy(null)
        if (window.confirm('本地与远端各有提交。确认放弃本地这些独立提交、把工作区完全恢复成远端版本？\n本地提交将从同步中丢弃（版本历史页签里仍有快照）。')) {
          await act('pull', true)
        } else {
          setMsg({ text: '已保留本地版本（未强制拉取）。远端与本地各自保留，可稍后处理。', err: false })
        }
        return
      }
      setMsg({ text, err: true })
    } finally {
      setBusy(null)
    }
  }

  if (info === null && !loadErr) {
    return (
      <div className="flex h-tree-row items-center gap-1.5 px-2.5 text-base text-fg-muted" data-testid="latex-git-loading">
        <Loader2 aria-hidden className="size-4 animate-spin" /> 读取同步状态…
      </div>
    )
  }

  const configured = info?.remote != null

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-2.5 text-sm" data-testid="latex-git">
      <p className="text-2xs leading-4 text-fg-muted">
        把工程推到自己的 GitHub / Gitea 私有仓库（仅 https + 个人访问令牌）。推送前自动保存快照；
        .studio 产物目录永不外发。拉取只做快进合并——本地与远端各有修改时会拒绝，绝不自动覆盖。
      </p>
      {loadErr && <p role="alert" className="text-xs text-danger">{loadErr}</p>}

      {!configured ? (
        <div className="grid gap-2" data-testid="latex-git-setup">
          <label className="grid gap-1 text-xs">
            仓库地址（https）
            <input
              className="rounded-md border border-line bg-app px-2 py-1.5 font-mono text-xs"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://github.com/you/paper.git"
              data-testid="latex-git-url"
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="grid gap-1 text-xs">
              分支
              <input
                className="rounded-md border border-line bg-app px-2 py-1.5 font-mono text-xs"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                data-testid="latex-git-branch"
              />
            </label>
            <label className="grid gap-1 text-xs">
              访问令牌（PAT，首次必填）
              <input
                type="password"
                className="rounded-md border border-line bg-app px-2 py-1.5 text-xs"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="ghp_… / gitea token"
                autoComplete="new-password"
                data-testid="latex-git-token"
              />
            </label>
          </div>
          <Button size="sm" variant="outline" disabled={!canEdit || !url || busy !== null}
            onClick={() => void act('save')} data-testid="latex-git-save">
            {busy === 'save' ? '保存中…' : '保存远端'}
          </Button>
        </div>
      ) : (
        <div className="grid gap-2" data-testid="latex-git-managed">
          <div className="rounded-md border border-line bg-panel p-2 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate font-mono" title={info!.remote!.url}>{info!.remote!.url}</span>
              <span className="shrink-0 rounded bg-sunken px-1.5 py-0.5 font-mono">{info!.remote!.branch}</span>
            </div>
            <div className="mt-1 flex items-center gap-3 text-2xs text-fg-muted">
              <span>令牌已保存{info!.remote!.has_token ? '' : '（未设置，仅公共仓库可用）'}</span>
              {info!.ahead != null && (
                <span className="tabular-nums" data-testid="latex-git-counts">
                  本地领先 {info!.ahead} · 落后 {info!.behind}
                </span>
              )}
            </div>
          </div>
          <div className="flex gap-1.5">
            <Button size="sm" variant="outline" className="h-7 flex-1 rounded text-xs" disabled={!canEdit || busy !== null}
              onClick={() => void act('pull')} data-testid="latex-git-pull">
              {busy === 'pull' ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : <CloudDownload aria-hidden className="size-3.5" />}
              拉取
            </Button>
            <Button size="sm" className="h-7 flex-1 rounded text-xs" disabled={!canEdit || busy !== null}
              onClick={() => void act('push')} data-testid="latex-git-push">
              {busy === 'push' ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : <CloudUpload aria-hidden className="size-3.5" />}
              推送
            </Button>
          </div>
          <button
            type="button"
            className={cn('inline-flex items-center justify-center gap-1 rounded px-2 py-1 text-2xs text-fg-muted hover:bg-hover disabled:opacity-50')}
            disabled={!canEdit || busy !== null}
            onClick={() => void act('remove')}
            data-testid="latex-git-remove"
          >
            {busy === 'remove' ? <Loader2 aria-hidden className="size-3 animate-spin" /> : <Unlink aria-hidden className="size-3" />}
            解除远端关联
          </button>
        </div>
      )}

      {msg && (
        <p role={msg.err ? 'alert' : 'status'} className={cn('text-xs', msg.err ? 'text-danger' : 'text-fg-muted')} data-testid="latex-git-msg">
          {msg.text}
        </p>
      )}
      <button
        type="button"
        className="mt-auto inline-flex items-center justify-center gap-1 rounded px-2 py-1 text-2xs text-fg-muted hover:bg-hover"
        onClick={() => void load()}
        aria-label="刷新同步状态"
        data-testid="latex-git-refresh"
      >
        <RefreshCw aria-hidden className="size-3" />
        刷新状态
      </button>
    </div>
  )
}

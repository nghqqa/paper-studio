import { useCallback, useEffect, useState } from 'react'
import { History, Loader2, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { latexApi, type LatexVersion } from '@/lib/api/latex'
import { versionLabel } from '@/lib/versionLabel'
import { fmtFull, fmtWhen } from '@/lib/format'
import { Button } from '@/components/ui/button'

/**
 * LaTeX 工程版本历史（防丢稿）：编译必快照、保存 90s 合并、结构性操作立即提交
 * （backend/app/domain/latex_history.py，同一 per-project git）。
 * 选中 → 拉取该版与工作区的整树 unified diff；「恢复此版本」把工作区精确写回目标状态
 * （多余文件删除），确认与后续文件/编辑器刷新在工作台侧（onRestore）。
 */

function UnifiedDiff({ text }: { text: string }) {
  if (!text) return <p className="text-xs text-fg-muted">与工作区无差异。</p>
  return (
    <pre data-testid="latex-version-diff" className="max-h-56 overflow-auto rounded bg-panel p-1.5 font-mono text-2xs leading-none">
      {text.replace(/\n$/, '').split('\n').map((l, i) => (
        <div
          key={i}
          className={cn(
            'whitespace-pre-wrap break-all',
            l.startsWith('+') && !l.startsWith('+++') && 'bg-ok-bg text-ok-fg',
            l.startsWith('-') && !l.startsWith('---') && 'bg-danger-bg text-danger-fg',
            l.startsWith('@@') && 'text-fg-muted',
          )}
        >
          {l}
        </div>
      ))}
    </pre>
  )
}

export function LatexHistory({ pid, canEdit, onRestore }: {
  pid: string
  canEdit: boolean
  /** 执行恢复（确认+API+文件/编辑器刷新在工作台侧）；返回人话结果；null=用户取消（静默） */
  onRestore: (sha: string) => Promise<string | null>
}) {
  const [versions, setVersions] = useState<LatexVersion[] | null>(null)
  const [loadErr, setLoadErr] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [diff, setDiff] = useState<string | null>(null)
  const [diffErr, setDiffErr] = useState('')
  const [restoring, setRestoring] = useState(false)
  const [result, setResult] = useState('')

  const load = useCallback(async () => {
    setLoadErr('')
    try {
      const list = await latexApi.history(pid)
      setVersions(list)
      setSelected((cur) => (cur && list.some((v) => v.sha === cur) ? cur : null))
    } catch (e) {
      setVersions([])
      setLoadErr(e instanceof Error ? e.message : String(e))
    }
  }, [pid])

  useEffect(() => {
    setVersions(null)
    setSelected(null)
    setDiff(null)
    setResult('')
    void load()
  }, [load])

  const pick = (sha: string | null) => {
    setSelected(sha)
    setDiff(null)
    setDiffErr('')
    setResult('')
    if (!sha) return
    latexApi.historyDiff(pid, sha)
      .then((r) => setDiff(r.diff))
      .catch((e: unknown) => setDiffErr(e instanceof Error ? e.message : String(e)))
  }

  const restore = async (sha: string) => {
    setRestoring(true)
    setResult('')
    try {
      const out = await onRestore(sha)
      if (out) setResult(out)
      await load()
    } catch (e) {
      setResult(`恢复失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setRestoring(false)
    }
  }

  if (versions === null) {
    return (
      <div className="flex h-tree-row items-center gap-1.5 px-2.5 text-base text-fg-muted" data-testid="latex-history-loading">
        <Loader2 aria-hidden className="size-4 animate-spin" /> 读取版本…
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col text-sm" data-testid="latex-history">
      <div className="flex shrink-0 items-center justify-between px-2.5 py-1">
        <p className="text-2xs leading-4 text-fg-muted">编译与保存自动记录版本；恢复会把全部源文件写回该时刻。</p>
        <button
          type="button"
          className="shrink-0 rounded p-1 text-fg-muted hover:bg-hover hover:text-fg"
          title="刷新版本列表"
          aria-label="刷新版本列表"
          onClick={() => void load()}
          data-testid="latex-history-refresh"
        >
          <History aria-hidden className="size-3.5" />
        </button>
      </div>
      {loadErr && <p role="alert" className="px-2.5 pb-1 text-xs text-danger">{loadErr}</p>}
      {versions.length === 0 ? (
        <p role="status" className="flex h-tree-row items-center gap-1.5 px-2.5 text-base text-fg-muted" data-testid="latex-history-empty">
          <History className="size-4" aria-hidden />
          暂无版本（编译或保存后自动生成）
        </p>
      ) : (
        <ul role="listbox" aria-label="版本列表" className="min-h-0 flex-1 overflow-auto px-1 pb-1" data-testid="latex-history-list">
          {versions.map((v) => {
            const active = v.sha === selected
            return (
              <li key={v.sha} role="none">
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  title={`${v.sha}\n${fmtFull(v.at)} · ${v.author}\n${versionLabel(v.message)}`}
                  className={cn(
                    'flex w-full items-center justify-between gap-1.5 rounded py-1 pl-2.5 pr-1.5 text-left',
                    active ? 'bg-selected font-bold text-link' : 'hover:bg-hover',
                  )}
                  onClick={() => pick(active ? null : v.sha)}
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-base leading-5" title={versionLabel(v.message)}>{versionLabel(v.message)}</span>
                    <span className={cn('truncate font-mono text-2xs font-normal leading-none', active ? 'text-link' : 'text-fg-muted')} title={`${fmtWhen(v.at)} · ${v.author}`}>
                      {fmtWhen(v.at)} · {v.author}
                    </span>
                  </span>
                  <span className={cn('flex shrink-0 flex-col items-end font-mono text-2xs font-normal leading-none', active ? 'text-link' : 'text-fg-muted')}>
                    <span>{v.sha.slice(0, 7)}</span>
                    {(v.added > 0 || v.deleted > 0) && (
                      <span className="tabular-nums" data-testid="latex-version-lines">
                        <span className={active ? undefined : 'text-ok-fg'}>+{v.added}</span> <span className={active ? undefined : 'text-danger-fg'}>−{v.deleted}</span>
                      </span>
                    )}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {selected && (
        <div className="shrink-0 space-y-2 border-t bg-sunken/60 p-2.5" data-testid="latex-history-detail">
          {result && <p role="status" className="text-xs text-fg-muted" data-testid="latex-history-result">{result}</p>}
          {diffErr ? (
            <p className="text-xs text-danger">读取差异失败：{diffErr}</p>
          ) : diff === null ? (
            <p className="text-xs text-fg-muted">读取差异…</p>
          ) : (
            <UnifiedDiff text={diff} />
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-7 w-full rounded text-xs"
            disabled={!canEdit || restoring}
            onClick={() => void restore(selected)}
            title={canEdit ? '把全部源文件写回该版本（多余文件删除，不可自动撤销）' : '只读访问不可恢复'}
            data-testid="latex-history-restore"
          >
            {restoring ? <Loader2 aria-hidden className="animate-spin" /> : <RotateCcw aria-hidden />}
            恢复此版本
          </Button>
        </div>
      )}
    </div>
  )
}

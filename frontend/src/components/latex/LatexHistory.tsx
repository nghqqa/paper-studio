import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Bookmark, FileDiff, History, Loader2, RotateCcw, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { latexApi, type LatexDiffItem, type LatexVersion } from '@/lib/api/latex'
import { fmtFull, fmtWhen } from '@/lib/format'
import { cn } from '@/lib/utils'
import { versionLabel } from '@/lib/versionLabel'

/**
 * LaTeX 工程版本历史（防丢稿）+ 命名里程碑 + 返修高亮 PDF（latexdiff）：
 * 编译必快照、保存 90s 合并、结构性操作立即提交（backend/app/domain/latex_history.py）。
 * 选中 → 拉取该版与工作区的整树 unified diff，并支持一键生成对比工作区的 Marked-up Diff PDF。
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

  const [milestoneName, setMilestoneName] = useState('')
  const [milestoneBusy, setMilestoneBusy] = useState(false)
  const [milestoneErr, setMilestoneErr] = useState('')

  const [diffAvailable, setDiffAvailable] = useState(true)
  const [diffs, setDiffs] = useState<LatexDiffItem[]>([])
  const [diffPdfBusy, setDiffPdfBusy] = useState(false)
  const [diffPdfErr, setDiffPdfErr] = useState('')
  const [latestDiff, setLatestDiff] = useState<LatexDiffItem | null>(null)

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
    if (typeof latexApi.listDiffs === 'function') {
      void latexApi
        .listDiffs(pid)
        .then((res) => {
          setDiffAvailable(res.available)
          setDiffs(res.items ?? [])
        })
        .catch(() => {})
    }
  }, [pid])

  useEffect(() => {
    setVersions(null)
    setSelected(null)
    setDiff(null)
    setResult('')
    setLatestDiff(null)
    setDiffPdfErr('')
    void load()
  }, [load])

  const pick = (sha: string | null) => {
    setSelected(sha)
    setDiff(null)
    setDiffErr('')
    setDiffPdfErr('')
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

  const onCreateMilestone = async (e: FormEvent) => {
    e.preventDefault()
    const clean = milestoneName.trim()
    if (!clean || milestoneBusy) return
    setMilestoneBusy(true)
    setMilestoneErr('')
    try {
      await latexApi.createMilestone(pid, clean, selected ?? undefined)
      setMilestoneName('')
      await load()
    } catch (err) {
      setMilestoneErr(err instanceof Error ? err.message : String(err))
    } finally {
      setMilestoneBusy(false)
    }
  }

  const onDeleteMilestone = async (name: string) => {
    setMilestoneErr('')
    try {
      await latexApi.deleteMilestone(pid, name)
      await load()
    } catch (err) {
      setMilestoneErr(err instanceof Error ? err.message : String(err))
    }
  }

  const onGenerateDiffPdf = async () => {
    if (!selected || diffPdfBusy) return
    setDiffPdfBusy(true)
    setDiffPdfErr('')
    try {
      const item = await latexApi.generateDiffPdf(pid, selected, 'work')
      setLatestDiff(item)
      setDiffs((prev) => [item, ...prev.filter((d) => d.diff_id !== item.diff_id)].slice(0, 10))
      if (item.status !== 'ok') {
        setDiffPdfErr(item.error || '返修高亮 PDF 生成失败')
      }
    } catch (err) {
      setDiffPdfErr(err instanceof Error ? err.message : String(err))
    } finally {
      setDiffPdfBusy(false)
    }
  }

  if (versions === null) {
    return (
      <div className="flex h-tree-row items-center gap-1.5 px-2.5 text-base text-fg-muted" data-testid="latex-history-loading">
        <Loader2 aria-hidden className="size-4 animate-spin" /> 读取版本…
      </div>
    )
  }

  const selectedVersion = selected ? versions.find((v) => v.sha === selected) : undefined
  const activeDiffPdf =
    latestDiff?.status === 'ok' && latestDiff.base_sha === selected
      ? latestDiff
      : diffs.find((d) => d.status === 'ok' && d.base_sha === selected)

  return (
    <div className="flex min-h-0 flex-1 flex-col text-sm" data-testid="latex-history">
      <div className="flex shrink-0 items-center justify-between px-2.5 py-1">
        <p className="text-2xs leading-4 text-fg-muted">编译与保存自动记录版本；支持里程碑标记与返修高亮 PDF。</p>
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

      {canEdit && (
        <form onSubmit={(e) => void onCreateMilestone(e)} className="flex shrink-0 items-center gap-1 px-2.5 pb-1.5">
          <Input
            size="sm"
            maxLength={48}
            value={milestoneName}
            onChange={(e) => {
              setMilestoneName(e.target.value)
              if (milestoneErr) setMilestoneErr('')
            }}
            placeholder={selected ? '给选中版标里程碑…' : '里程碑名（如 初稿投稿）'}
            aria-label="里程碑名称"
            className="h-sm flex-1 text-xs"
            data-testid="latex-milestone-input"
          />
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={!milestoneName.trim() || milestoneBusy}
            className="h-sm shrink-0 px-2 text-xs"
            data-testid="latex-milestone-create"
          >
            {milestoneBusy ? <Loader2 aria-hidden className="size-3 animate-spin" /> : <Bookmark aria-hidden className="size-3" />}
            标记
          </Button>
        </form>
      )}
      {milestoneErr && <p role="alert" className="px-2.5 pb-1 text-xs text-danger">{milestoneErr}</p>}
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
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-base leading-5" title={versionLabel(v.message)}>{versionLabel(v.message)}</span>
                    {v.milestones && v.milestones.length > 0 && (
                      <span className="flex flex-wrap gap-1" data-testid="latex-version-milestones">
                        {v.milestones.map((m) => (
                          <Badge key={m} tone="brand" className="h-4 px-1.5 text-2xs">
                            {m}
                          </Badge>
                        ))}
                      </span>
                    )}
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
          {selectedVersion?.milestones && selectedVersion.milestones.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              {selectedVersion.milestones.map((m) => (
                <Badge key={m} tone="brand" className="gap-1">
                  <span>{m}</span>
                  {canEdit && (
                    <button
                      type="button"
                      aria-label={`移除里程碑 ${m}`}
                      onClick={() => void onDeleteMilestone(m)}
                      data-testid={`latex-milestone-del-${m}`}
                      className="rounded-full p-0.5 hover:bg-hover"
                    >
                      <X className="size-2.5" aria-hidden />
                    </button>
                  )}
                </Badge>
              ))}
            </div>
          )}

          {result && <p role="status" className="text-xs text-fg-muted" data-testid="latex-history-result">{result}</p>}
          {diffErr ? (
            <p className="text-xs text-danger">读取差异失败：{diffErr}</p>
          ) : diff === null ? (
            <p className="text-xs text-fg-muted">读取差异…</p>
          ) : (
            <UnifiedDiff text={diff} />
          )}

          <div className="grid gap-1.5">
            <Button
              size="sm"
              variant="secondary"
              className="h-sm w-full rounded text-xs"
              disabled={!diffAvailable || diffPdfBusy}
              onClick={() => void onGenerateDiffPdf()}
              title={diffAvailable ? '使用 latexdiff 对比选中历史版本与当前工作区生成红删蓝增 PDF' : '当前运行环境未安装 latexdiff'}
              data-testid="latex-diff-pdf-btn"
            >
              {diffPdfBusy ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : <FileDiff aria-hidden className="size-3.5" />}
              {diffPdfBusy ? '正在生成高亮 PDF…' : '生成返修高亮 PDF（对比当前）'}
            </Button>

            {diffPdfErr && (
              <p role="alert" className="text-xs text-danger" data-testid="latex-diff-error">
                {diffPdfErr}
              </p>
            )}

            {activeDiffPdf?.pdf_url && (
              <div className="flex items-center justify-between rounded border border-border bg-panel px-2 py-1 text-xs">
                <span className="truncate text-fg-muted">对比完成 · {activeDiffPdf.base_label}</span>
                <a
                  href={latexApi.diffPdfUrl(pid, activeDiffPdf.diff_id, true)}
                  target="_blank"
                  rel="noreferrer"
                  data-testid="latex-diff-pdf-link"
                  className="shrink-0 font-medium text-link hover:underline"
                >
                  下载高亮 PDF
                </a>
              </div>
            )}

            <Button
              size="sm"
              variant="outline"
              className="h-sm w-full rounded text-xs"
              disabled={!canEdit || restoring}
              onClick={() => void restore(selected)}
              title={canEdit ? '把全部源文件写回该版本（多余文件删除，不可自动撤销）' : '只读访问不可恢复'}
              data-testid="latex-history-restore"
            >
              {restoring ? <Loader2 aria-hidden className="animate-spin" /> : <RotateCcw aria-hidden />}
              恢复此版本
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

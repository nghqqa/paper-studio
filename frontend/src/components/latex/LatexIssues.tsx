import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, Plus, Sparkles, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { latexApi, type LatexDiagnostic, type LatexIssue } from '@/lib/api/latex'
import { cn } from '@/lib/utils'

/**
 * 工程侧栏「Issues」页签（CoCraft 式）：
 * 筛选 pills（全部/待处理/已解决）+ 折叠式新增 + 干净卡片列表。
 * - 手动 issue：讨论/待办/审稿意见，持久化随工程；
 * - 编译诊断：最近一次构建的 error/warning 实时并入展示（点击跳源码），随重新编译自动更新。
 * AI 深度审稿生成 issue 属后续能力（外发范围需显式确认），此处先不含。
 */
type Filter = 'all' | 'open' | 'resolved'

export function LatexIssues({ pid, activeFile, diagList, onJump, aiReview, proposeFix, activeFileEmpty }: {
  pid: string
  activeFile: string | null
  diagList: LatexDiagnostic[]
  onJump(file: string, line: number | null): void
  /** AI 审阅当前文件（工作台侧弹窗确认外发范围后调用），返回生成条数。 */
  aiReview?(file: string): Promise<number>
  /** 从编译错误生成 AI 修复提案（显式触发；外发范围=错误行±上下文+错误信息）。 */
  proposeFix?(diag: LatexDiagnostic): void
  /** 当前文件内容为空/纯空白（工作台按编辑器实况传入）；未传视为不空（向后兼容）。 */
  activeFileEmpty?: boolean
}) {
  const [items, setItems] = useState<LatexIssue[] | null>(null)
  const [filter, setFilter] = useState<Filter>('open')
  const [composing, setComposing] = useState(false)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [aiBusy, setAiBusy] = useState(false)
  const [error, setError] = useState('')
  const [loadFailed, setLoadFailed] = useState(false)

  const load = useCallback(async () => {
    setLoadFailed(false)
    try {
      setItems((await latexApi.issues(pid)).issues)
      setError('')
    } catch (e) {
      setLoadFailed(true)
      setError(e instanceof Error ? e.message : 'Issues 加载失败')
    }
  }, [pid])
  useEffect(() => { void load() }, [load])

  const counts = useMemo(() => {
    const list = items ?? []
    return {
      all: list.length + diagList.length,
      open: list.filter((t) => t.status === 'open').length + diagList.length,
      resolved: list.filter((t) => t.status === 'resolved').length,
    }
  }, [items, diagList])

  const add = async () => {
    const text = message.trim()
    if (!text || busy) return
    setBusy(true); setError('')
    try {
      const row = await latexApi.addIssue(pid, { message: text, file: activeFile })
      setItems((list) => [row, ...(list ?? [])])
      setMessage('')
      setComposing(false)
      setFilter('open')
    } catch (e) {
      setError(e instanceof Error ? e.message : '添加失败')
    } finally { setBusy(false) }
  }

  const toggle = async (t: LatexIssue) => {
    setError('')
    try {
      const row = await latexApi.resolveIssue(pid, t.id, t.status !== 'resolved')
      setItems((list) => (list ?? []).map((x) => (x.id === row.id ? row : x)))
    } catch (e) { setError(e instanceof Error ? e.message : '操作失败') }
  }

  const remove = async (t: LatexIssue) => {
    setError('')
    try {
      await latexApi.deleteIssue(pid, t.id)
      setItems((list) => (list ?? []).filter((x) => x.id !== t.id))
    } catch (e) { setError(e instanceof Error ? e.message : '删除失败') }
  }

  const runAiReview = async () => {
    if (!aiReview || !activeFile || activeFileEmpty === true || aiBusy) return
    setAiBusy(true); setError('')
    try {
      const added = await aiReview(activeFile)
      if (added > 0) setFilter('open')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'AI 审阅失败')
    } finally { setAiBusy(false) }
  }

  const visible = useMemo(() => {
    const list = items ?? []
    if (filter === 'open') return list.filter((t) => t.status === 'open')
    if (filter === 'resolved') return list.filter((t) => t.status === 'resolved')
    return list
  }, [items, filter])

  const pill = (value: Filter, label: string, count: number) => (
    <button
      type="button"
      role="tab"
      aria-selected={filter === value}
      className={cn('rounded-full px-2 py-0.5 text-2xs transition-colors',
        filter === value ? 'bg-primary-soft font-medium text-primary' : 'text-fg-muted hover:bg-hover hover:text-fg')}
      onClick={() => setFilter(value)}
      data-testid={`latex-issue-filter-${value}`}
    >
      {label} {count > 0 && <span className="tabular">{count}</span>}
    </button>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="latex-issues">
      {/* 筛选 pills + 新增（CoCraft 式） */}
      <div className="flex shrink-0 items-center gap-0.5 border-b border-line px-2 py-1.5" role="tablist" aria-label="Issue 筛选">
        {pill('all', '全部', counts.all)}
        {pill('open', '待处理', counts.open)}
        {pill('resolved', '已解决', counts.resolved)}
        {aiReview && (
          <Button
            size="icon-xs" variant="ghost"
            className={cn(aiBusy && 'text-primary')}
            title={activeFile
              ? activeFileEmpty === true
                ? '当前文件内容为空，无法进行 AI 审阅'
                : `AI 审阅「${activeFile}」（确认后发送全文给模型）`
              : '打开文件后可 AI 审阅'}
            disabled={aiBusy || !activeFile || activeFileEmpty === true}
            onClick={() => void runAiReview()}
            data-testid="latex-issue-ai"
          >
            {aiBusy ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : <Sparkles aria-hidden className="size-3.5" />}
          </Button>
        )}
        <Button
          size="icon-xs" variant="ghost" className="ml-auto"
          aria-label={composing ? '收起新增' : '新增 Issue'}
          aria-expanded={composing}
          onClick={() => { setComposing((v) => !v); if (!composing) setFilter('open') }}
          data-testid="latex-issue-compose-toggle"
        >
          {composing ? <X aria-hidden className="size-3.5" /> : <Plus aria-hidden className="size-4" />}
        </Button>
      </div>

      {/* 全局错误提示：任何操作（加载/AI 审阅/勾选/删除/新增）失败都在此显示，与新增框开合无关 */}
      {error && (
        <div
          className="flex shrink-0 items-start gap-1.5 border-b border-line bg-danger/10 px-2 py-1.5 text-2xs text-danger"
          role="alert"
          data-testid="latex-issues-error"
        >
          <span className="min-w-0 flex-1 break-words leading-4">{error}</span>
          <button
            type="button"
            className="shrink-0 rounded p-0.5 text-danger transition-colors hover:bg-hover"
            aria-label="关闭错误提示"
            data-testid="latex-issues-error-dismiss"
            onClick={() => setError('')}
          >
            <X aria-hidden className="size-3" />
          </button>
        </div>
      )}

      {composing && (
        <div className="shrink-0 border-b border-line bg-panel p-2" data-testid="latex-issue-composer">
          <textarea
            className="max-h-28 min-h-16 w-full resize-none rounded-md border border-line bg-app p-2 text-xs leading-5"
            placeholder="记录问题、待办或审稿意见…"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            data-testid="latex-issue-input"
            autoFocus
          />
          <div className="mt-1.5 flex items-center gap-1.5">
            {activeFile && (
              <span className="min-w-0 truncate rounded bg-sunken px-1.5 py-0.5 text-2xs text-fg-muted" title={`将关联 ${activeFile}`}>
                {activeFile}
              </span>
            )}
            <Button size="xs" className="ml-auto shrink-0" disabled={busy || !message.trim()} onClick={() => void add()} data-testid="latex-issue-add">
              {busy ? <Loader2 aria-hidden className="size-3 animate-spin" /> : <Plus aria-hidden className="size-3" />}
              添加
            </Button>
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto p-2 text-xs">
        {items === null && !loadFailed && <p className="p-2 text-fg-muted">加载中…</p>}

        {items === null && loadFailed && (
          <div className="px-2 py-6 text-center" data-testid="latex-issues-load-failed">
            <p className="text-fg-muted">Issues 加载失败，请检查网络后重试。</p>
            <Button size="xs" variant="outline" className="mt-2" onClick={() => void load()} data-testid="latex-issues-retry">
              重试
            </Button>
          </div>
        )}

        {items !== null && (
          <>
            {filter !== 'resolved' && diagList.length > 0 && (
              <section className="mb-3" data-testid="latex-issues-diag">
                <div className="mb-1 px-0.5 text-2xs font-medium text-fg-muted">编译错误（{diagList.length}）</div>
                <ul className="space-y-0.5">
                  {diagList.map((d, i) => (
                    <li key={`d${i}`} className="group/diag relative">
                      <button
                        type="button"
                        className="w-full rounded-md px-1.5 py-1 text-left leading-4 text-danger transition-colors hover:bg-danger/10"
                        title={`${d.file}:${d.line ?? '?'} — ${d.message}（点击跳转）`}
                        onClick={() => onJump(d.file.replace(/^\.\//, ''), d.line)}
                        data-testid={`latex-issue-diag-${i}`}
                      >
                        <span className="block truncate font-mono text-2xs opacity-80">
                          {d.file.replace(/^\.\//, '')}{d.line != null ? `:${d.line}` : ''}
                        </span>
                        <span className="block break-words">{d.message}</span>
                      </button>
                      {proposeFix && (
                        <button
                          type="button"
                          className="absolute right-1 top-1 rounded p-0.5 text-fg-muted opacity-0 transition-opacity hover:bg-hover hover:text-primary group-hover/diag:opacity-100"
                          title="让 AI 生成修复提案（仅外发该错误行±上下文与错误信息）"
                          aria-label="生成修复提案"
                          onClick={(e) => { e.stopPropagation(); proposeFix(d) }}
                          data-testid={`latex-issue-proposefix-${i}`}
                        >
                          <Sparkles aria-hidden className="size-3" />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <ul className="space-y-1.5">
              {visible.map((t) => {
                const resolved = t.status === 'resolved'
                return (
                  <li
                    key={t.id}
                    className={cn('group rounded-lg border border-line bg-panel p-2 shadow-sm transition-colors hover:border-border-strong',
                      resolved && 'opacity-70')}
                    data-testid={`latex-issue-${t.id}`}
                  >
                    <div className="flex items-start gap-1.5">
                      <input
                        type="checkbox" className="mt-0.5 accent-primary" checked={resolved}
                        onChange={() => void toggle(t)}
                        aria-label={resolved ? '重新打开' : '标记已解决'}
                        data-testid={`latex-issue-toggle-${t.id}`}
                      />
                      <div className="min-w-0 flex-1">
                        <p className={cn('whitespace-pre-wrap break-words leading-4', resolved && 'text-fg-muted line-through')}>{t.message}</p>
                        {t.file && (
                          <button
                            type="button"
                            className="mt-1 inline-block max-w-full truncate rounded bg-sunken px-1 py-px font-mono text-2xs text-fg-muted transition-colors hover:text-fg"
                            title={t.line != null ? `${t.file}:${t.line}（点击跳转）` : `${t.file}（点击打开）`}
                            onClick={() => onJump(t.file!, t.line)}
                          >
                            {t.file}{t.line != null ? `:${t.line}` : ''}
                          </button>
                        )}
                      </div>
                      <button
                        type="button"
                        className="shrink-0 rounded p-0.5 text-fg-muted opacity-0 transition-opacity hover:bg-hover hover:text-fg group-hover:opacity-100"
                        onClick={() => void remove(t)} aria-label="删除 Issue" data-testid={`latex-issue-del-${t.id}`}
                      >
                        <Trash2 aria-hidden className="size-3" />
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>

            {visible.length === 0 && diagList.length === 0 && (
              <div className="px-2 py-8 text-center text-fg-muted" data-testid="latex-issues-empty">
                {filter === 'resolved'
                  ? '还没有已解决的 Issue。'
                  : (
                    <>
                      <p>暂无 Issue。</p>
                      <p className="mt-1 text-2xs">编译错误会自动出现在这里；点右上 + 手动记录讨论与待办。</p>
                    </>
                  )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

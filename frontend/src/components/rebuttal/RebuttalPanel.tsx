import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Download, FileUp, Loader2, LocateFixed, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  rebuttalApi,
  type RebuttalExportFormat,
  type RebuttalItem,
  type RebuttalLocation,
  type RebuttalMode,
  type RebuttalRoundDetail,
  type RebuttalRoundSummary,
  type RebuttalSnapshot,
  type RebuttalState,
  type RebuttalStatus,
} from '@/lib/api/rebuttal'
import { commentsApi } from '@/lib/api/comments'
import { historyApi } from '@/lib/api/history'
import { wordApi } from '@/lib/api/word'
import type { Version } from '@/lib/types'
import { downloadFile } from '@/lib/download'
import { useStudio, selectAiEnabled } from '@/store'

/**
 * 审稿回复信面板（P1-1，LaTeX 工作台右侧「回复信」）：
 * 粘贴 / 上传审稿意见（.txt/.md/.pdf）→ 确定性拆条（多审稿人 + 重大/次要/编辑性启发式）→
 * 逐条状态（待处理/草稿/已修改）·作者回复·修改位置（可关联当前光标、一键跳转）跟踪 →
 * AI 起草「建议回复」→ 作者确认采纳后手动填入回复框 → 一键导出 Response Letter（DOCX/TeX/MD）。
 * 契约：AI 只写 ai_draft 建议，绝不自动覆盖用户回复，也绝不改稿件文件；AI 未开启时禁用并明确提示。
 */

const STATUS_ZH: Record<RebuttalStatus, string> = { todo: '待处理', drafted: '草稿', addressed: '已修改' }
const CATEGORY_ZH: Record<string, string> = { major: '重大', minor: '次要', editorial: '编辑性', general: '一般' }
const STATUSES: RebuttalStatus[] = ['todo', 'drafted', 'addressed']
const EXPORTS: { fmt: RebuttalExportFormat; label: string }[] = [
  { fmt: 'docx', label: 'DOCX' },
  { fmt: 'tex', label: 'TeX' },
  { fmt: 'md', label: 'MD' },
]

const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

interface ItemForm {
  status: RebuttalStatus
  response: string
  editsSummary: string
  location: RebuttalLocation
}

const formOf = (it: RebuttalItem): ItemForm => ({
  status: it.status,
  response: it.response,
  editsSummary: it.edits_summary,
  location: { ...(it.location ?? {}) },
})

function StatusBadge({ status }: { status: RebuttalStatus }) {
  if (status === 'addressed') return <span className="rounded bg-ok/10 px-1.5 py-0.5 text-2xs text-ok">已修改</span>
  if (status === 'drafted') return <span className="rounded bg-primary-soft px-1.5 py-0.5 text-2xs text-primary">草稿</span>
  return <span className="rounded bg-sunken px-1.5 py-0.5 text-2xs text-fg-muted">待处理</span>
}

const Pill = ({
  active,
  onClick,
  children,
  testid,
  title,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
  testid?: string
  title?: string
}) => (
  <button
    type="button"
    aria-pressed={active}
    title={title}
    data-testid={testid}
    className={cn(
      'rounded-full px-2 py-0.5 text-2xs transition-colors',
      active ? 'bg-primary-soft font-medium text-primary' : 'text-fg-muted hover:bg-hover hover:text-fg',
    )}
    onClick={onClick}
  >
    {children}
  </button>
)

const fieldCls = 'w-full rounded-md border border-line bg-app p-2 text-xs leading-5'

/** B3 工程锚点关联器：LaTeX 读 /comments + /latex/history；Word 模式不调 /comments，改挂 Word 版本列表。
 *  变更即时 PATCH（comment_ids / snapshot），锚点格式校验由后端白名单承担。 */
function AnchorPicker({ pid, mode, item, canEdit, onChanged }: {
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
      commentsApi.comments(pid).then((cs) => {
        if (alive) setComments((cs as unknown as { id: string; body?: string }[]).filter((c) => c.id).slice(0, 30))
      }).catch(() => { if (alive) setComments([]) })
      historyApi.history(pid).then((vs) => {
        if (alive) setVersions((vs as Version[]).filter((v) => v.sha).map((v) => ({ value: String(v.sha), label: `${String(v.sha).slice(0, 10)} · ${new Date(v.at).toLocaleString('zh-CN')}`, sha: String(v.sha) })))
      }).catch(() => { if (alive) setVersions([]) })
    } else {
      wordApi.state(pid).then((st) => {
        if (alive) setVersions((st.versions ?? []).map((v) => ({ value: v.id, label: `${v.id} · ${new Date(v.created_at).toLocaleString('zh-CN')}`, sha: v.sha })))
      }).catch(() => { if (alive) setVersions([]) })
    }
    return () => { alive = false }
  }, [pid, mode])

  async function applySnapshot(snap: RebuttalSnapshot | null) {
    try {
      await rebuttalApi.updateItem(pid, item.id, { snapshot: snap })
      onChanged()
    } catch (e) { setErr(msgOf(e)) }
  }

  async function toggleComment(cid: string) {
    const next = (item.comment_ids ?? []).includes(cid)
      ? (item.comment_ids ?? []).filter((x) => x !== cid)
      : [...(item.comment_ids ?? []), cid]
    try {
      await rebuttalApi.updateItem(pid, item.id, { comment_ids: next })
      onChanged()
    } catch (e) { setErr(msgOf(e)) }
  }

  const snap = item.snapshot ?? null
  const ids = item.comment_ids ?? []
  return (
    <div className="space-y-1 rounded-md border border-line p-2" data-testid="rebuttal-anchors">
      <span className="text-2xs text-fg-muted">工程锚点</span>
      {err && <p role="alert" className="text-2xs text-danger">{err}</p>}
      {mode === 'latex' && comments !== null && (
        <div>
          <p className="text-2xs text-fg-muted">关联批注（平台批注线程）</p>
          {comments.length === 0 && <p className="text-2xs text-fg-muted">工程内暂无批注线程。</p>}
          {comments.slice(0, 12).map((c) => (
            <label key={c.id} className="flex items-center gap-1 py-0.5">
              <input type="checkbox" disabled={!canEdit} checked={ids.includes(c.id)}
                onChange={() => void toggleComment(c.id)} data-testid={`rebuttal-anchor-comment-${c.id}`} />
              <span className="truncate font-mono text-2xs">{c.id}</span>
              <span className="truncate text-2xs text-fg-muted">{(c.body ?? '').slice(0, 30)}</span>
            </label>
          ))}
        </div>
      )}
      <div>
        <p className="text-2xs text-fg-muted">{mode === 'word' ? '关联 Word 版本快照' : '关联 LaTeX 历史快照'}</p>
        <select
          className={cn(fieldCls, 'py-1')}
          value={snap ? (snap.vid || snap.sha) : ''}
          disabled={!canEdit}
          onChange={(e) => {
            const v = e.target.value
            if (!v) return void applySnapshot(null)
            // sha 取查表完整值（vid 的尾部切片会短于后端 12..64 hex 白名单而 422）
            if (mode === 'word') {
              const hit = (versions ?? []).find((x) => x.value === v)
              return void applySnapshot({ type: 'word-version', sha: hit?.sha ?? '', vid: v })
            }
            const sha = v
            void applySnapshot({ type: 'latex-history', sha })
          }}
          data-testid="rebuttal-anchor-snapshot"
        >
          <option value="">未关联快照</option>
          {(versions ?? []).map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
        </select>
      </div>
    </div>
  )
}


export function RebuttalPanel({
  pid,
  canEdit,
  activeFile,
  cursorLine,
  onJump,
  mode = 'latex',
}: {
  pid: string
  canEdit: boolean
  activeFile: string | null
  cursorLine: number | null
  onJump: (file: string, line: number) => void
  /** B3：word 模式不调 /comments、无源码跳转，快照锚点改挂 Word 版本列表。 */
  mode?: 'latex' | 'word'
}) {
  const aiEnabled = useStudio(selectAiEnabled)
  const [state, setState] = useState<RebuttalState | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [banner, setBanner] = useState('')
  const [notice, setNotice] = useState<string | null>(null)

  // 导入
  const [importText, setImportText] = useState('')
  const [importMode, setImportMode] = useState<RebuttalMode>('replace')
  const [importing, setImporting] = useState(false)

  // 筛选 + 选中
  const [reviewer, setReviewer] = useState<string>('')
  const [status, setStatus] = useState<RebuttalStatus | ''>('')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [form, setForm] = useState<ItemForm | null>(null)
  const [dirty, setDirty] = useState(false)

  const [saving, setSaving] = useState(false)
  const [aiBusy, setAiBusy] = useState(false)
  const [exportFmt, setExportFmt] = useState<RebuttalExportFormat | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  // B3 多轮：历史轮只读切换（不做 restore）
  const [rounds, setRounds] = useState<RebuttalRoundSummary[]>([])
  const [viewRound, setViewRound] = useState<'current' | number>('current')
  const [roundDetail, setRoundDetail] = useState<RebuttalRoundDetail | null>(null)

  const load = useCallback(async () => {
    try {
      const st = await rebuttalApi.load(pid)
      setState(st)
      setLoadFailed(false)
    } catch (e) {
      setBanner(msgOf(e))
      setLoadFailed(true)
    }
    try {
      setRounds((await rebuttalApi.rounds(pid)).rounds)
    } catch {
      setRounds([]) // 旧镜像无端点：静默
    }
  }, [pid])

  useEffect(() => {
    void load()
  }, [load])

  const openRound = async (n: 'current' | number) => {
    setViewRound(n)
    if (n === 'current') {
      setRoundDetail(null)
      return
    }
    try {
      setRoundDetail(await rebuttalApi.round(pid, n))
    } catch (e) {
      setBanner(msgOf(e))
    }
  }

  const items = state?.items ?? []
  const reviewers = useMemo(() => [...new Set((state?.items ?? []).map((it) => it.reviewer))], [state])
  const addressed = items.filter((it) => it.status === 'addressed').length

  const visible = useMemo(
    () =>
      (state?.items ?? []).filter((it) => (!reviewer || it.reviewer === reviewer) && (!status || it.status === status)),
    [state, reviewer, status],
  )
  const selected = items.find((it) => it.id === activeId) ?? null

  // 仅在切换选中条目（activeId 变化）时回填表单；状态 quick-switch / AI 起草更新服务端 updated_at 时
  // 不得重置表单，避免覆盖用户尚未点击保存的回复草稿。
  useEffect(() => {
    if (selected) {
      setForm(formOf(selected))
      setDirty(false)
      setNotice(null)
    } else {
      setForm(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])

  const patchForm = (patch: Partial<ItemForm>) => {
    setForm((f) => (f ? { ...f, ...patch } : f))
    setDirty(true)
  }

  const doImport = async (fn: () => Promise<{ items: RebuttalItem[]; warnings: string[]; round: number }>) => {
    setImporting(true)
    setBanner('')
    try {
      const r = await fn()
      setState((s) => ({ ...(s ?? { updated_at: null, round: 0, items: [], warnings: [] }), ...r }))
      setReviewer('')
      setStatus('')
      setActiveId(null)
      // B3：replace 可能刚归档上一轮——即时刷新轮次栏并回到当前轮，确保新归档入口立即可见
      try {
        setRounds((await rebuttalApi.rounds(pid)).rounds)
      } catch { /* 旧镜像无端点：静默 */ }
      setViewRound('current')
      setRoundDetail(null)
      if (r.warnings.length) setNotice(r.warnings.join('；'))
    } catch (e) {
      setBanner(msgOf(e))
    } finally {
      setImporting(false)
    }
  }

  const importPasted = () => {
    if (!importText.trim() || importing) return
    void doImport(() => rebuttalApi.parse(pid, importText, importMode))
  }

  const importFile = (f: File | undefined) => {
    if (!f || importing) return
    void doImport(() => rebuttalApi.parseFile(pid, f, importMode))
  }

  const saveItem = async () => {
    if (!selected || !form || !canEdit) return
    setSaving(true)
    setBanner('')
    try {
      const it = await rebuttalApi.updateItem(pid, selected.id, {
        status: form.status,
        response: form.response,
        edits_summary: form.editsSummary,
        location: form.location,
      })
      setState((s) => (s ? { ...s, items: s.items.map((x) => (x.id === it.id ? it : x)) } : s))
      setDirty(false)
    } catch (e) {
      setBanner(msgOf(e))
    } finally {
      setSaving(false)
    }
  }

  const switchStatus = async (next: RebuttalStatus) => {
    if (!selected || !canEdit) return
    setForm((f) => (f ? { ...f, status: next } : f))
    setBanner('')
    try {
      const it = await rebuttalApi.updateItem(pid, selected.id, { status: next })
      setState((s) => (s ? { ...s, items: s.items.map((x) => (x.id === it.id ? it : x)) } : s))
    } catch (e) {
      setBanner(msgOf(e))
    }
  }

  const runDraft = async () => {
    if (!selected || !canEdit || !aiEnabled || aiBusy) return
    setAiBusy(true)
    setBanner('')
    try {
      const r = await rebuttalApi.draft(pid, selected.id)
      setState((s) => (s ? { ...s, items: s.items.map((x) => (x.id === r.item.id ? r.item : x)) } : s))
      setNotice(r.warnings.length ? r.warnings.join('；') : null)
    } catch (e) {
      setBanner(msgOf(e))
    } finally {
      setAiBusy(false)
    }
  }

  const adoptDraft = () => {
    const draft = selected?.ai_draft
    if (!draft) return
    patchForm({ response: draft.response_draft, editsSummary: draft.edits_summary_draft || form?.editsSummary || '' })
  }

  const linkCursor = () => {
    if (!activeFile || cursorLine == null) return
    patchForm({ location: { ...(form?.location ?? {}), file: activeFile, line: cursorLine } })
  }

  const doExport = async (fmt: RebuttalExportFormat) => {
    if (exportFmt) return
    setExportFmt(fmt)
    setBanner('')
    try {
      await downloadFile(rebuttalApi.exportUrl(pid, fmt), `response-letter.${fmt}`)
    } catch (e) {
      setBanner(msgOf(e)) // 409（尚无回复）等业务错误清晰展示，不静默吞错
    } finally {
      setExportFmt(null)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel" data-testid="rebuttal-panel">
      {/* 顶栏：标题 + 进度 + 导出 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-fg" data-testid="rebuttal-progress">
            回复信 {items.length > 0 && <span className="text-fg-muted">已修改 {addressed} / 总 {items.length} 条{state && state.round > 0 ? ` · 第 ${state.round} 轮` : ''}</span>}
          </p>
        </div>
        <div className="flex items-center gap-0.5">
          {EXPORTS.map(({ fmt, label }) => (
            <Button
              key={fmt}
              variant="ghost"
              size="icon-xs"
              disabled={items.length === 0 || exportFmt !== null}
              onClick={() => void doExport(fmt)}
              aria-label={`导出 ${label} 回复信`}
              title={`导出 ${label} 回复信`}
              data-testid={`rebuttal-export-${fmt}`}
            >
              {exportFmt === fmt ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : <Download aria-hidden className="size-3.5" />}
            </Button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-2 text-xs">
        {banner && (
          <p role="alert" className="mb-2 rounded-md bg-danger/10 px-2 py-1.5 text-2xs text-danger" data-testid="rebuttal-error">
            {banner}
          </p>
        )}
        {notice && (
          <p className="mb-2 rounded-md bg-info-bg px-2 py-1.5 text-2xs text-info-fg" data-testid="rebuttal-notice">
            {notice}
          </p>
        )}

        {/* B3 轮次切换：当前活跃轮 + 历史轮（只读，不做 restore） */}
        {(rounds.length > 0 || viewRound !== 'current') && (
          <div className="mb-2 flex flex-wrap items-center gap-1" data-testid="rebuttal-rounds">
            <button
              type="button"
              className={cn('rounded px-1.5 py-0.5 text-2xs', viewRound === 'current' ? 'bg-primary-soft text-primary' : 'bg-sunken text-fg-muted hover:text-fg')}
              onClick={() => void openRound('current')}
              data-testid="rebuttal-round-current"
            >
              第 {state?.round ?? 1} 轮（当前）
            </button>
            {rounds.map((r) => (
              <button
                key={r.round}
                type="button"
                className={cn('rounded px-1.5 py-0.5 text-2xs', viewRound === r.round ? 'bg-primary-soft text-primary' : 'bg-sunken text-fg-muted hover:text-fg')}
                onClick={() => void openRound(r.round)}
                title={`第 ${r.round} 轮归档（${r.items} 条，只读）`}
                data-testid={`rebuttal-round-${r.round}`}
              >
                第 {r.round} 轮
              </button>
            ))}
          </div>
        )}

        {viewRound !== 'current' && roundDetail ? (
          /* ---------- 历史轮只读视图 ---------- */
          <div className="space-y-2" data-testid="rebuttal-round-readonly">
            <p className="text-2xs text-fg-muted">第 {roundDetail.round} 轮归档（只读；不提供恢复到当前）</p>
            {roundDetail.items.map((it) => (
              <div key={it.id} className="rounded-md border border-line p-2">
                <div className="flex items-center gap-1">
                  <span className="font-mono text-2xs text-fg-muted">{it.id}</span>
                  <span className="text-2xs text-fg-muted">{it.reviewer}</span>
                  <StatusBadge status={it.status} />
                </div>
                <p className="mt-1 whitespace-pre-wrap leading-5">{it.text}</p>
                {it.response && <p className="mt-1 whitespace-pre-wrap rounded bg-sunken p-1.5 leading-5">{it.response}</p>}
                {it.edits_summary && <p className="mt-1 text-2xs text-fg-muted">Changes: {it.edits_summary}</p>}
                {(it.comment_ids?.length || it.snapshot) && (
                  <p className="mt-1 text-2xs text-fg-muted">
                    锚点：{it.comment_ids?.length ? `批注 ${it.comment_ids.length} 条` : ''}
                    {it.comment_ids?.length && it.snapshot ? '；' : ''}
                    {it.snapshot ? `快照 ${it.snapshot.type} ${it.snapshot.vid || it.snapshot.sha.slice(0, 12)}` : ''}
                  </p>
                )}
              </div>
            ))}
          </div>
        ) : (
        <>
        {selected && form ? (
          /* ---------- 条目详情 ---------- */
          <div className="space-y-2" data-testid="rebuttal-detail">
            <button
              type="button"
              className="flex items-center gap-1 text-2xs text-fg-muted hover:text-fg"
              onClick={() => setActiveId(null)}
              data-testid="rebuttal-back"
            >
              <ArrowLeft aria-hidden className="size-3" /> 返回列表
            </button>
            <p className="flex items-center gap-1.5">
              <span className="rounded bg-primary-soft px-1.5 py-0.5 text-2xs text-primary">{selected.reviewer}</span>
              <span className="rounded bg-sunken px-1.5 py-0.5 text-2xs text-fg-muted">
                {CATEGORY_ZH[selected.category] ?? selected.category}
              </span>
              <span className="ml-auto text-2xs text-fg-muted">{selected.id}</span>
            </p>
            <blockquote className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-sunken p-2 leading-5 text-fg-muted">
              {selected.text}
            </blockquote>

            <div className="flex items-center gap-1">
              <span className="text-2xs text-fg-muted">状态</span>
              {STATUSES.map((st) => (
                <Pill
                  key={st}
                  active={form.status === st}
                  onClick={() => void switchStatus(st)}
                  testid={`rebuttal-status-${st}`}
                >
                  {STATUS_ZH[st]}
                </Pill>
              ))}
            </div>

            <label className="block space-y-1">
              <span className="text-2xs text-fg-muted">作者回复</span>
              <textarea
                className={cn(fieldCls, 'max-h-56 min-h-24 resize-y')}
                value={form.response}
                disabled={!canEdit}
                placeholder="针对该条意见的回复（礼貌、逐点、可核查）…"
                onChange={(e) => patchForm({ response: e.target.value })}
                data-testid="rebuttal-response-input"
              />
            </label>

            <label className="block space-y-1">
              <span className="text-2xs text-fg-muted">修改摘要</span>
              <input
                className={fieldCls}
                value={form.editsSummary}
                disabled={!canEdit}
                placeholder="对应修改了什么（用于导出信中的 Changes）"
                onChange={(e) => patchForm({ editsSummary: e.target.value })}
                data-testid="rebuttal-edits-input"
              />
            </label>

            <div className="space-y-1">
              <span className="text-2xs text-fg-muted">修改位置</span>
              <div className="grid grid-cols-2 gap-1">
                <input
                  className={fieldCls}
                  value={form.location.file ?? ''}
                  disabled={!canEdit}
                  placeholder="文件（main.tex）"
                  onChange={(e) => patchForm({ location: { ...form.location, file: e.target.value || null } })}
                  data-testid="rebuttal-loc-file"
                />
                <input
                  className={fieldCls}
                  type="number"
                  min={1}
                  value={form.location.line ?? ''}
                  disabled={!canEdit}
                  placeholder="行号"
                  onChange={(e) =>
                    patchForm({ location: { ...form.location, line: e.target.value ? Number(e.target.value) : null } })
                  }
                  data-testid="rebuttal-loc-line"
                />
                <input
                  className={fieldCls}
                  value={form.location.section ?? ''}
                  disabled={!canEdit}
                  placeholder="章节 / 小节"
                  onChange={(e) => patchForm({ location: { ...form.location, section: e.target.value || null } })}
                  data-testid="rebuttal-loc-section"
                />
                <input
                  className={fieldCls}
                  value={form.location.label ?? ''}
                  disabled={!canEdit}
                  placeholder="图表 / 公式标记"
                  onChange={(e) => patchForm({ location: { ...form.location, label: e.target.value || null } })}
                  data-testid="rebuttal-loc-label"
                />
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="xs"
                  disabled={!canEdit || !activeFile || cursorLine == null}
                  onClick={linkCursor}
                  title={activeFile ? `关联当前光标：${activeFile} 第 ${cursorLine} 行` : '先在编辑器中打开文件'}
                  data-testid="rebuttal-link-cursor"
                >
                  <LocateFixed aria-hidden className="size-3.5" />
                  关联当前光标位置
                </Button>
                {form.location.file && form.location.line ? (
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => onJump(form.location.file as string, form.location.line as number)}
                    data-testid="rebuttal-jump"
                  >
                    跳转
                  </Button>
                ) : null}
              </div>
            </div>

            <AnchorPicker pid={pid} mode={mode} item={selected} canEdit={canEdit} onChanged={() => void load()} />

            <div className="space-y-1 rounded-md border border-line p-2" data-testid="rebuttal-ai-area">
              <div className="flex items-center gap-1">
                <Button
                  variant="soft"
                  size="xs"
                  disabled={!canEdit || !aiEnabled || aiBusy}
                  onClick={() => void runDraft()}
                  title={aiEnabled ? '生成 AI 回复建议（仅写入草稿建议，不改动你的回复）' : 'AI 未开启：请先在 AI 面板开启「允许外发」'}
                  data-testid="rebuttal-ai-draft"
                >
                  {aiBusy ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : <Sparkles aria-hidden className="size-3.5" />}
                  AI 起草回复
                </Button>
                {!aiEnabled && <span className="text-2xs text-fg-muted">AI 未开启 · 不可用</span>}
              </div>
              {selected.ai_draft && (
                <div className="space-y-1">
                  <p className="whitespace-pre-wrap rounded-md bg-sunken p-2 leading-5 text-fg-muted" data-testid="rebuttal-ai-preview">
                    {selected.ai_draft.response_draft}
                    {selected.ai_draft.edits_summary_draft ? (
                      <>
                        {'\n'}
                        <span className="text-2xs">修改摘要建议：{selected.ai_draft.edits_summary_draft}</span>
                      </>
                    ) : null}
                  </p>
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={!canEdit}
                    onClick={adoptDraft}
                    title="把 AI 草稿填入上方回复框，确认修改后再保存"
                    data-testid="rebuttal-adopt-ai"
                  >
                    采纳 AI 草稿填入回复框
                  </Button>
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-1">
              {dirty && <span className="text-2xs text-fg-muted">未保存</span>}
              <Button variant="primary" size="xs" disabled={!canEdit || !dirty || saving} onClick={() => void saveItem()} data-testid="rebuttal-save">
                {saving ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : null}
                保存回复
              </Button>
            </div>
          </div>
        ) : (
          /* ---------- 导入 + 列表 ---------- */
          <div className="space-y-2">
            <div className="space-y-1 rounded-md border border-line p-2" data-testid="rebuttal-import">
              <textarea
                className={cn(fieldCls, 'min-h-20 resize-y')}
                value={importText}
                disabled={!canEdit || importing}
                placeholder="粘贴审稿意见全文（识别 Reviewer #/Comment N/1. 等结构，多审稿人自动分组）…"
                onChange={(e) => setImportText(e.target.value)}
                data-testid="rebuttal-import-text"
              />
              <div className="flex items-center gap-1">
                <Pill active={importMode === 'replace'} onClick={() => setImportMode('replace')} testid="rebuttal-mode-replace" title="替换现有条目并进入下一轮">
                  替换
                </Pill>
                <Pill active={importMode === 'append'} onClick={() => setImportMode('append')} testid="rebuttal-mode-append" title="保留现有条目，追加导入">
                  追加
                </Pill>
                <span className="flex-1" />
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={!canEdit || importing}
                  onClick={() => fileInputRef.current?.click()}
                  title="上传 .txt / .md / .pdf（扫描件无文字层将明确报错）"
                  data-testid="rebuttal-import-file"
                >
                  <FileUp aria-hidden className="size-3.5" />
                  上传
                </Button>
                <Button
                  variant="primary"
                  size="xs"
                  disabled={!canEdit || importing || !importText.trim()}
                  onClick={() => void importPasted()}
                  data-testid="rebuttal-import-submit"
                >
                  {importing ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : null}
                  拆条导入
                </Button>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,.md,.markdown,.pdf"
                className="hidden"
                onChange={(e) => {
                  importFile(e.target.files?.[0])
                  e.target.value = ''
                }}
                data-testid="rebuttal-file-input"
              />
            </div>

            {state?.warnings && state.warnings.length > 0 && (
              <p className="rounded-md bg-info-bg px-2 py-1.5 text-2xs text-info-fg">{state.warnings.join('；')}</p>
            )}

            {items.length > 0 && (
              <div className="flex flex-wrap items-center gap-1" role="group" aria-label="筛选">
                <Pill active={reviewer === ''} onClick={() => setReviewer('')} testid="rebuttal-reviewer-all">
                  全部审稿人
                </Pill>
                {reviewers.map((r) => (
                  <Pill key={r} active={reviewer === r} onClick={() => setReviewer(r)}>
                    {r}
                  </Pill>
                ))}
                <span className="mx-0.5 h-4 w-px bg-line" aria-hidden />
                <Pill active={status === ''} onClick={() => setStatus('')} testid="rebuttal-status-all">
                  全部状态
                </Pill>
                {STATUSES.map((st) => (
                  <Pill key={st} active={status === st} onClick={() => setStatus(st)} testid={`rebuttal-filter-${st}`}>
                    {STATUS_ZH[st]}
                  </Pill>
                ))}
              </div>
            )}

            {state === null && !loadFailed && <p className="p-2 text-fg-muted">加载中…</p>}
            {loadFailed && items.length === 0 && (
              <div className="flex items-center gap-2 p-2">
                <span className="text-fg-muted">加载失败。</span>
                <Button variant="outline" size="xs" onClick={() => void load()} data-testid="rebuttal-retry">
                  重试
                </Button>
              </div>
            )}
            {items.length === 0 && state !== null && (
              <div className="px-2 py-6 text-center text-fg-muted" data-testid="rebuttal-empty">
                暂无审稿意见条目——粘贴或上传评审意见开始。
              </div>
            )}

            <ul className="space-y-1.5">
              {visible.map((it) => (
                <li key={it.id}>
                  <button
                    type="button"
                    className="w-full rounded-lg border border-line bg-panel p-2 text-left transition-colors hover:border-border-strong"
                    onClick={() => setActiveId(it.id)}
                    data-testid={`rebuttal-item-${it.id}`}
                  >
                    <span className="mb-1 flex items-center gap-1.5">
                      <span className="rounded bg-primary-soft px-1.5 py-0.5 text-2xs text-primary">{it.reviewer}</span>
                      <span className="rounded bg-sunken px-1.5 py-0.5 text-2xs text-fg-muted">
                        {CATEGORY_ZH[it.category] ?? it.category}
                      </span>
                      <span className="ml-auto">
                        <StatusBadge status={it.status} />
                      </span>
                    </span>
                    <span className="line-clamp-2 text-fg-muted">{it.text}</span>
                    {it.response && <span className="mt-1 block line-clamp-1 text-fg">回复：{it.response}</span>}
                  </button>
                </li>
              ))}
            </ul>
            {items.length > 0 && visible.length === 0 && (
              <p className="px-2 py-4 text-center text-fg-muted" data-testid="rebuttal-filter-empty">
                当前筛选下暂无条目。
              </p>
            )}
          </div>
        )}
        </>
        )}
      </div>
    </div>
  )
}

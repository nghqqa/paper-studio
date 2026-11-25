import { useEffect, useMemo, useRef, useState } from 'react'
import { Archive, ArrowDownUp, BookOpen, CalendarDays, Check, ChevronDown, Columns3, Download, FileText, Filter, FolderOpen, Grid2X2, Image, Kanban, LayoutTemplate, List, Loader2, Pencil, Plus, Rows3, Search, Sparkles, Tag, Trash2, UserRound, Users, X } from 'lucide-react'
import { UserMenu } from '@/components/auth/UserMenu'
import { ScientificFigures } from '@/components/figures/ScientificFigures'
import { NewPaperProjectDialog } from '@/components/shell/NewPaperProjectDialog'
import { Toasts } from '@/components/shell/Toasts'
import { ImportDialog } from '@/components/latex/ImportDialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { BRAND_NAME, pageTitle } from '@/lib/brand'
import { csvDateStamp, downloadCsv, toCsv } from '@/lib/csv'
import { downloadFile } from '@/lib/download'
import { latexApi } from '@/lib/api/latex'
import { wordApi } from '@/lib/api/word'
import { fmtRelative, fmtRelativeWords, fmtFull } from '@/lib/format'
import { projectHash } from '@/lib/hash'
import type { ProjectSummary } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useStudio, type DashScope } from '@/store'
import { RowActions } from './RowActions'
import { PaperProjectInfo } from './PaperProjectInfo'
import { deadlineDays, formatLabel, groupPaperRows, PAPER_STAGES, paperOwner, paperOwnerKey, paperStage, paperTags, sortPaperRows, stageLabel, type PaperGroup, type PaperSort } from './paperProjects'
import './paper-dashboard.css'

type Area = 'projects' | 'venues' | 'figures'
type Quick = '' | 'soon' | 'overdue' | 'missing'
const SCOPES: { id: DashScope; label: string; icon: typeof Grid2X2 }[] = [
  { id: 'all', label: '所有项目', icon: Grid2X2 }, { id: 'mine', label: '我的项目', icon: UserRound },
  { id: 'shared', label: '与我共享', icon: Users }, { id: 'archived', label: '归档项目', icon: Archive }, { id: 'trash', label: '回收站', icon: Trash2 },
]
const COLUMNS = [
  { id: 'stage', label: '写作阶段' }, { id: 'owner', label: '负责人' }, { id: 'venue', label: '投稿目标' },
  { id: 'field', label: '学科领域' }, { id: 'rank', label: '等级分区' },
  { id: 'deadline', label: '投稿截止' }, { id: 'tags', label: '标签' }, { id: 'modified', label: '最后修改' },
] as const
type Column = typeof COLUMNS[number]['id']
type Columns = Record<Column, boolean>
const DEFAULT_COLUMNS: Columns = { stage: true, owner: true, venue: true, field: false, rank: false, deadline: true, tags: false, modified: true }
const PREFS_KEY = 'paper-project-view-v2'
function readPreferences(): { compact: boolean; columns: Columns } {
  try {
    const stored = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}')
    return { compact: stored.compact === true, columns: Object.fromEntries(COLUMNS.map(({ id }) => [id, typeof stored.columns?.[id] === 'boolean' ? stored.columns[id] : DEFAULT_COLUMNS[id]])) as Columns }
  } catch { return { compact: false, columns: DEFAULT_COLUMNS } }
}

/** Independent of legacy board stages, tags and view preferences. */
export function paperScopeRows(projects: ProjectSummary[], scope: DashScope, authOff: boolean): ProjectSummary[] {
  return projects.filter((p) => {
    const state = p.list_state ?? 'active'
    if (scope === 'archived') return state === 'archived'
    if (scope === 'trash') return state === 'trashed'
    if (state !== 'active') return false
    if (scope === 'mine') return authOff || p.my_role === 'owner'
    if (scope === 'shared') return !authOff && p.my_role != null && p.my_role !== 'owner'
    return true
  })
}
function Format({ row }: { row: ProjectSummary }) { return <span className="paper-format" data-format={row.source_format}>{formatLabel(row)}</span> }
function Stage({ row }: { row: ProjectSummary }) { return <span className="paper-stage" data-stage={paperStage(row)}>{stageLabel(paperStage(row))}</span> }

export function PaperDashboard() {
  const projects = useStudio((s) => s.projects)
  const loading = useStudio((s) => s.dashLoading)
  const error = useStudio((s) => s.projectsError)
  const load = useStudio((s) => s.loadDashboard)
  const authOff = useStudio((s) => s.authStatus === 'off')
  const user = useStudio((s) => s.user)
  const dialog = useStudio((s) => s.dialog)
  const openDialog = useStudio((s) => s.openDialog)
  const closeDialog = useStudio((s) => s.closeDialog)
  const scope = useStudio((s) => s.dashScope)
  const setScope = useStudio((s) => s.setDashScope)
  const setListState = useStudio((s) => s.setListState)
  const deleteProject = useStudio((s) => s.deleteProject)
  const density = useStudio((s) => s.density)
  const setDensity = useStudio((s) => s.setDensity)
  const [area, setArea] = useState<Area>('projects')
  const [query, setQuery] = useState('')
  const [format, setFormat] = useState('all')
  const [stage, setStage] = useState('all')
  const [tag, setTag] = useState('')
  const [owner, setOwner] = useState('')
  const [quick, setQuick] = useState<Quick>('')
  const [sort, setSort] = useState<PaperSort>('recent')
  const [group, setGroup] = useState<PaperGroup>('none')
  const [viewPref, setView] = useState<'list' | 'board'>('list')
  // 看板=写作生命周期管理，只对活水项目有意义；归档/回收站是死态平铺列表，强制列表视图
  const boardable = scope !== 'archived' && scope !== 'trash'
  const view = boardable ? viewPref : 'list'
  // 密度联动（C2）：首次使用（从未写过本地偏好）时继承全局密度；已有本地偏好则本地优先。
  // 「紧凑」按钮双向写（本地 + 全局），账号页改密度经 effect 镜像回本地，两处始终一致。
  const [prefs, setPrefs] = useState(() => {
    if (localStorage.getItem(PREFS_KEY) === null) return { ...readPreferences(), compact: useStudio.getState().density === 'compact' }
    return readPreferences()
  })
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [editing, setEditing] = useState<ProjectSummary | null>(null)
  const search = useRef<HTMLInputElement>(null)
  const title = area === 'venues' ? '投稿计划' : area === 'figures' ? '科研图表' : SCOPES.find((s) => s.id === scope)!.label
  useEffect(() => { void load() }, [load])
  useEffect(() => { document.title = pageTitle(title) }, [title])
  useEffect(() => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)) } catch { /* optional preferences */ } }, [prefs])
  // 账号页等外部入口切换全局密度时，镜像到本页紧凑偏好（双向同步的另一半）。
  // prevRef 守卫：首渲染不镜像——本地已有偏好的老用户（compact=true + 全局 comfortable）
  // 不会被 mount 时的无关 effect 翻掉，只有密度真正变化后才跟随。
  const prevDensityRef = useRef(density)
  useEffect(() => {
    if (prevDensityRef.current === density) return
    prevDensityRef.current = density
    const compact = density === 'compact'
    setPrefs((p) => p.compact === compact ? p : { ...p, compact })
  }, [density])
  useEffect(() => {
    const focusSearch = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.isComposing || (e.target as Element)?.closest('input,textarea,select,[contenteditable="true"],[role="dialog"]')) return
      e.preventDefault(); search.current?.focus()
    }
    window.addEventListener('keydown', focusSearch)
    return () => window.removeEventListener('keydown', focusSearch)
  }, [])
  const base = paperScopeRows(projects, area === 'venues' ? 'all' : scope, authOff)
  const tags = [...new Set(base.flatMap(paperTags))].sort((a, b) => a.localeCompare(b, 'zh-CN'))
  const owners = [...new Map(base.map((r) => [paperOwnerKey(r, authOff), { key: paperOwnerKey(r, authOff), label: paperOwner(r, authOff) }])).values()]
  const matchesQuick = (r: ProjectSummary, value: Quick) => {
    const days = deadlineDays(r.submission?.deadline)
    if (value === 'missing') return !r.submission?.venue?.trim()
    if (!value) return true
    if (paperStage(r) === 'accepted' || days == null) return false
    return value === 'soon' ? days >= 0 && days <= 7 : days < 0
  }
  const rows = useMemo(() => sortPaperRows(base.filter((p) => {
    const q = query.trim().toLowerCase()
    return (!q || [p.title, p.submission?.venue, p.submission?.field, p.submission?.rank, ...paperTags(p)].some((x) => x?.toLowerCase().includes(q)))
      && (format === 'all' || p.source_format === format) && (stage === 'all' || paperStage(p) === stage)
      && (!tag || paperTags(p).includes(tag)) && (!owner || paperOwnerKey(p, authOff) === owner) && matchesQuick(p, quick)
  }), sort), [base, query, format, stage, tag, owner, quick, sort, authOff])
  const selectedRows = rows.filter((r) => selected.includes(r.id))
  const writable = (p: ProjectSummary) => authOff || ['owner', 'editor', 'agent'].includes(p.my_role ?? '')
  const hasFilters = !!(query || format !== 'all' || stage !== 'all' || tag || owner || quick)
  const columns = COLUMNS.filter((c) => prefs.columns[c.id])
  function clearFilters() { setQuery(''); setFormat('all'); setStage('all'); setTag(''); setOwner(''); setQuick(''); setSelected([]) }
  function showScope(value: DashScope) { setScope(value); setArea('projects'); clearFilters() }
  function showArea(value: Area) { setArea(value); if (value === 'venues') { setScope('all'); setSort('deadline') } else if (value === 'projects') { setSort('recent') } clearFilters() }
  function toggleSelected(id: string) { setSelected((value) => value.includes(id) ? value.filter((v) => v !== id) : [...value, id]) }
  function exportRows() {
    const value = (r: ProjectSummary, key: Column) =>
      key === 'stage' ? stageLabel(paperStage(r))
      : key === 'owner' ? paperOwner(r, authOff)
      : key === 'venue' ? r.submission?.venue
      : key === 'field' ? r.submission?.field
      : key === 'rank' ? r.submission?.rank
      : key === 'deadline' ? r.submission?.deadline
      : key === 'tags' ? paperTags(r).join('、')
      : new Date(r.mtime * 1000).toLocaleString('zh-CN')
    const safe = (v: string | undefined) => v && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v
    downloadCsv(`研稿-项目清单-${csvDateStamp()}`, toCsv(selectedRows.length ? selectedRows : rows, [
      { header: '论文名称', value: (r) => safe(r.title) }, { header: '文档类型', value: formatLabel },
      ...columns.map((c) => ({ header: c.label, value: (r: ProjectSummary) => safe(value(r, c.id)) })),
    ]))
  }
  async function deleteSelected() {
    if (!selectedRows.length || busy) return
    setBusy(true)
    let ok = true
    for (const row of selectedRows) {
      // 永久删除只在回收站视图提供（后端也要求项目在回收站中，否则 409）
      if (!(await deleteProject(row.id))) { ok = false; break }
    }
    if (ok) setSelected([])
    setBusy(false)
  }

  async function trashSelected() {
    if (busy || !selectedRows.length || selectedRows.some((r) => !writable(r))) return
    setBusy(true)
    try {
      const completed: string[] = []
      for (const row of selectedRows) if (await setListState(row.id, 'trashed')) completed.push(row.id)
      setSelected((ids) => ids.filter((id) => !completed.includes(id)))
    } finally { setBusy(false) }
  }

  async function archiveSelected() {
    if (busy || !selectedRows.length || selectedRows.some((r) => !writable(r))) return
    setBusy(true)
    try {
      const target = scope === 'archived' || scope === 'trash' ? 'active' : 'archived'
      const completed: string[] = []
      for (const row of selectedRows) if (await setListState(row.id, target)) completed.push(row.id)
      setSelected((ids) => ids.filter((id) => !completed.includes(id)))
    } finally { setBusy(false) }
  }
  async function downloadRow(row: ProjectSummary) {
    try {
      if (row.source_format === 'docx') {
        const saved = await wordApi.state(row.id)
        if (saved.last_error) throw new Error(saved.last_error)
        if (saved.saving) throw new Error('文档正在保存，请等待完成后再下载。')
        const version = [...saved.versions].reverse().find((v) => v.sha === saved.sha)
        if (!version) throw new Error('尚未找到已保存的 Word 版本，请打开项目确认保存后再下载。')
        await downloadFile(wordApi.versionDownloadUrl(row.id, version.id), `${row.title || row.id}.docx`)
        useStudio.getState().toast(`已发起服务器已保存版本 ${saved.version} 的下载；其他窗口尚未保存的修改不在其中。`, 'info')
      }
      else if (row.source_format === 'latex') {
        const reply = await latexApi.builds(row.id)
        if (!reply.latest_ok_build_id) throw new Error('暂无已成功编译的 PDF，请先编译')
        await downloadFile(`/api/projects/${encodeURIComponent(row.id)}/latex/builds/${reply.latest_ok_build_id}/artifacts/out.pdf`, `${row.title || row.id}.pdf`)
      } else {
        useStudio.getState().toast('该格式请打开项目工作台进行导出或下载', 'info')
      }
    } catch (e) { useStudio.getState().toast(e instanceof Error ? e.message : String(e), 'error') }
  }

  function rowActions(row: ProjectSummary) {
    const state = row.list_state ?? 'active'
    return <div className="paper-row-actions">
      <button disabled={!writable(row)} onClick={() => setEditing(row)} aria-label={`编辑 ${row.title} 的项目信息`} title="项目信息"><Pencil aria-hidden /></button>
      <button disabled={busy} onClick={() => void downloadRow(row)} aria-label={row.source_format === 'docx' ? `下载 ${row.title} 的已保存 Word 版本` : `下载 ${row.title}`} title={row.source_format === 'docx' ? '下载服务器已保存的 Word 版本；不含其他窗口尚未保存的修改' : '下载最近编译的 PDF'}><Download aria-hidden /></button>
      {scope !== 'archived' && scope !== 'trash' && state === 'active' && <button disabled={!writable(row)} onClick={() => void setListState(row.id, 'archived')} aria-label={`归档 ${row.title}`} title="归档"><Archive aria-hidden /></button>}
      {(scope === 'archived' || scope === 'trash') && <button disabled={!writable(row)} onClick={() => void setListState(row.id, scope === 'trash' ? 'active' : 'active')} aria-label={`恢复 ${row.title}`} title={scope === 'trash' ? '恢复到项目列表' : '取消归档'}><FolderOpen aria-hidden /></button>}
      {scope !== 'trash' && state === 'active' && <button disabled={!writable(row)} onClick={() => void setListState(row.id, 'trashed')} aria-label={`移到回收站 ${row.title}`} title="移到回收站"><Trash2 aria-hidden /></button>}
      {scope === 'archived' && <button disabled={!writable(row)} onClick={() => void setListState(row.id, 'trashed')} aria-label={`移入回收站 ${row.title}`} title="移入回收站"><Trash2 aria-hidden /></button>}
      {scope === 'trash' && <button disabled={busy} onClick={() => { if (confirm(`确认永久删除「${row.title || row.id}」？此操作不可恢复。`)) void deleteProject(row.id) }} aria-label={`永久删除 ${row.title}`} title="永久删除"><Trash2 aria-hidden /></button>}
      <RowActions row={row} canEdit={writable(row)} iconStates />
    </div>
  }
  function cell(row: ProjectSummary, id: Column) {
    if (id === 'stage') return <Stage row={row} />
    if (id === 'owner') { const ownerName = paperOwner(row, authOff); return <span className="paper-owner"><span className="paper-owner-avatar" aria-hidden>{ownerName === '—' ? '—' : ownerName.slice(0, 1)}</span>{ownerName}</span> }
    if (id === 'venue') return <span className="paper-venue" title={row.submission?.venue}>{row.submission?.venue || '—'}</span>
    if (id === 'field') return <span className="paper-venue" title={row.submission?.field}>{row.submission?.field || '—'}</span>
    if (id === 'rank') return <span className="paper-venue" title={row.submission?.rank}>{row.submission?.rank || '—'}</span>
    if (id === 'deadline') { const days = deadlineDays(row.submission?.deadline); return <span className="paper-date" data-urgent={days != null && days <= 7 && paperStage(row) !== 'accepted' || undefined}>{row.submission?.deadline || '—'}</span> }
    if (id === 'tags') return <span className="paper-tags">{paperTags(row).map((t) => <span key={t}>{t}</span>)}{!paperTags(row).length && '—'}</span>
    return <span className="paper-date" title={row.mtime ? fmtFull(row.mtime) : undefined}>{row.mtime ? fmtRelativeWords(row.mtime * 1000) : '—'}</span>
  }
  return <div className="paper-dashboard" data-testid="paper-dashboard" data-compact={prefs.compact} data-area={area}>
    <a className="paper-skip" href="#/" onClick={(e) => { e.preventDefault(); document.getElementById('main-content')?.focus() }}>跳到主内容</a>
    <header className="paper-topbar">
      <a href="#/" className="paper-brand"><img src="/logo-mark.svg" alt="" /><span>{BRAND_NAME}</span><span className="paper-brand-caption">科研工作空间</span></a>
      <nav className="paper-modules" aria-label="工作区功能">
        <button aria-current={area === 'projects' ? 'page' : undefined} onClick={() => showArea('projects')}><FolderOpen aria-hidden />论文项目</button>
        <button aria-current={area === 'venues' ? 'page' : undefined} onClick={() => showArea('venues')}><CalendarDays aria-hidden />投稿计划</button>
        <button aria-current={area === 'figures' ? 'page' : undefined} onClick={() => showArea('figures')}><Image aria-hidden />科研图表</button>
        {user?.is_superuser && <a href="#/admin?tab=templates" data-testid="paper-manage-templates"><LayoutTemplate aria-hidden />模板管理</a>}
      </nav>
      <div className="paper-topbar-end"><div className="paper-search"><Search aria-hidden /><input ref={search} aria-label="搜索项目" type="search" placeholder="搜索论文、投稿目标或标签…" value={query} onChange={(e) => { setQuery(e.target.value); if (area === 'figures') setArea('projects') }} /><kbd>/</kbd></div><div className="paper-user">{authOff ? <span className="paper-local-user" title="本地工作区"><UserRound aria-hidden /></span> : <UserMenu />}</div></div>
    </header>
    <div className="paper-body">
      <aside className="paper-sidebar" aria-label="项目范围与筛选">
        <div className="paper-nav-caption">项目空间</div>
        <nav aria-label="项目范围" className="paper-scopes">{SCOPES.map(({ id, label, icon: Icon }) => <button key={id} aria-current={area !== 'figures' && scope === id ? 'page' : undefined} onClick={() => showScope(id)}><Icon aria-hidden />{label}<span>{paperScopeRows(projects, id, authOff).length}</span></button>)}</nav>
        <details className="paper-facet" open><summary><ChevronDown aria-hidden />写作阶段</summary><div>{PAPER_STAGES.filter((s) => base.some((r) => paperStage(r) === s.id) || stage === s.id).map((s) => <button key={s.id} aria-pressed={stage === s.id} onClick={() => { setStage(stage === s.id ? 'all' : s.id); setSelected([]) }}><span className="paper-stage" data-stage={s.id}>{s.label}</span><span className="paper-facet-count">{base.filter((r) => paperStage(r) === s.id).length}</span></button>)}{!base.length && <p>当前范围暂无项目</p>}</div></details>
        <details className="paper-facet" open><summary><ChevronDown aria-hidden />标签</summary><div>{tags.map((t) => <button key={t} aria-pressed={tag === t} onClick={() => { setTag(tag === t ? '' : t); setSelected([]) }}><Tag aria-hidden />{t}<span className="paper-facet-count">{base.filter((r) => paperTags(r).includes(t)).length}</span></button>)}{!tags.length && <p>在项目信息中添加标签</p>}</div></details>
        <details className="paper-facet"><summary><ChevronDown aria-hidden />负责人</summary><div>{owners.map((o) => <button key={o.key} aria-pressed={owner === o.key} onClick={() => setOwner(owner === o.key ? '' : o.key)}><UserRound aria-hidden />{o.label}</button>)}</div></details>
        <div className="paper-sidebar-note"><BookOpen aria-hidden /><span>专注研究，沉淀成果。<small>Word / LaTeX 论文写作</small></span></div>
      </aside>
      <main id="main-content" className="paper-main" tabIndex={-1}>
        <div className="paper-page-heading"><div><p className="paper-eyebrow">工作空间 / {area === 'venues' ? '投稿计划' : area === 'figures' ? '科研图表' : '论文项目'}</p><h1>{title}<span>{area !== 'figures' && `${base.length} 篇`}</span></h1></div><div className="paper-heading-actions">{area !== 'figures' && boardable && <div className="paper-view-toggle" role="group" aria-label="项目视图"><button aria-pressed={view === 'list'} onClick={() => { setView('list'); setSelected([]) }}><List aria-hidden />列表</button><button aria-pressed={view === 'board'} onClick={() => { setView('board'); setSelected([]) }}><Kanban aria-hidden />看板</button></div>}<button className="paper-primary" onClick={() => openDialog('create')} data-testid="paper-create"><Plus aria-hidden />新建项目</button></div></div>
        {area === 'figures' ? <div className="paper-figures-manage"><ScientificFigures /></div> : <>
          <div className="paper-today" aria-label="投稿概览"><span>近期关注</span>{(['overdue', 'soon', 'missing'] as const).map((q) => { const n = base.filter((r) => matchesQuick(r, q)).length; return n > 0 && <button key={q} aria-pressed={quick === q} data-tone={q} onClick={() => setQuick(quick === q ? '' : q)}>{q === 'overdue' ? '已过截止' : q === 'soon' ? '7 天内截止' : '待补投稿目标'}<strong>{n}</strong></button> })}{!base.some((r) => matchesQuick(r, 'overdue') || matchesQuick(r, 'soon')) && <span className="paper-today-clear"><Check aria-hidden />暂无临近投稿截止</span>}</div>
          {area === 'venues' && <p className="paper-section-note">按期刊、会议和截止日期安排投稿。点击行尾的编辑按钮更新计划。</p>}
          <div className="paper-toolbar" role="toolbar" aria-label="项目列表工具">
            <label className="paper-tool-select"><span className="sr-only">分组方式</span><select aria-label="分组方式" value={group} disabled={view === 'board'} onChange={(e) => setGroup(e.target.value as PaperGroup)}><option value="none">不分组</option><option value="stage">按写作阶段</option><option value="venue">按投稿目标</option><option value="format">按文档类型</option></select></label>
            <Popover><PopoverTrigger><button className={cn('paper-tool', hasFilters && 'is-active')}><Filter aria-hidden />筛选{hasFilters && <span className="paper-filter-dot" />}</button></PopoverTrigger><PopoverContent className="paper-filter-popover w-64" aria-label="筛选论文项目"><label>写作阶段<select aria-label="筛选写作阶段" value={stage} onChange={(e) => setStage(e.target.value)}><option value="all">全部阶段</option>{PAPER_STAGES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label><label>负责人<select aria-label="筛选负责人" value={owner} onChange={(e) => setOwner(e.target.value)}><option value="">全部负责人</option>{owners.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}</select></label><label>标签<select aria-label="筛选标签" value={tag} onChange={(e) => setTag(e.target.value)}><option value="">全部标签</option>{tags.map((t) => <option key={t}>{t}</option>)}</select></label><button className="paper-tool" onClick={clearFilters}><X aria-hidden />清除筛选</button></PopoverContent></Popover>
            <select aria-label="文档类型" className="paper-tool-select" value={format} onChange={(e) => setFormat(e.target.value)}><option value="all">全部格式</option><option value="docx">Word</option><option value="latex">LaTeX</option><option value="markdown">Markdown</option><option value="structured">旧版结构化</option></select>
            <select aria-label="排序方式" className="paper-tool-select" value={sort} onChange={(e) => setSort(e.target.value as PaperSort)}><option value="recent">最近修改</option><option value="oldest">最早修改</option><option value="deadline">投稿截止</option><option value="title">论文名称</option></select>
            {hasFilters && <button className="paper-clear-filters" onClick={clearFilters}><X aria-hidden />清除</button>}
            <div className="paper-toolbar-end"><select className="paper-mobile-scope" aria-label="项目范围" value={scope} onChange={(e) => showScope(e.target.value as DashScope)}>{SCOPES.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}</select>{view === 'list' && <><Popover><PopoverTrigger><button className="paper-tool"><Columns3 aria-hidden />列</button></PopoverTrigger><PopoverContent align="end" className="w-48" aria-label="显示的列">{COLUMNS.map((c) => <label className="paper-column-option" key={c.id}><Checkbox checked={prefs.columns[c.id]} onCheckedChange={(on) => setPrefs({ ...prefs, columns: { ...prefs.columns, [c.id]: on } })} />{c.label}</label>)}</PopoverContent></Popover><button className="paper-tool paper-density" aria-pressed={prefs.compact} onClick={() => { const compact = !prefs.compact; setPrefs({ ...prefs, compact }); setDensity(compact ? 'compact' : 'comfortable') }}><Rows3 aria-hidden />紧凑</button></>}<button className="paper-tool paper-export" disabled={!rows.length} onClick={exportRows}><Download aria-hidden />导出清单</button></div>
          </div>
          {selectedRows.length > 0 && <div className="paper-bulk" role="toolbar" aria-label="批量操作"><strong>已选 {selectedRows.length} 篇</strong><button disabled={busy || selectedRows.some((r) => !writable(r))} onClick={() => void archiveSelected()}><Archive aria-hidden />{scope === 'archived' ? '取消归档' : scope === 'trash' ? '恢复项目' : '归档'}</button><button onClick={exportRows}><Download aria-hidden />导出所选清单</button>{scope === 'archived' && <button disabled={busy || selectedRows.some((r) => !writable(r))} onClick={() => void trashSelected()}><Trash2 aria-hidden />移入回收站</button>}
{scope === 'trash' && <button disabled={busy} onClick={() => { if (confirm(`确认永久删除所选 ${selectedRows.length} 篇论文？此操作不可恢复。`)) void deleteSelected() }}><Trash2 aria-hidden />永久删除</button>}<button aria-label="取消选择" onClick={() => setSelected([])}><X aria-hidden /></button></div>}
          {error && rows.length > 0 && <p role="alert" className="paper-list-error">列表刷新失败：{error}<button onClick={() => void load()}>重试</button></p>}
          <div className="paper-content">
            {rows.length > 0 && view === 'list' && <div className="paper-table-wrap"><table className="paper-project-table" aria-label={title}><thead><tr><th className="paper-select-cell"><Checkbox aria-label="选择当前列表全部项目" checked={selectedRows.length === rows.length ? true : selectedRows.length ? 'indeterminate' : false} onCheckedChange={(on) => setSelected(on ? rows.map((r) => r.id) : [])} /></th><th className="paper-title-cell">论文名称</th>{columns.map((c) => <th key={c.id} data-column={c.id}>{c.id === 'modified' ? <button onClick={() => setSort(sort === 'oldest' ? 'recent' : 'oldest')} aria-label={sort === 'oldest' ? '按最近修改排序' : '按最早修改排序'}>{c.label}<ArrowDownUp aria-hidden /></button> : c.label}</th>)}<th className="paper-actions-cell">操作</th></tr></thead>{groupPaperRows(rows, group).map(([label, members]) => <tbody key={label}>{label && <tr className="paper-group-row"><th colSpan={columns.length + 3} scope="rowgroup"><ChevronDown aria-hidden />{label}<span>{members.length}</span></th></tr>}{members.map((row) => <tr key={row.id} data-testid={`paper-project-${row.id}`} data-selected={selected.includes(row.id) || undefined}><td className="paper-select-cell"><Checkbox aria-label={`选择 ${row.title}`} checked={selected.includes(row.id)} onCheckedChange={() => toggleSelected(row.id)} /></td><td className="paper-title-cell"><a href={`#${projectHash(row.id)}`} className="paper-project-title"><span className="paper-file-tile" aria-hidden><FileText /></span><span className="paper-title-stack"><strong title={row.title}>{row.title || row.id}</strong><Format row={row} /></span></a></td>{columns.map((c) => <td key={c.id} data-column={c.id}>{cell(row, c.id)}</td>)}<td className="paper-actions-cell">{rowActions(row)}</td></tr>)}</tbody>)}</table></div>}
            {rows.length > 0 && view === 'board' && <div className="paper-board" aria-label="论文阶段看板">{PAPER_STAGES.filter((s) => rows.some((r) => paperStage(r) === s.id)).map((s) => <section key={s.id} className="paper-board-column" aria-label={s.label}><h2><span className="paper-stage" data-stage={s.id}>{s.label}</span><span>{rows.filter((r) => paperStage(r) === s.id).length}</span></h2>{rows.filter((r) => paperStage(r) === s.id).map((row) => <article className="paper-board-card" key={row.id} data-testid={`paper-project-${row.id}`}><div><Format row={row} />{rowActions(row)}</div><a href={`#${projectHash(row.id)}`}><strong>{row.title || row.id}</strong></a><p>{row.submission?.venue || '尚未设置投稿目标'}</p><footer><span><UserRound aria-hidden />{paperOwner(row, authOff)}</span><span>{row.submission?.deadline || fmtRelative(row.mtime * 1000)}</span></footer></article>)}</section>)}</div>}
            {!rows.length && <div className="paper-empty" role="status">{loading ? <><Loader2 className="animate-spin" />正在加载项目…</> : error ? <><h2>项目加载失败</h2><p>{error}</p><Button variant="outline" onClick={() => void load()}>重试</Button></> : <><img src="/paper-empty-art.png" alt="" width="160" height="128" loading="lazy" /><h2>{hasFilters ? '没有符合条件的论文' : scope === 'trash' ? '回收站是空的' : scope === 'archived' ? '还没有归档项目' : '从第一篇论文开始'}</h2><p>{hasFilters ? '调整关键词或筛选条件，继续寻找你的论文。' : '选择期刊模板、导入 Word / LaTeX 工程，或一键加载全功能演示论文。'}</p>{hasFilters ? <button className="paper-secondary" onClick={clearFilters}>清除筛选</button> : scope === 'all' && <div className="flex flex-wrap items-center justify-center gap-2"><button className="paper-primary" onClick={() => openDialog('create')}><Plus aria-hidden />新建项目</button><button className="paper-secondary" disabled={busy} data-testid="paper-create-showcase" onClick={async () => { try { const p = await latexApi.createShowcaseDemo(); useStudio.getState().toast('已创建全功能演示论文', 'success'); window.location.assign(`#${projectHash(p.id)}`) } catch (e) { useStudio.getState().toast((e as Error).message || '创建演示论文失败', 'error') } }}><Sparkles aria-hidden />加载演示论文</button></div>}</>}</div>}
          </div>
          <footer className="paper-list-footer"><span>{loading ? '正在刷新…' : `显示 ${rows.length} / ${base.length} 篇论文`}</span><span>{view === 'board' ? '在项目信息中设置写作阶段' : '点击论文名称继续写作'}</span></footer>
        </>}
      </main>
    </div>
    <NewPaperProjectDialog open={dialog === 'create'} onOpenChange={(o) => { if (!o) closeDialog() }} onZipImport={() => setImportOpen(true)} /><ImportDialog open={importOpen} onOpenChange={setImportOpen} onCreated={(pid) => window.location.assign(`#${projectHash(pid)}`)} />
    {editing && <PaperProjectInfo key={editing.id} row={editing} onClose={() => setEditing(null)} />}<Toasts />
  </div>
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Download, FileText, FolderOpen, LayoutGrid, List, Plus, Search, X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { UserMenu } from '@/components/auth/UserMenu'
import { CaseFormDialog } from '@/components/case-form/CaseFormDialog'
import { CreateProjectDialog } from '@/components/shell/CreateProjectDialog'
import { ImportDialog } from '@/components/latex/ImportDialog'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { MobilePage } from '@/components/ui/mobile-page'
import { PageHeader } from '@/components/ui/page-header'
import { Segmented } from '@/components/ui/segmented'
import { PlatformQueue } from '@/components/platform/PlatformQueue'
import { Skeleton as UiSkeleton } from '@/components/ui/skeleton'
import { useIsDesktop } from '@/hooks/useMisc'
import { usePageScroll } from '@/hooks/usePageScroll'
import { csvDateStamp, downloadCsv, toCsv } from '@/lib/csv'
import { cn } from '@/lib/utils'
import { selectDashboardRows, useStudio, type DashScope, type DashView } from '@/store'
import { BulkBar } from './BulkBar'
import { CaseBoard } from './CaseBoard'
import { CELL_TEXT, sortCaseRows, TOGGLEABLE_COLUMNS } from './caseColumns'
import { CaseTable } from './CaseTable'
import { FilterRail } from './FilterRail'
import { OrgShell } from './OrgShell'
import { TableToolbar } from './TableToolbar'
import { TodaySummaryBar } from './TodaySummaryBar'
import { LABEL_NEW_PROJECT } from '@/lib/copy'

const SCOPE_EMPTY: Record<DashScope, string> = {
  all: '还没有项目',
  mine: '没有由你负责的项目',
  shared: '没有共享给你的项目',
  archived: '没有已归档的项目',
  trash: '回收站是空的',
}

const SCOPE_TITLE: Record<DashScope, string> = {
  all: '项目列表',
  mine: '我负责的项目',
  shared: '共享给我的项目',
  archived: '已归档',
  trash: '回收站',
}

const SECTION_OPTIONS = [
  { value: 'cases', label: '项目', 'data-testid': 'dash-section-cases' },
  { value: 'items', label: '工作项', 'data-testid': 'dash-section-items' },
] as const
const VIEW_OPTIONS = [
  { value: 'list' as DashView, label: '列表', icon: <List aria-hidden />, 'data-testid': 'view-list' },
  { value: 'board' as DashView, label: '看板', icon: <LayoutGrid aria-hidden />, 'data-testid': 'view-board' },
]

/** 加载：表格 8 行 `Skeleton`（行高 --row-h）；移动 4 张卡 */
function Skeleton({ mobile }: { mobile: boolean }) {
  return (
    <div data-slot="DashboardSkeleton" aria-busy className={cn('flex flex-col', mobile ? 'gap-cards-m' : 'gap-2 px-page-x py-3')} role="status" aria-label="正在加载项目">
      {Array.from({ length: mobile ? 4 : 8 }).map((_, i) => (
        <UiSkeleton key={i} className={cn(mobile ? 'h-28 rounded-md' : 'h-row rounded-sm')} />
      ))}
    </div>
  )
}

function Empty({ scope, filtered }: { scope: DashScope; filtered: boolean }) {
  const openDialog = useStudio((s) => s.openDialog)
  const clear = useStudio((s) => s.clearDashFilters)
  if (filtered)
    return (
      <EmptyState
        data-slot="DashboardEmpty"
        icon={Search}
        title="没有符合筛选条件的项目"
        reason={scope === 'all' ? '换个范围、状态或关键词，或清除全部筛选。' : '换个范围、状态或关键词，或清除全部筛选。该范围本身也可能暂无项目。'}
        action={
          <Button variant="secondary" onClick={clear} data-testid="empty-clear">
            清除筛选
          </Button>
        }
      />
    )
  return (
    <EmptyState
      data-slot="DashboardEmpty"
      icon={scope === 'all' ? FolderOpen : FileText}
      title={SCOPE_EMPTY[scope]}
      reason={scope === 'all' ? '新建第一个项目，或从模板创建。' : undefined}
      action={
        scope === 'all' ? (
          <Button variant="outline" onClick={() => openDialog('create')} data-testid="empty-create">
            <Plus aria-hidden /> {LABEL_NEW_PROJECT}
          </Button>
        ) : undefined
      }
    />
  )
}

export function LegacyDashboardPage() {
  const product = useStudio((s) => s.product)
  // v0.1 proto：结构化中文论文（实验）——入口显隐由 /api/meta.struct_writer 驱动（默认关闭）
  const paper = product === 'paper'
  const [section, setSection] = useState<'cases' | 'items'>('cases')
  const isDesktop = useIsDesktop()
  const loadDashboard = useStudio((s) => s.loadDashboard)
  const loadDashUnread = useStudio((s) => s.loadDashUnread)
  const authed = useStudio((s) => s.authStatus === 'authed')
  const loading = useStudio((s) => s.dashLoading)
  const projects = useStudio((s) => s.projects)
  const projectsError = useStudio((s) => s.projectsError)
  const user = useStudio((s) => s.user)
  const tags = useStudio((s) => s.tags)
  const scope = useStudio((s) => s.dashScope)
  const view = useStudio((s) => s.dashView)
  const setView = useStudio((s) => s.setDashView)
  const query = useStudio((s) => s.dashQuery)
  const setQuery = useStudio((s) => s.setDashQuery)
  const selected = useStudio((s) => s.dashSelected)
  const toggleSelected = useStudio((s) => s.toggleDashSelected)
  const [importOpen, setImportOpen] = useState(false)
  const setSelected = useStudio((s) => s.setDashSelected)
  const setCaseStatus = useStudio((s) => s.setCaseStatus)
  const openDialog = useStudio((s) => s.openDialog)
  const toast = useStudio((s) => s.toast)
  const rawColumns = useStudio((s) => s.dashColumns)
  // 论文部署隐藏专利专属列（编号/类型/合作方/最近期限/申请号/申请日）——底层字段保留，只是不展示
  const columns = paper
    ? { ...rawColumns, case_no: false, kind: false, client: false, deadline: false, application_no: false, filing_date: false }
    : rawColumns
  const setColumns = useStudio((s) => s.setDashColumns)
  const group = useStudio((s) => s.dashGroup)
  const compact = useStudio((s) => s.dashCompact)
  const filtered = useStudio((s) => s.dashStatuses.length + s.dashTags.length + s.dashOwners.length > 0 || s.dashFocus !== null || s.dashQuery.trim() !== '')
  const sorting = useStudio((s) => s.dashSorting)
  const setSorting = useStudio((s) => s.setDashSorting)
  const [mobileSearch, setMobileSearch] = useState(false)
  const rows = useStudio(useShallow(selectDashboardRows))
  const counts = useMemo<Partial<Record<DashScope, number>>>(() => {
    const n = (dashScope: DashScope) => selectDashboardRows({ projects, user, dashScope, dashStatuses: [], dashTags: [], dashQuery: '' }).length
    return { all: n('all'), mine: n('mine'), shared: n('shared'), archived: n('archived'), trash: n('trash') }
  }, [projects, user])

  useEffect(() => {
    void loadDashboard()
  }, [loadDashboard])
  /** 今日摘要「提及」chip 与 dashFocus 用未读通知；未登录（off / anon / unknown）时后端没有收件人，GET /api/notify 永远为空，不发 */
  useEffect(() => {
    if (authed) void loadDashUnread()
  }, [authed, loadDashUnread])

  /** CSV = 屏幕所见：当前筛选 + 当前排序 + 当前可见列（勾选 / ⋯ 除外）；期限列随可见列走 */
  const exportCsv = () => {
    const cols = TOGGLEABLE_COLUMNS.filter((c) => columns[c.id] !== false).map((c) => ({ header: c.label, value: CELL_TEXT[c.id] }))
    const sorted = sortCaseRows(rows, sorting)
    downloadCsv(`项目列表-${csvDateStamp()}.csv`, toCsv(sorted, cols))
    toast(`已导出 ${sorted.length} 行、${cols.length} 列`, 'info')
  }

  const isLoading = loading && !projects.length

  /* 进案卷再回来把列表滚动位置写回（会话内存）：list 的真滚动器是 CaseTable 内层、board 是 CaseBoard 横向行 */
  const bodyWrap = useRef<HTMLDivElement>(null)
  const resolveScroller = useCallback(
    () => bodyWrap.current?.querySelector<HTMLElement>('[data-slot="CaseTable"],[data-slot="CaseBoard"]') ?? null,
    [],
  )
  usePageScroll(`dashboard:${view}`, !isLoading, resolveScroller)

  /** 全空（非筛选空）时 EmptyState 自带 primary，分组栏的 primary 隐藏，保持一屏一个 */
  /* 列表拉取失败不亮「还没有案卷」假空态——错误态 + 重试 */
  const empty =
    projectsError && rows.length === 0 ? (
      <EmptyState
        data-slot="DashboardEmpty"
        icon={FolderOpen}
        title="项目加载失败"
        reason={projectsError}
        action={
          <Button variant="secondary" onClick={() => void loadDashboard()} data-testid="empty-retry">
            重试
          </Button>
        }
      />
    ) : (
      <Empty scope={scope} filtered={filtered} />
    )
  const body = isLoading ? (
    <Skeleton mobile={!isDesktop} />
  ) : view === 'board' ? (
    rows.length === 0 ? (
      <div className="flex flex-1 items-center justify-center p-4">{empty}</div>
    ) : (
      <CaseBoard rows={rows} tags={tags} selected={selected} onToggleSelected={toggleSelected} onMove={(pid, st) => void setCaseStatus(pid, st)} mobile={!isDesktop} />
    )
  ) : (
    <CaseTable
      rows={rows}
      tags={tags}
      selected={selected}
      onToggleSelected={toggleSelected}
      onSetSelected={setSelected}
      sorting={sorting}
      onSortingChange={setSorting}
      columnVisibility={columns}
      onColumnVisibilityChange={setColumns}
      mobile={!isDesktop}
      empty={empty}
      group={group}
      compact={compact}
    />
  )

  const total = counts[scope] ?? 0
  const summary = filtered ? `筛选出 ${rows.length} / ${total} 件` : `${total} 件`
  const search = (
    <div className={cn('relative min-w-0', isDesktop ? 'w-80' : 'flex-1')}>
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
      <Input
        type="search"
        size={isDesktop ? 'sm' : 'xl'}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={paper ? "搜索项目 / 标题" : "搜索项目 / 标题（stage:撰写 筛阶段）"}
        aria-label="搜索项目"
        className="pl-8"
        data-testid="dashboard-search"
        autoFocus={!isDesktop}
      />
    </div>
  )

  if (!isDesktop) {
    return (
      <OrgShell
        name="dashboard"
        title="项目"
        current="cases"
        mobile
        mobileTopbar={
          mobileSearch ? (
            <>
              {search}
              <Button variant="ghost" size="icon-xl" aria-label="关闭搜索" title="关闭搜索" onClick={() => { setMobileSearch(false); setQuery('') }}>
                <X aria-hidden />
              </Button>
            </>
          ) : (
            <>
              <UserMenu />
              <h1 className="min-w-0 flex-1 truncate px-1 text-base font-semibold text-fg-strong">
                {SCOPE_TITLE[scope]} <span className="font-normal text-fg-muted tabular-nums">{total}</span>
              </h1>
              {/* 06 §2 顶栏图标按钮视觉 md 36（原型 01-home 新建 36），touch-hit 命中 44；两按钮间距 8 使热区不重叠 */}
              <div className="flex shrink-0 items-center gap-2">
                <Button variant="ghost" size="icon-md" aria-label="搜索项目" title="搜索项目" onClick={() => setMobileSearch(true)} data-testid="dashboard-search-toggle">
                  <Search aria-hidden />
                </Button>
                <Button size="icon-md" onClick={() => openDialog('create')} data-testid="dashboard-create" aria-label={LABEL_NEW_PROJECT}>
                  <Plus aria-hidden />
                </Button>
              </div>
            </>
          )
        }
      >
        <MobilePage data-testid="dashboard-page">
          <section className="flex min-w-0 flex-col gap-cards-m" aria-label="视图与筛选" data-testid="dashboard-controls">
            {section === 'cases' && <Segmented options={VIEW_OPTIONS} value={view} onValueChange={setView} aria-label="视图" size="md" className="w-full" />}
            <Segmented options={paper ? SECTION_OPTIONS.filter((o) => o.value !== 'items') : SECTION_OPTIONS} value={section} onValueChange={setSection} aria-label="区块" size="md" className="w-full" />
            <TodaySummaryBar mobile />
            <FilterRail tags={tags} counts={counts} horizontal />
          </section>
          <div className="flex min-w-0 flex-col" data-testid="dashboard">{section === 'items' ? <PlatformQueue /> : body}</div>
        </MobilePage>
        <BulkBar selected={selected} tags={tags} inTrash={scope === 'trash'} onClear={() => setSelected([])} mobile />
        <CreateProjectDialog />
        <CaseFormDialog />
      </OrgShell>
    )
  }

  return (
    <OrgShell name="dashboard" title="项目" current="cases" mobile={false} topbar={search}>
      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onCreated={(pid) => window.location.assign(`#/p/${encodeURIComponent(pid)}`)}
      />
      <FilterRail tags={tags} counts={counts} showCreate={false} />
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-panel" aria-label="项目面板" data-testid="dashboard">
        <PageHeader
          size="md"
          title={
            <>
              {SCOPE_TITLE[scope]}
              <span className="ml-2 text-sm font-normal text-fg-muted tabular-nums" data-testid="dashboard-summary">
                {summary}
              </span>
            </>
          }
          className="border-b-0 bg-panel py-3 md:py-3"
          primary={<Button size="sm" onClick={() => openDialog('create')} data-testid="dashboard-create"><Plus aria-hidden /> {LABEL_NEW_PROJECT}</Button>}
          actions={
            <>
              {section === 'cases' && <Segmented options={VIEW_OPTIONS} value={view} onValueChange={setView} aria-label="视图" size="sm" />}
              <Button
                variant="ghost"
                size="sm"
                data-testid="import-zip"
                aria-label="导入 LaTeX 工程（ZIP）"
                title="上传 .zip LaTeX 工程（多文件/bib/cls/图片），选择主文件与引擎后创建"
                onClick={() => setImportOpen(true)}
              >
                <FileText aria-hidden />
                导入 ZIP 工程
              </Button>
              <Segmented options={paper ? SECTION_OPTIONS.filter((o) => o.value !== 'items') : SECTION_OPTIONS} value={section} onValueChange={setSection} aria-label="区块" size="sm" />
              <Button variant="ghost" size="sm" onClick={exportCsv} disabled={!rows.length} data-testid="export-csv" aria-label="导出 CSV">
                <Download aria-hidden />
                导出 CSV
              </Button>
            </>
          }
        />
        <TodaySummaryBar />
        {view === 'list' && <TableToolbar sorting={sorting} onSortingChange={setSorting} columns={columns} onColumnsChange={setColumns} />}
        <BulkBar selected={selected} tags={tags} inTrash={scope === 'trash'} onClear={() => setSelected([])} />
        <div ref={bodyWrap} className="flex min-h-0 flex-1 flex-col overflow-auto">{section === 'items' ? <PlatformQueue /> : body}</div>
      </main>
      <CreateProjectDialog onZipImport={() => setImportOpen(true)} />
      <CaseFormDialog />
    </OrgShell>
  )
}

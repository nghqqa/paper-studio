import { useEffect, useRef, lazy, Suspense } from 'react'
import { MobileTopBar } from './MobileTopBar'
import { GlobalErrorBar } from './GlobalErrorBar'
import { MobileTabs } from './MobileTabs'
import { MobilePreview } from './MobilePreview'
import { NavDrawer } from './NavDrawer'
import { MoreSheet } from './MoreSheet'
import { MobileSettings } from './MobileSettings'
import { MobileConsole } from './MobileConsole'
import { MobileAiTab } from './MobileAiTab'
import { PdfLongPressSheet } from './PdfLongPressSheet'
import { BookSwitcher } from './BookSwitcher'
import { MobileBookEditor } from './MobileBookEditor'
import { MobileEditChrome } from './MobileEditChrome'
import { MobileLayoutToolbar } from './MobileLayoutToolbar'
// 槽位注册随工作台 lazy 分包下沉（原在 App 层，幂等）
import '@/components/notify/slots'
import '@/components/timeline/slots'
import '@/components/ai/slots'
import '@/components/platform/slots'
import { CaseTimelineDrawer } from '@/components/timeline/CaseTimelineDrawer'
import { MobileQuickKeys } from './MobileQuickKeys'
import { LayoutView } from '@/components/layout-view'
import { LayoutRightRail } from '@/components/workbench/LayoutRightRail'
import { ReviewRail } from '@/components/layout-view/review/ReviewRail'
import { Editor } from '@/components/editor/Editor'
import { CompanionHost } from '@/components/shell/CompanionHost'
import { DirtyGuardDialog } from '@/components/shell/DirtyGuardDialog'
import { Toasts } from '@/components/shell/Toasts'
import { CreateProjectDialog } from '@/components/shell/CreateProjectDialog'
import { CollabDrawer } from '@/components/collab-center'
import { CollabMirror } from '@/collab'
import { ConvertDialog } from '@/components/convert/ConvertDialog'
import { ImportDocxDialog } from '@/components/importer'
import { StructureDialogs } from '@/components/block-model/dialogs'
import { ReviewDrawer } from '@/components/review/ReviewDrawer'
import { selectEditorMode, useStudio } from '@/store'
import { BRAND_NAME, pageTitle } from '@/lib/brand'
import { LatexWorkbench } from '@/components/latex/LatexWorkbench'
// pdf.js 链（PreviewPane→PdfPreview）必须保持懒加载（见 @/lib/pdfjs 顶部说明），
// 否则移动端首包被 pdfjs 拖累、jsdom 测试被 DOMMatrix 拉崩。
const LegacyStructuredWorkbench = lazy(() => import('@/components/word/LegacyStructuredWorkbench').then((m) => ({ default: m.LegacyStructuredWorkbench })))
const WordWorkbench = lazy(() => import('@/components/word/WordWorkbench').then((m) => ({ default: m.WordWorkbench })))
const MarkdownPaperWorkbench = lazy(() => import('@/components/paper/MarkdownPaperWorkbench').then((m) => ({ default: m.MarkdownPaperWorkbench })))
import { useMediaQuery } from '@/hooks/useMisc'
import { cn } from '@/lib/utils'

/**
 * 移动外壳（05 §3.19 / S10b–e，375 基准，100dvh）：MobileTopBar 44 · 内容 · MobileTabs 56 = chrome 100；编辑 / 预览首行各一条 Segmented xl 44 → ≤144。
 * 旧 MobileStatusStrip 两行 / EditorTabs / EditorToolbar / 源码·版面 Segmented 均已下线：状态进顶栏副行与 MoreSheet 头部，源码｜版面切换进 MoreSheet「编辑」组，
 * Markdown 工具条由 MobileQuickKeys（编辑器聚焦时贴输入法上方）承担。GlobalErrorBar 仅编辑 / 控制台 Tab 有 error 时出现。
 * AI 单入口：companion==='ai'（?panel=ai）在移动端并入 mobileTab='ai'，不再由 CompanionHost 底部 Sheet 二次渲染 AiPanel。
 * 内容 = 编辑（BookSwitcher Segmented md ScrollRow + Editor 或 MobileBookEditor 单书 + 快捷键盘）/ 预览（MobilePreview）/ AI（MobileAiTab）/ 控制台（MobileConsole，由 MoreSheet 进入）；
 * W9 决策 5：编辑区顶部 <MobileEditChrome/>（ViewSwitch 三段 44 + 模式 compact），版面视图底部 <MobileLayoutToolbar/>（撤销 / 重做 / B / 插入 / 审阅栏 + bottomBarActions 插槽；源码视图仍由 MobileQuickKeys 贴输入法）；
 * editorView='layout' 时编辑区换成 <LayoutView/>（docs/plan/16 §8.2）；CodeMirror 仍常驻（display:none）保留撤销栈；审阅栏 375 走 <LayoutRightRail/> 的 Sheet。
 * ui.mobileSettingsOpen 时整块内容区换成 MobileSettings（顶栏 / 底部 Tab 保留，Tab 无选中）。
 * Tab / 面板切换只换内容区节点，PDF 页码 (ui.pageInfo) 与滚动 (ui.previewScroll) 由 store 保存，回到预览时恢复。
 * 抽屉/Sheet 状态全部在 ui slice：NavDrawer(左，ui.mobileNav) · MoreSheet(底，ui.moreOpen) · PdfLongPressSheet(底，ui.pdfLongPress)；
 * 审阅底部 Sheet（ReviewDrawer，review.reviewDrawerOpen）常驻挂在这里，因 openReviewDrawer 会关 NavDrawer / MoreSheet（互斥），不能挂在它们内部。
 * 桌面持久化的 pdfView='logs' / settingsOpen 在移动端挂载时先收起，避免一进来就是控制台或设置；zoom 归 1（预览默认适宽）。
 */
export function MobileShell() {
  const product = useStudio((s) => s.product)
  const project = useStudio((s) => s.project)
  const projectError = useStudio((s) => s.projectError)
  const docType = useStudio((s) => s.project?.settings?.document_type)
  const projectLoading = useStudio((s) => s.projectLoading)
  const pid = useStudio((s) => s.pid)
  const latexMode = useStudio((s) => s.project?.settings?.source_format) === 'latex'
  const structMode = useStudio((s) => s.project?.settings?.source_format) === 'structured'
  const wordMode = useStudio((s) => s.project?.settings?.source_format) === 'docx'
  const title = useStudio((s) => s.project?.title)
  const tab = useStudio((s) => s.mobileTab)
  const settingsOpen = useStudio((s) => s.mobileSettingsOpen)
  const toggleBottom = useStudio((s) => s.toggleBottom)
  const toggleSettings = useStudio((s) => s.toggleSettings)
  const toggleMobileSettings = useStudio((s) => s.toggleMobileSettings)
  const setZoom = useStudio((s) => s.setZoom)
  const setZoomFit = useStudio((s) => s.setZoomFit)
  const activeBook = useStudio((s) => s.activeBook)
  const editorView = useStudio((s) => s.editorView)
  const editorMode = useStudio(selectEditorMode)
  const layoutView = editorView === 'layout'
  const companion = useStudio((s) => s.companion)
  const closeCompanion = useStudio((s) => s.closeCompanion)
  const setMobileTab = useStudio((s) => s.setMobileTab)

  // 移动端 AI 单入口：companion 'ai'（?panel=ai）并入底部 Tab；closeCompanion 经 CompanionHost 同步抹掉 ?panel=
  useEffect(() => {
    if (companion !== 'ai') return
    closeCompanion()
    setMobileTab('ai')
  }, [companion, closeCompanion, setMobileTab])

  useEffect(() => {
    toggleBottom(false)
    toggleSettings(false)
    setZoom(1)
    setZoomFit('width')
  }, [toggleBottom, toggleSettings, setZoom, setZoomFit])

  // 设置整屏期间若有动作切 Tab（状态条 → 控制台 / gotoLine → 编辑），关掉设置让目标 Tab 可见
  const prevTab = useRef(tab)
  useEffect(() => {
    if (prevTab.current !== tab) {
      prevTab.current = tab
      if (settingsOpen) toggleMobileSettings(false)
    }
  }, [tab, settingsOpen, toggleMobileSettings])

  const smUp = useMediaQuery('(min-width: 640px)')
  const showErrorBar = !settingsOpen && tab !== 'preview' && tab !== 'ai'
  const editVisible = !settingsOpen && tab === 'edit'

  // 跨源格式切换防错挂载（与 DesktopShell 同款守卫）：pid 已翻到新案但 project 仍是上一案/仍在拉取时，
  // source_format 属旧案——据它选工作台会把 LatexWorkbench 错挂到 Word 工程（首帧 GET /latex/files → 400）。
  // projectError 置位时放行：openProject 失败已有 toast + 回面板兜底，不得停在加载占位。
  if (pid && (projectLoading || (project != null && project.id !== pid)) && !projectError) {
    return <div role="status" className="grid h-dvh place-items-center bg-app text-sm text-fg-muted">正在加载项目…</div>
  }
  if (product === 'paper' && (!pid || projectLoading || !docType)) return <div role="status" className="grid h-dvh place-items-center bg-app text-sm text-fg-muted">正在加载论文项目…</div>
  if (product === 'paper' && docType === 'patent' && !latexMode) return <div className="grid h-dvh place-items-center bg-app p-6 text-center" role="status"><div><p>此项目暂不支持在论文工作区打开</p><a href="#/" className="mt-4 block text-primary">返回项目列表</a></div></div>
  if (product === 'paper' && pid && !latexMode && !wordMode && !structMode) return <Suspense fallback={<MobileLoading />}><MarkdownPaperWorkbench key={pid} pid={pid} /><CollabDrawer /><Toasts /></Suspense>
  if (latexMode && pid) {
    return <><LatexWorkbench key={pid} pid={pid} /><CollabDrawer /><Toasts /></>
  }
  // v0.1 proto：结构化中文论文（实验）——桌面/移动同一响应式工作台
  if (structMode && pid) {
    return <Suspense fallback={<MobileLoading />}><LegacyStructuredWorkbench pid={pid} /><CollabDrawer /><Toasts /></Suspense>
  }

  if (wordMode && pid) return <Suspense fallback={<MobileLoading />}><WordWorkbench key={pid} pid={pid} /><CollabDrawer /><Toasts /></Suspense>

  return (
    <div
      data-slot="MobileShell"
      data-testid="mobile-shell"
      data-density="touch"
      className="flex h-dvh max-h-dvh w-full min-w-0 flex-col overflow-hidden bg-app [&_[data-testid=toasts]]:bottom-[calc(var(--h-mobile-tabs)+0.5rem)]"
    >
      <MobileTopBar />
      {showErrorBar && <GlobalErrorBar />}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <h1 className="sr-only">{title ? pageTitle(title) : BRAND_NAME}</h1>
        <div
          className="relative min-h-0 min-w-0 flex-1 overflow-hidden"
          role="tabpanel"
          id="mobile-tabpanel"
          // 控制台没有底栏 tab 按钮（由「更多」进入），不能用 aria-labelledby
          aria-labelledby={settingsOpen || tab === 'console' ? undefined : `mobile-tab-${tab}`}
          aria-label={settingsOpen ? '排版设置' : tab === 'console' ? '控制台' : undefined}
        >
          {settingsOpen ? <MobileSettings /> : tab === 'preview' ? <MobilePreview /> : tab === 'ai' ? <MobileAiTab /> : tab === 'console' ? <MobileConsole /> : null}
          {/* 编辑区常驻（其它 Tab 时 display:none）：CodeMirror 视图与撤销栈跨 Tab 保留，控制台一键修复走编辑器事务、可撤销 */}
          <div className={cn('h-full min-h-0 flex-col bg-panel', editVisible ? 'flex' : 'hidden')} data-testid="mobile-edit" hidden={!editVisible}>
            {pid && <MobileEditChrome />}
            {pid && <BookSwitcher />}
            {pid && layoutView && <LayoutView className="min-h-0 flex-1 overflow-auto" books={activeBook === 'all' ? undefined : [activeBook]} mode={editorMode} />}
            {pid &&
              (activeBook === 'all' ? (
                <Editor className={cn('min-h-0 flex-1 overflow-hidden', layoutView && 'hidden')} />
              ) : (
                <>
                  <CollabMirror />
                  <MobileBookEditor book={activeBook} className={cn('min-h-0 flex-1 overflow-hidden', layoutView && 'hidden')} />
                </>
              ))}
            {pid && !layoutView && <MobileQuickKeys />}
            {pid && layoutView && <MobileLayoutToolbar mode={editorMode} />}
            {pid && (
              <LayoutRightRail>
                <ReviewRail pid={pid} showAssign={false} />
              </LayoutRightRail>
            )}
          </div>
        </div>
      </main>
      <MobileTabs />

      <NavDrawer />
      <MoreSheet />
      {/* R57-03：移动端时间线唯一入口在 MoreSheet——本组件在非桌面只渲 Sheet（桌面 rail 钮在 Rail 槽位） */}
      <CaseTimelineDrawer />
      <ReviewDrawer />
      {/* W6 伴随栏：<768 转 Sheet（≥640 右侧 360 / <640 底部 ≤85dvh），store.companion 同一契约 */}
      <CompanionHost presentation={smUp ? 'sheet-right' : 'sheet-bottom'} />
      <PdfLongPressSheet />
      <DirtyGuardDialog />
      <CreateProjectDialog />
      <CollabDrawer />
      <ConvertDialog />
      <ImportDocxDialog />
      <StructureDialogs />
      <Toasts />
    </div>
  )
}

function MobileLoading() {
  return <div role="status" className="grid h-dvh place-items-center bg-app text-sm text-fg-muted">正在加载…</div>
}

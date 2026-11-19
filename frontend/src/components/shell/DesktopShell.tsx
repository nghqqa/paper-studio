import { useEffect } from 'react'
import { TopBar } from './TopBar'
import { Rail } from './Rail'
import { StatusBar } from './StatusBar'
import { SplitPane } from './SplitPane'
import { DirtyGuardDialog } from './DirtyGuardDialog'
import { Toasts } from './Toasts'
import { CreateProjectDialog } from './CreateProjectDialog'
import { SideSplit } from '@/components/outline/SideSplit'
import { Editor } from '@/components/editor/Editor'
import { PreviewPane } from '@/components/preview/PreviewPane'
import { SettingsPanel } from '@/components/settings/SettingsPanel'
import { CollabDrawer } from '@/components/collab-center'
import { DockArea } from '@/layout/DockArea'
import { ConvertDialog } from '@/components/convert/ConvertDialog'
import { ImportDocxDialog } from '@/components/importer'
import { StructureDialogs } from '@/components/block-model/dialogs'
import { CompanionHost } from './CompanionHost'
import { SkipLink } from '@/components/ui/skip-link'
import { useStudio } from '@/store'
import { LatexWorkbench } from '@/components/latex/LatexWorkbench'
import { LegacyStructuredWorkbench } from '@/components/word/LegacyStructuredWorkbench'
import { WordWorkbench } from '@/components/word/WordWorkbench'
import { MarkdownPaperWorkbench } from '@/components/paper/MarkdownPaperWorkbench'
import { cn } from '@/lib/utils'
// 槽位注册随工作台 lazy 分包下沉（原在 App 层）：TopBarItem/Rail/伴随栏/编辑器扩展只被工作台消费（幂等）
import '@/components/notify/slots'
import '@/components/timeline/slots'
import '@/components/ai/slots'
import '@/components/platform/slots'
import { BRAND_NAME, pageTitle } from '@/lib/brand'

/**
 * 桌面壳（05 S3 · C Pro Dense）：
 *   grid-template-columns: 40px(rail) [side 240|0] minmax(0,1fr) [companion auto|0]
 *   grid-template-rows:    40px(topbar) minmax(0,1fr) 24px(statusbar)
 * 第 4 列 = W6 伴随栏（CompanionHost → CompanionPanel，dockview 外侧，默认关；宽度由 store.companionWidth 320–480 决定）。
 * 业务面板正文由单元在 CompanionHost.tsx 接入；本文件 prep 独占，单元不改。
 * 历史（07 §2）：
 * 主区 SplitPane 左 = settingsOpen ? SettingsPanel : Editor；右 = PreviewPane（常驻：pdfView==='logs' 时其正文自行换为 ConsolePanel，
 * PdfToolbar 保留并显示「返回预览」）。设置替换编辑器区、控制台替换 PDF 区，没有底部面板行与右侧抽屉列。
 * ≤1279 打开设置自动折叠侧栏 / 关闭恢复：逻辑在 store（toggleSettings / syncSideAutoCollapse），这里只挂 resize。
 * R4：主区经 `<DockArea fallback=…/>`（docs/plan/08 §2），现有 SplitPane 三态作为 fallback；dockview 容器由 D1 在 layout/DockArea.tsx 内落地。
 */
export function DesktopShell() {
  const pid = useStudio((s) => s.pid)
  const project = useStudio((s) => s.project)
  const projectError = useStudio((s) => s.projectError)
  const sourceFormat = useStudio((s) => s.project?.settings?.source_format)
  const product = useStudio((s) => s.product)
  const docType = useStudio((s) => s.project?.settings?.document_type)
  const projectLoading = useStudio((s) => s.projectLoading)
  const title = useStudio((s) => s.project?.title)
  const outlineOpen = useStudio((s) => s.outlineOpen)
  const settingsOpen = useStudio((s) => s.settingsOpen)
  const layout = useStudio((s) => s.layout)
  const companion = useStudio((s) => s.companion)
  const syncSideAutoCollapse = useStudio((s) => s.syncSideAutoCollapse)

  useEffect(() => {
    syncSideAutoCollapse()
    window.addEventListener('resize', syncSideAutoCollapse)
    return () => window.removeEventListener('resize', syncSideAutoCollapse)
  }, [syncSideAutoCollapse])
  // 跨源格式切换防错挂载：pid 已翻到新案但 store.project 仍是上一案/仍在拉取时，sourceFormat/docType
  // 属旧案——据它选工作台会把 LatexWorkbench 错挂到 Word 工程（首帧 GET /latex/files → 400）。
  // projectError 置位时放行：openProject 失败已有 toast + 回面板兜底，不得停在加载占位。
  if (pid && (projectLoading || (project != null && project.id !== pid)) && !projectError) {
    return <div role="status" className="grid h-dvh place-items-center bg-app text-sm text-fg-muted">正在加载项目…</div>
  }
  // 论文部署：历史专利项目（markdown 档案）不再展示半套专利工作台——明确不可用并回入口
  if (product === 'paper' && (!pid || projectLoading || !docType)) return <div role="status" className="grid h-dvh place-items-center bg-app text-sm text-fg-muted">正在加载论文项目…</div>
  if (product === 'paper' && pid && sourceFormat !== 'latex' && docType === 'patent') {
    return (
      <div role="alert" className="grid min-h-dvh place-items-center bg-app px-4" data-testid="patent-project-unavailable">
        <div className="max-w-md text-center">
          <p className="text-base font-semibold text-fg-strong">此项目暂不支持在论文工作区打开</p>
          <p className="mt-2 text-sm text-fg-muted">
            请返回项目列表选择 Word 或 LaTeX 论文。需要迁移其他格式时，请联系管理员。
          </p>
          <a href="#/" className="mt-4 inline-block rounded-md border border-border px-3 py-1.5 text-sm hover:bg-hover">
            返回项目列表
          </a>
        </div>
      </div>
    )
  }
  if (product === 'paper' && pid && !['latex', 'docx', 'structured'].includes(sourceFormat ?? '')) return <><MarkdownPaperWorkbench key={pid} pid={pid} /><CollabDrawer /><Toasts /></>
  // w21 批A：LaTeX 工程走独立最小工作台（不接三书协同/Markdown 编辑/专利面板）。
  // v0.1.2：latex 分支原来直接 return，挂在下方公共区的 CollabDrawer 被跳过——
  // 工作台内没有成员管理入口，学生无法从界面邀请导师；此处显式补挂（复用既有抽屉，权限仍由服务端强制）。
  if (pid && sourceFormat === 'latex') {
    return (
      <>
        <LatexWorkbench key={pid} pid={pid} />
        <CollabDrawer />
      </>
    )
  }

  // v0.1 proto：结构化中文论文（实验）走独立工作台（同 latex：不接三书/Markdown/专利面板；成员管理入口同补挂）
  if (pid && sourceFormat === 'structured') {
    return (
      <>
        <LegacyStructuredWorkbench pid={pid} />
        <CollabDrawer />
      </>
    )
  }

  if (pid && sourceFormat === 'docx') {
    return <><WordWorkbench key={pid} pid={pid} /><CollabDrawer /><Toasts /></>
  }

  // 设置打开时编辑器只隐藏不卸载（保留 CodeMirror 光标 / 滚动 / 撤销栈）
  const left = (
    <div className="relative h-full min-h-0 min-w-0">
      <div className={cn('flex h-full min-h-0 flex-col bg-panel', settingsOpen && 'hidden')} data-testid="editor-pane" aria-hidden={settingsOpen}>
        {pid && <Editor className="min-h-0 flex-1 overflow-hidden" />}
      </div>
      {settingsOpen && <SettingsPanel />}
    </div>
  )
  const right = <PreviewPane />

  return (
    <>
      <SkipLink />
      <div
        data-slot="DesktopShell"
        data-testid="desktop-shell"
        data-companion={companion ?? undefined}
        className="grid h-full min-h-0 overflow-hidden bg-app text-fg"
        style={{
          gridTemplateColumns: `var(--w-rail) ${outlineOpen ? 'var(--w-side)' : '0px'} minmax(0,1fr) ${companion ? 'auto' : '0px'}`,
          gridTemplateRows: 'var(--h-topbar) minmax(0,1fr) var(--h-statusbar)',
        }}
      >
        <div className="col-span-4 row-start-1 min-w-0"><TopBar /></div>

        <div className="col-start-1 row-start-2 min-h-0"><Rail /></div>

        <aside className={cn('col-start-2 row-start-2 min-h-0 min-w-0 overflow-hidden', !outlineOpen && 'invisible')} aria-hidden={!outlineOpen} aria-label="案卷与大纲侧栏">
          <SideSplit />
        </aside>

        <main id="main-content" tabIndex={-1} className="col-start-3 row-start-2 min-h-0 min-w-0 outline-none" data-testid="main-area">
          <h1 className="sr-only">{title ? pageTitle(title) : BRAND_NAME}</h1>
          <DockArea
            fallback={
              <>
                {layout === 'split' && <SplitPane left={left} right={right} />}
                {layout === 'editor' && left}
                {layout === 'preview' && right}
              </>
            }
          />
        </main>

        <div className={cn('col-start-4 row-start-2 min-h-0 min-w-0 overflow-hidden', !companion && 'invisible')} aria-hidden={!companion} data-testid="companion-column">
          <CompanionHost presentation="column" />
        </div>

        <div className="col-span-4 row-start-3 flex min-w-0 flex-col justify-center [&>*]:flex-1"><StatusBar /></div>
      </div>

      <DirtyGuardDialog />
      <CreateProjectDialog />
      <CollabDrawer />
      <ConvertDialog />
      <ImportDocxDialog />
      <StructureDialogs />
      <Toasts />
    </>
  )
}

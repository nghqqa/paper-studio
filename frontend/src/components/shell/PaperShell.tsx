import { Suspense, lazy } from 'react'
import { CollabDrawer } from '@/components/collab-center'
import { useStudio } from '@/store'
import { Toasts } from './Toasts'

const LatexWorkbench = lazy(() => import('@/components/latex/LatexWorkbench').then((m) => ({ default: m.LatexWorkbench })))
const WordWorkbench = lazy(() => import('@/components/word/WordWorkbench').then((m) => ({ default: m.WordWorkbench })))
const MarkdownPaperWorkbench = lazy(() => import('@/components/paper/MarkdownPaperWorkbench').then((m) => ({ default: m.MarkdownPaperWorkbench })))

function PaperLoading({ text = '正在加载工作台…' }: { text?: string }) {
  return <div role="status" className="grid h-dvh place-items-center bg-app text-sm text-fg-muted">{text}</div>
}

/**
 * 论文产品专属工作台外壳（PRODUCT=paper）：
 * 按 source_format 按需懒加载 LaTeX / Word / Markdown 工作台，
 * 不静态引入专利桌面/移动壳（Dockview / ProseMirror / Yjs / 槽位扩展）。
 */
export function PaperShell() {
  const pid = useStudio((s) => s.pid)
  const project = useStudio((s) => s.project)
  const projectError = useStudio((s) => s.projectError)
  const projectLoading = useStudio((s) => s.projectLoading)
  const sourceFormat = useStudio((s) => s.project?.settings?.source_format)
  const docType = useStudio((s) => s.project?.settings?.document_type)

  if (pid && (projectLoading || (project != null && project.id !== pid)) && !projectError) {
    return <PaperLoading text="正在加载项目…" />
  }
  if (!pid || projectLoading || !docType) {
    return <PaperLoading text="正在加载论文项目…" />
  }
  if (pid && sourceFormat !== 'latex' && docType === 'patent') {
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

  const workbench =
    sourceFormat === 'latex' ? (
      <LatexWorkbench key={pid} pid={pid} />
    ) : sourceFormat === 'docx' ? (
      <WordWorkbench key={pid} pid={pid} />
    ) : (
      <MarkdownPaperWorkbench key={pid} pid={pid} />
    )

  return (
    <Suspense fallback={<PaperLoading />}>
      {workbench}
      <CollabDrawer />
      <Toasts />
    </Suspense>
  )
}

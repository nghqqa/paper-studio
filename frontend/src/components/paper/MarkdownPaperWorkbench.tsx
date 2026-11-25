import { ArrowLeft, Share2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useStudio } from '@/store'

/** Legacy Markdown workbench retirement shell in pure Paper Studio. */
export function MarkdownPaperWorkbench({ pid }: { pid: string }) {
  const title = useStudio((s) => s.project?.title)
  const share = useStudio((s) => s.openCollabCenter)
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-app" data-testid="markdown-paper-workbench">
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-3 border-b border-border bg-panel px-4 py-2">
        <a href="#/" aria-label="返回项目列表"><ArrowLeft className="size-4" /></a>
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">{title || pid}</h1>
        <span className="text-xs text-fg-muted">Markdown 论文</span>
        <Button size="sm" variant="outline" onClick={() => share('members')}><Share2 aria-hidden />协作</Button>
      </header>
      <main className="flex min-h-0 flex-1 items-center justify-center p-6">
        <div className="max-w-md space-y-3 rounded-lg border border-border bg-panel p-6 text-center">
          <h2 className="text-base font-semibold text-fg-strong">旧版 Markdown 工作台已下线</h2>
          <p className="text-sm text-fg-muted">Paper Studio 已聚焦 Word 与 LaTeX 论文工作流，当前项目不再提供在线 Markdown 编辑与预览。</p>
          <Button asChild size="sm">
            <a href="#/">返回项目列表</a>
          </Button>
        </div>
      </main>
    </div>
  )
}

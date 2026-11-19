import { useEffect } from 'react'
import { ArrowLeft, Save, Share2 } from 'lucide-react'
import { Editor } from '@/components/editor/Editor'
import { PreviewPane } from '@/components/preview/PreviewPane'
import { Button } from '@/components/ui/button'
import { selectEditorMode, useStudio } from '@/store'

const NoSelectionActions = () => null

/** Existing Markdown papers keep their editor and export pipeline, with paper chrome. */
export function MarkdownPaperWorkbench({ pid }: { pid: string }) {
  const title = useStudio((s) => s.project?.title)
  const activeBook = useStudio((s) => s.activeBook)
  const view = useStudio((s) => s.editorView)
  const save = useStudio((s) => s.save)
  const share = useStudio((s) => s.openCollabCenter)
  const readonly = useStudio(selectEditorMode) === 'readonly'
  useEffect(() => {
    useStudio.getState().setActiveBook('all')
    useStudio.getState().setEditorView('source')
  }, [pid, activeBook, view])
  return <div className="flex h-dvh flex-col overflow-hidden bg-app" data-testid="markdown-paper-workbench">
    <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-3 border-b border-border bg-panel px-4 py-2">
      <a href="#/" aria-label="返回项目列表"><ArrowLeft className="size-4" /></a>
      <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h1>
      <span className="text-xs text-fg-muted">Markdown 论文</span>
      <Button size="sm" variant="outline" onClick={() => share('members')}><Share2 aria-hidden />协作</Button>
      <Button size="sm" disabled={readonly} onClick={() => void save()}><Save aria-hidden />保存</Button>
    </header>
    <main className="grid min-h-0 flex-1 grid-rows-2 md:grid-cols-2 md:grid-rows-1">
      <section className="min-h-0 overflow-hidden border-b border-border md:border-r md:border-b-0" aria-label="论文源码">
        {activeBook === 'all' && view === 'source' && <Editor className="h-full" chrome={false} renderExtension={NoSelectionActions} />}
      </section>
      <section className="min-h-0 overflow-hidden" aria-label="论文预览"><PreviewPane /></section>
    </main>
  </div>
}

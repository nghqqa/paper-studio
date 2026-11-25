import { lazy, Suspense } from 'react'
import { X } from 'lucide-react'

const SimplePdfView = lazy(() => import('@/components/pdf/SimplePdfView'))

/** 源文件只读预览弹层（图片/PDF；后端 raw 端点带 CSP sandbox）。 */
export function SourcePreviewOverlay({
  pid,
  preview,
  onClose,
}: {
  pid: string
  preview: { path: string; kind: 'image' | 'pdf' }
  onClose(): void
}) {
  const url = `/api/projects/${encodeURIComponent(pid)}/latex/raw/${preview.path.split('/').map(encodeURIComponent).join('/')}`
  return (
    <div
      role="dialog"
      aria-label={`预览 ${preview.path}`}
      data-testid="latex-source-preview"
      className="fixed inset-0 z-popover grid place-items-center bg-black/55 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl bg-panel shadow-md">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3 text-xs">
          <span className="min-w-0 truncate font-medium text-fg-strong" title={preview.path}>
            {preview.path}
          </span>
          <a
            className="ml-auto shrink-0 text-fg-muted underline-offset-2 hover:text-fg hover:underline"
            href={`${url}?dl=1`}
            data-testid="latex-preview-download"
          >
            下载
          </a>
          <button
            type="button"
            className="shrink-0 rounded p-1 text-fg-muted transition-colors hover:bg-hover hover:text-fg"
            onClick={onClose}
            aria-label="关闭预览"
            data-testid="latex-preview-close"
          >
            <X aria-hidden className="size-4" />
          </button>
        </div>
        {preview.kind === 'image' ? (
          <div className="grid min-h-0 flex-1 place-items-center overflow-auto bg-paper-canvas p-3">
            <img
              src={url}
              alt={preview.path}
              className="max-h-[76vh] max-w-full bg-white object-contain"
              data-testid="latex-preview-image"
            />
          </div>
        ) : (
          <div className="h-[76vh] w-full overflow-auto bg-paper-canvas" data-testid="latex-preview-pdf">
            <Suspense fallback={<div className="p-3 text-xs text-fg-muted">加载 PDF…</div>}>
              <SimplePdfView url={url} />
            </Suspense>
          </div>
        )}
      </div>
    </div>
  )
}

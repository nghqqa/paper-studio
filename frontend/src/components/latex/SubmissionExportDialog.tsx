import { useEffect, useState } from 'react'
import { AlertTriangle, Download, Loader2, Package } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { latexApi, type SubmissionPreviewReply } from '@/lib/api/latex'
import { triggerBlobDownload } from '@/lib/api/net'

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

export function SubmissionExportDialog({
  pid,
  open,
  onOpenChange,
}: {
  pid: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [stripComments, setStripComments] = useState(true)
  const [includeBbl, setIncludeBbl] = useState(true)
  const [pruneMedia, setPruneMedia] = useState(true)
  const [loading, setLoading] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [preview, setPreview] = useState<SubmissionPreviewReply | null>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    if (!open) return
    let active = true
    setLoading(true)
    setErr('')
    void latexApi
      .previewSubmission(pid, {
        strip_comments: stripComments,
        include_bbl: includeBbl,
        prune_unused_media: pruneMedia,
      })
      .then((res) => {
        if (active) setPreview(res)
      })
      .catch((e: unknown) => {
        if (active) setErr(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [pid, open, stripComments, includeBbl, pruneMedia])

  const handleDownload = async () => {
    if (downloading) return
    setDownloading(true)
    setErr('')
    try {
      const { blob, filename } = await latexApi.downloadSubmission(pid, {
        strip_comments: stripComments,
        include_bbl: includeBbl,
        prune_unused_media: pruneMedia,
      })
      triggerBlobDownload(blob, filename)
      onOpenChange(false)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setDownloading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!downloading) onOpenChange(next) }}>
      <DialogContent size="md" className="max-h-[90dvh] overflow-y-auto text-sm" data-testid="submission-export-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <Package aria-hidden className="size-4 text-primary" />
            干净投稿源码打包（arXiv / 期刊提交包）
          </DialogTitle>
          <p className="text-xs text-fg-muted">
            自动清理草稿注释、附带编译产物 .bbl 并剔除正文未引用的冗余图片，不会改动原始工作区文件。
          </p>
        </DialogHeader>

        <div className="space-y-2 text-xs">
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={stripComments}
              onChange={(e) => setStripComments(e.target.checked)}
              data-testid="sub-opt-comments"
            />
            <span>剥离 .tex 注释（保留 \% 转义与 verbatim/lstlisting 等代码环境）</span>
          </label>
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={includeBbl}
              onChange={(e) => setIncludeBbl(e.target.checked)}
              data-testid="sub-opt-bbl"
            />
            <span>自动附带最近一次编译生成的 .bbl 文件</span>
          </label>
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={pruneMedia}
              onChange={(e) => setPruneMedia(e.target.checked)}
              data-testid="sub-opt-prune"
            />
            <span>剔除正文中未被 \includegraphics 引用的冗余图片</span>
          </label>
        </div>

        {err && (
          <p role="alert" className="rounded border border-danger-dot/30 bg-danger-bg px-2.5 py-1.5 text-xs text-danger-fg">
            {err}
          </p>
        )}

        {loading && (
          <p className="flex items-center gap-1.5 text-xs text-fg-muted">
            <Loader2 aria-hidden className="size-3.5 animate-spin" /> 正在统计打包清单…
          </p>
        )}

        {!loading && preview && (
          <div className="space-y-2 rounded border border-border bg-panel p-2.5 text-xs" data-testid="submission-export-preview">
            <div className="flex flex-wrap items-center justify-between gap-2 text-fg">
              <span>将打包 {preview.included_files.length} 个文件</span>
              <span className="font-mono text-fg-muted">
                ZIP {fmtBytes(preview.zip_size_bytes)}（原始 {fmtBytes(preview.total_bytes)}）
              </span>
            </div>
            <div className="text-fg-muted">
              {preview.stripped_tex_count > 0 && <span>已净化 {preview.stripped_tex_count} 个 .tex · </span>}
              <span>{preview.bbl_file ? `已附带 ${preview.bbl_file}` : '未附带 .bbl'}</span>
              {preview.pruned_media.length > 0 && (
                <span> · 已剔除 {preview.pruned_media.length} 个未引用媒体</span>
              )}
            </div>
            {preview.pruned_media.length > 0 && (
              <p className="break-all text-2xs text-fg-muted">
                已裁剪图片：{preview.pruned_media.join('、')}
              </p>
            )}
            {preview.warnings.length > 0 && (
              <div className="space-y-1 rounded bg-warn-bg px-2 py-1.5 text-warn-fg">
                {preview.warnings.map((w, i) => (
                  <p key={i} className="flex items-start gap-1">
                    <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                    <span>{w}</span>
                  </p>
                ))}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={downloading}>
            取消
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={loading || downloading || !preview}
            onClick={() => void handleDownload()}
            data-testid="submission-export-download"
          >
            {downloading ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : <Download aria-hidden className="size-3.5" />}
            下载干净投稿 ZIP
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

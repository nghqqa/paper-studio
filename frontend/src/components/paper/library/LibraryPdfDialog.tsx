import { useEffect, useState } from 'react'
import { Check, Copy, ExternalLink, FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { libraryApi, type LibraryEntry } from '@/lib/api/library'

export function LibraryPdfDialog({
  open,
  onOpenChange,
  pid,
  entry,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  pid: string
  entry: LibraryEntry
}) {
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [text, setText] = useState('')
  const [pages, setPages] = useState<number>(entry.pdf?.pages ?? 0)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!open) return
    let active = true
    setLoading(true)
    setErr('')
    libraryApi
      .entryPdfText(pid, entry.reference_id)
      .then((res) => {
        if (!active) return
        setText(res.text)
        setPages(res.pages)
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
  }, [open, pid, entry.reference_id])

  const pdfUrl = libraryApi.entryPdfUrl(pid, entry.reference_id)

  const copyCite = async () => {
    try {
      await navigator.clipboard.writeText(`\\cite{${entry.citation_key}}`)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      /* ignore */
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-screen flex-col overflow-hidden sm:max-w-5xl" data-testid="library-pdf-dialog">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2 pr-6 text-sm">
            <FileText aria-hidden className="size-4 text-primary" />
            <span className="truncate">{entry.title || entry.citation_key}</span>
            <span className="rounded bg-sunken px-1.5 py-0.5 font-mono text-xs text-fg-muted">
              {entry.citation_key} · {pages} 页
            </span>
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2 border-b border-line pb-2 text-xs text-fg-muted">
          <span className="truncate">
            {entry.authors.slice(0, 3).join(', ')}
            {entry.year ? ` (${entry.year})` : ''}
            {entry.venue ? ` · ${entry.venue}` : ''}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <Button size="xs" variant="outline" onClick={() => void copyCite()} data-testid="library-pdf-copy-cite">
              {copied ? <Check aria-hidden className="size-3" /> : <Copy aria-hidden className="size-3" />}
              {copied ? '已复制' : `复制 \\cite{${entry.citation_key}}`}
            </Button>
            <Button asChild size="xs" variant="outline">
              <a href={pdfUrl} target="_blank" rel="noreferrer">
                <ExternalLink aria-hidden className="size-3" /> 新窗口打开 PDF
              </a>
            </Button>
          </div>
        </div>
        <div className="grid min-h-96 flex-1 grid-cols-1 gap-3 overflow-hidden md:grid-cols-2">
          <div className="min-h-80 overflow-hidden rounded border border-line bg-app">
            <iframe src={pdfUrl} title={entry.title || entry.citation_key} className="h-full min-h-96 w-full border-0" />
          </div>
          <div className="flex min-h-80 flex-col overflow-hidden rounded border border-line bg-sunken p-2">
            <div className="mb-1 shrink-0 text-xs font-medium text-fg-strong">文字层全文摘录（前 12 页）</div>
            {loading && <p className="text-xs text-fg-muted">正在加载文字层…</p>}
            {err && <p role="alert" className="text-xs text-danger">{err}</p>}
            {!loading && !err && (
              <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words font-sans text-xs leading-5 text-fg" data-testid="library-pdf-extracted-text">
                {text || '（该 PDF 未检测到可提取的文字层）'}
              </pre>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

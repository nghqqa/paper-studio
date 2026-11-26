import { useEffect, useState } from 'react'
import { ImagePlus, Loader2, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { latexApi } from '@/lib/api/latex'

function deriveStem(file: File | null): string {
  if (!file) return `fig-${Math.floor(Date.now() / 1000)}`
  const base = file.name.replace(/\.[^.]+$/, '')
  const safe = base.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  return safe || `fig-${Math.floor(Date.now() / 1000)}`
}

function fileExt(file: File | null): string {
  if (!file) return 'png'
  const m = file.name.toLowerCase().match(/\.(png|jpe?g|webp|svg|pdf)$/)
  if (m) return m[1] === 'jpeg' ? 'jpg' : m[1]
  if (file.type === 'image/jpeg') return 'jpg'
  if (file.type === 'image/webp') return 'webp'
  if (file.type === 'image/svg+xml') return 'svg'
  if (file.type === 'application/pdf') return 'pdf'
  return 'png'
}

export function PasteImageDialog({
  pid,
  open,
  initialFile,
  existingPaths,
  onOpenChange,
  onUploaded,
  onInsert,
}: {
  pid: string
  open: boolean
  initialFile: File | null
  existingPaths: Set<string>
  onOpenChange: (open: boolean) => void
  onUploaded: () => void
  onInsert: (snippet: string) => void
}) {
  const [file, setFile] = useState<File | null>(initialFile)
  const [stem, setStem] = useState('')
  const [caption, setCaption] = useState('')
  const [label, setLabel] = useState('')
  const [width, setWidth] = useState('0.8\\linewidth')
  const [overwrite, setOverwrite] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [previewUrl, setPreviewUrl] = useState('')

  useEffect(() => {
    if (!open) return
    setFile(initialFile)
    const nextStem = deriveStem(initialFile)
    setStem(nextStem)
    setCaption('')
    setLabel(`fig:${nextStem}`)
    setOverwrite(false)
    setErr('')
  }, [open, initialFile])

  useEffect(() => {
    if (!file || !file.type.startsWith('image/')) {
      setPreviewUrl('')
      return
    }
    const url = URL.createObjectURL(file)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  const ext = fileExt(file)
  const cleanStem = (stem.trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'figure').slice(0, 80)
  const relPath = `figures/${cleanStem}.${ext}`
  const exists = existingPaths.has(relPath)

  const handleConfirm = async () => {
    if (!file || busy) return
    setBusy(true)
    setErr('')
    try {
      const r = await latexApi.uploadFile(pid, relPath, file, overwrite || exists)
      onUploaded()
      const cap = caption.trim() || cleanStem
      const lbl = label.trim() || `fig:${cleanStem}`
      const snippet = `\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=${width}]{${r.path}}\n  \\caption{${cap}}\n  \\label{${lbl}}\n\\end{figure}\n`
      onInsert(snippet)
      onOpenChange(false)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next) }}>
      <DialogContent size="sm" className="max-h-[90dvh] overflow-y-auto text-xs" data-testid="paste-image-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5 text-sm">
            <ImagePlus aria-hidden className="size-4 text-primary" />
            上传插图并插入 figure 环境
          </DialogTitle>
          <p className="text-xs text-fg-muted">
            图片将上传至工程 {relPath} 并自动在光标处生成可编译的 LaTeX 插图代码。
          </p>
        </DialogHeader>

        <div className="space-y-2.5">
          <div className="flex items-center gap-2">
            <label className="inline-flex cursor-pointer items-center gap-1 rounded border border-border bg-panel px-2 py-1 hover:bg-hover">
              <Upload aria-hidden className="size-3.5" />
              {file ? '更换图片' : '选择本地图片'}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/svg+xml,application/pdf"
                className="hidden"
                data-testid="paste-image-file-input"
                onChange={(e) => {
                  const picked = e.target.files?.[0] ?? null
                  if (!picked) return
                  setFile(picked)
                  const nextStem = deriveStem(picked)
                  setStem(nextStem)
                  setLabel(`fig:${nextStem}`)
                }}
              />
            </label>
            <span className="truncate text-fg-muted">{file ? `${file.name} (${Math.max(1, Math.round(file.size / 1024))} KB)` : '未选择文件（亦可在编辑器中 Ctrl+V 粘贴截图）'}</span>
          </div>

          {previewUrl && (
            <div className="flex max-h-40 justify-center overflow-hidden rounded border border-border bg-panel p-1.5">
              <img src={previewUrl} alt="待插入图片预览" className="max-h-36 object-contain" />
            </div>
          )}

          <div>
            <label htmlFor="paste-img-stem" className="mb-1 block text-fg-muted">保存文件名（figures/&lt;名称&gt;.{ext}）</label>
            <Input
              id="paste-img-stem"
              size="sm"
              value={stem}
              onChange={(e) => setStem(e.target.value)}
              data-testid="paste-image-stem"
            />
            {exists && (
              <label className="mt-1 flex cursor-pointer items-center gap-1.5 text-warn-fg">
                <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
                <span>目标路径 {relPath} 已存在，勾选以覆盖</span>
              </label>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor="paste-img-cap" className="mb-1 block text-fg-muted">图注（\\caption）</label>
              <Input id="paste-img-cap" size="sm" value={caption} placeholder={cleanStem} onChange={(e) => setCaption(e.target.value)} />
            </div>
            <div>
              <label htmlFor="paste-img-lbl" className="mb-1 block text-fg-muted">标签（\\label）</label>
              <Input id="paste-img-lbl" size="sm" value={label} onChange={(e) => setLabel(e.target.value)} />
            </div>
          </div>

          <div>
            <label htmlFor="paste-img-width" className="mb-1 block text-fg-muted">排版宽度</label>
            <select
              id="paste-img-width"
              value={width}
              onChange={(e) => setWidth(e.target.value)}
              className="h-sm w-full rounded border border-border bg-panel px-2 text-xs"
            >
              <option value="0.8\\linewidth">0.8\linewidth（单栏常用）</option>
              <option value="\\linewidth">\linewidth（满栏宽）</option>
              <option value="0.6\\linewidth">0.6\linewidth（紧凑）</option>
              <option value="0.45\\textwidth">0.45\textwidth（并排子图）</option>
            </select>
          </div>
        </div>

        {err && <p role="alert" className="text-xs text-danger-fg">{err}</p>}

        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            取消
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!file || busy}
            onClick={() => void handleConfirm()}
            data-testid="paste-image-confirm"
          >
            {busy && <Loader2 aria-hidden className="size-3.5 animate-spin" />}
            上传并插入光标
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

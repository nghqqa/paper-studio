import { useMemo, useState } from 'react'
import { Copy } from 'lucide-react'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { figuresApi, type ProjectFigure } from '@/lib/api/projectFigures'
import { copyText } from '@/lib/download'

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

/** 清洗图名为 LaTeX 文件名（仅 [A-Za-z0-9_-]）；纯中文等清洗为空时回退 fid。 */
function sanitizeStem(name: string, fid: string): string {
  const stem = (name || '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return stem.slice(0, 80) || fid
}

/** 发布到 LaTeX 弹窗：可编辑目标文件名 + 可选覆盖 + 片段复制（轻量，无 excalidraw）。 */
export function PublishLatexDialog({ pid, figure, onClose, onPublished }: {
  pid: string
  figure: ProjectFigure
  onClose: () => void
  onPublished: (path: string, snippet?: string) => void
}) {
  const isChart = figure.kind !== 'diagram'
  const initial = useMemo(() => sanitizeStem(figure.name, figure.id), [figure])
  const [stem, setStem] = useState(initial)
  const [overwrite, setOverwrite] = useState(false)
  const [format, setFormat] = useState<'pdf' | 'png'>('pdf')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [snippet, setSnippet] = useState('')
  // 发布成功后展示服务端返回的真实落盘路径（stem 经服务端清洗，可能与输入不同）。
  const [publishedPath, setPublishedPath] = useState('')

  async function publish() {
    if (busy) return
    setBusy(true); setErr('')
    try {
      const payload = isChart
        ? { stem: stem.trim(), overwrite, format }
        : { stem: stem.trim(), overwrite }
      const reply = await figuresApi.publishLatex(pid, figure.id, payload)
      setSnippet(reply.snippet)
      setPublishedPath(reply.path)
      onPublished(reply.path, reply.snippet)
    } catch (error) {
      setErr(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  async function copySnippet() {
    const ok = await copyText(snippet)
    if (ok) setErr('')
    else setErr('无法复制，请允许浏览器访问剪贴板后重试')
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose() }}>
      <DialogContent className="diagram-publish-dialog" data-testid="publish-latex-dialog">
        <DialogHeader>
          <DialogTitle>发布到 LaTeX</DialogTitle>
          <p>
            把「{figure.name}」的{isChart ? '矢量 PDF 或高清 PNG' : ' PNG '}写入 LaTeX 工程 figures/ 目录，并生成可粘贴的 figure 片段。
          </p>
        </DialogHeader>
        {err && <p className="paper-figures-error" role="alert">{err}</p>}
        {snippet ? (
          <div>
            <p role="status">已发布 {publishedPath}，粘贴以下片段：</p>
            <pre data-testid="publish-latex-snippet">{snippet}</pre>
            <button type="button" className="paper-secondary" onClick={() => void copySnippet()}><Copy aria-hidden /> 复制片段</button>
            <button type="button" className="paper-secondary" onClick={onClose}>关闭</button>
          </div>
        ) : (
          <>
            {isChart && (
              <>
                <label htmlFor="publish-latex-format">导出格式</label>
                <select
                  id="publish-latex-format"
                  data-testid="publish-latex-format"
                  value={format}
                  onChange={(e) => setFormat(e.target.value as 'pdf' | 'png')}
                >
                  <option value="pdf">矢量 PDF（推荐，投稿清晰）</option>
                  <option value="png">高清 PNG</option>
                </select>
              </>
            )}
            <label htmlFor="publish-latex-stem">目标文件名（figures/&lt;名称&gt;.{isChart ? format : 'png'}）</label>
            <input id="publish-latex-stem" data-testid="publish-latex-stem" value={stem}
              onChange={(e) => setStem(e.target.value)} />
            <label>
              <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
              覆盖同名文件
            </label>
            <DialogFooter>
              <button type="button" className="paper-secondary" onClick={onClose} disabled={busy}>取消</button>
              <button type="button" className="paper-primary" data-testid="publish-latex-confirm"
                onClick={() => void publish()} disabled={busy}>发布</button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { computeDiff } from '@/components/paper/proposalDiff'
import { latexApi } from '@/lib/api/latex'

/** 409 保存冲突可视化对比与合并弹窗 */
export function LatexConflictDialog({
  pid,
  file,
  localContent,
  open,
  onOpenChange,
  onMerged,
}: {
  pid: string
  file: string
  localContent: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onMerged: (mergedContent: string, newSha: string) => void
}) {
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [serverContent, setServerContent] = useState('')
  const [serverSha, setServerSha] = useState('')
  const [merged, setMerged] = useState('')

  useEffect(() => {
    if (!open || !file) return
    let alive = true
    setLoading(true)
    setError('')
    void latexApi
      .read(pid, file)
      .then((res) => {
        if (!alive) return
        setServerContent(res.content)
        setServerSha(res.sha)
        setMerged(localContent)
      })
      .catch((e: unknown) => {
        if (!alive) return
        setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [open, pid, file, localContent])

  const diffParts = useMemo(
    () => (loading ? [] : computeDiff(serverContent, localContent)),
    [loading, serverContent, localContent],
  )

  const saveMerged = async () => {
    if (saving || !serverSha) return
    setSaving(true)
    setError('')
    try {
      const reply = await latexApi.save(pid, file, merged, serverSha)
      onMerged(merged, reply.sha)
      onOpenChange(false)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !saving) onOpenChange(false) }}>
      <DialogContent className="max-h-[90dvh] max-w-4xl overflow-y-auto" data-testid="latex-conflict-dialog">
        <DialogHeader>
          <DialogTitle>解决保存冲突：{file}</DialogTitle>
          <DialogDescription>
            红底删除段为服务器较新内容，绿底新增段为当前本地内容。请在下方编辑最终合并文本并保存。
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="flex items-center gap-2 py-8 text-sm text-fg-muted">
            <Loader2 aria-hidden className="size-4 animate-spin" />
            正在读取服务器最新版本…
          </div>
        ) : (
          <div className="space-y-3 text-xs">
            <div className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-sunken p-2 font-mono leading-5" data-testid="latex-conflict-diff">
              {diffParts.map((part, idx) =>
                part.type === 'same' ? (
                  <span key={idx}>{part.text}</span>
                ) : part.type === 'del' ? (
                  <del key={idx} className="bg-danger/10 text-danger">{part.text}</del>
                ) : (
                  <ins key={idx} className="bg-ok/10 text-ok no-underline">{part.text}</ins>
                ),
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-fg-strong">合并结果（可直接编辑）：</span>
              <Button type="button" size="xs" variant="outline" onClick={() => setMerged(serverContent)}>
                填入服务器版本
              </Button>
              <Button type="button" size="xs" variant="outline" onClick={() => setMerged(localContent)}>
                填入本地版本
              </Button>
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() =>
                  setMerged(
                    `% <<<<<<< 服务器版本\n${serverContent}\n% =======\n${localContent}\n% >>>>>>> 本地修改`,
                  )
                }
              >
                插入冲突对照块
              </Button>
            </div>
            <textarea
              className="h-52 w-full rounded-md border border-line bg-app p-2 font-mono text-xs leading-5 outline-none"
              value={merged}
              onChange={(e) => setMerged(e.target.value)}
              data-testid="latex-conflict-merged-input"
            />
          </div>
        )}
        {error && <p role="alert" className="text-xs text-danger-fg">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            type="button"
            disabled={loading || saving || !serverSha}
            onClick={() => void saveMerged()}
            data-testid="latex-conflict-save-merged"
          >
            {saving ? '保存中…' : '保存合并结果'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

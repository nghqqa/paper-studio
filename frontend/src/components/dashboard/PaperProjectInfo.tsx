import { useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/api'
import type { ProjectSummary } from '@/lib/types'
import { useStudio } from '@/store'
import { PAPER_STAGES, paperStage } from './paperProjects'

export function PaperProjectInfo({ row, onClose }: { row: ProjectSummary; onClose(): void }) {
  const [title, setTitle] = useState(row.title)
  const [venue, setVenue] = useState(row.submission?.venue ?? '')
  const [deadline, setDeadline] = useState(row.submission?.deadline ?? '')
  const [field, setField] = useState(row.submission?.field ?? '')
  const [rank, setRank] = useState(row.submission?.rank ?? '')
  const [stage, setStage] = useState(paperStage(row))
  const [keywords, setKeywords] = useState(row.submission?.keywords ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const load = useStudio((s) => s.loadDashboard)
  return <Dialog open onOpenChange={(v) => { if (!v && !busy) onClose() }}>
    <DialogContent data-testid="paper-project-info" className="max-h-[90dvh] overflow-y-auto">
      <DialogHeader><DialogTitle>项目信息</DialogTitle><DialogDescription>记录论文阶段、标签和投稿计划。</DialogDescription></DialogHeader>
      <form onSubmit={async (event) => {
        event.preventDefault(); setBusy(true); setError('')
        try {
          await api.saveSettings(row.id, { title: title.trim(), submission: { ...row.submission, venue: venue.trim(), field: field.trim(), rank: rank.trim(), deadline, stage: stage === paperStage(row) ? row.submission?.stage ?? '' : stage === 'unset' ? '' : stage, keywords: keywords.trim() } })
          await load(); onClose()
        } catch (e) { setError(e instanceof Error ? e.message : '保存失败，请重试') }
        finally { setBusy(false) }
      }} className="space-y-4">
        <div className="space-y-1"><Label htmlFor="paper-info-title">项目名称</Label><Input id="paper-info-title" required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} /></div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1"><Label htmlFor="paper-info-stage">写作阶段</Label><select id="paper-info-stage" className="h-9 w-full rounded-md border border-border bg-panel px-2 text-sm" value={stage} onChange={(e) => setStage(e.target.value as typeof stage)}>{PAPER_STAGES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></div>
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label htmlFor="paper-info-deadline">投稿截止</Label>
              {deadline && <button type="button" className="text-xs text-fg-muted hover:text-fg" onClick={() => setDeadline('')}>清除</button>}
            </div>
            <Input id="paper-info-deadline" type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
          </div>
        </div>
        <div className="space-y-1"><Label htmlFor="paper-info-venue">投稿目标</Label><Input id="paper-info-venue" maxLength={200} placeholder="期刊或会议名称" value={venue} onChange={(e) => setVenue(e.target.value)} /></div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1"><Label htmlFor="paper-info-field">学科领域</Label><Input id="paper-info-field" maxLength={200} value={field} onChange={(e) => setField(e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="paper-info-rank">等级分区</Label><Input id="paper-info-rank" maxLength={200} value={rank} onChange={(e) => setRank(e.target.value)} /></div>
        </div>
        <div className="space-y-1"><Label htmlFor="paper-info-tags">标签</Label><Input id="paper-info-tags" maxLength={200} placeholder="如：自然语言处理，毕业论文" value={keywords} onChange={(e) => setKeywords(e.target.value)} /><p className="text-xs text-fg-muted">多个标签用逗号分隔。</p></div>
        {error && <p role="alert" className="text-sm text-danger-fg">{error}</p>}
        <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={onClose}>取消</Button><Button type="submit" disabled={busy || !title.trim()}>{busy ? '保存中…' : '保存'}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}

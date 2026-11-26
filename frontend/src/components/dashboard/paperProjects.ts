import type { ProjectSummary } from '@/lib/types'

export const PAPER_STAGES = [
  { id: 'unset', label: '未设置阶段' },
  { id: 'draft', label: '草稿' },
  { id: 'internal_review', label: '内部审阅' },
  { id: 'ready', label: '待投稿' },
  { id: 'submitted', label: '审稿中' },
  { id: 'revision', label: '返修' },
  { id: 'accepted', label: '已录用' },
] as const
export type PaperStage = typeof PAPER_STAGES[number]['id']
export type PaperSort = 'recent' | 'oldest' | 'deadline' | 'title'
export type PaperGroup = 'none' | 'stage' | 'venue' | 'format'

export function paperStage(row: ProjectSummary): PaperStage {
  return PAPER_STAGES.find((s) => s.id === row.submission?.stage)?.id ?? 'unset'
}
export const stageLabel = (stage: PaperStage) => PAPER_STAGES.find((s) => s.id === stage)!.label
export const formatLabel = (row: ProjectSummary) => row.source_format === 'docx' ? 'Word' : row.source_format === 'latex' ? 'LaTeX' : 'Markdown'
export function paperTags(row: ProjectSummary): string[] {
  return [...new Set((row.submission?.keywords ?? '').split(/[,，;；、]/).map((s) => s.trim()).filter(Boolean))]
}
export const paperOwner = (row: ProjectSummary, authOff: boolean) => row.owner?.display_name || row.owner?.email || (authOff || row.my_role === 'owner' ? '我' : '未设置')
export const paperOwnerKey = (row: ProjectSummary, authOff: boolean) => row.owner?.user_id || (authOff ? 'local' : row.my_role === 'owner' ? 'self' : 'unassigned')

/** Calendar-day arithmetic: no UTC/local-midnight or daylight-saving drift. */
export function deadlineDays(value: string | undefined, now = new Date()): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? '')
  if (!match) return null
  const [year, month, day] = match.slice(1).map(Number)
  const utc = Date.UTC(year, month - 1, day)
  const date = new Date(utc)
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return Math.round((utc - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000)
}

export function sortPaperRows(rows: ProjectSummary[], sort: PaperSort): ProjectSummary[] {
  return [...rows].sort((a, b) => {
    const tie = () => b.mtime - a.mtime || a.id.localeCompare(b.id)
    if (sort === 'title') return a.title.localeCompare(b.title, 'zh-CN') || tie()
    if (sort === 'deadline') {
      const date = (r: ProjectSummary) => deadlineDays(r.submission?.deadline) == null ? '9999-99-99' : r.submission!.deadline!
      return date(a).localeCompare(date(b)) || tie()
    }
    return sort === 'oldest' ? -tie() : tie()
  })
}

export function groupPaperRows(rows: ProjectSummary[], group: PaperGroup): [string, ProjectSummary[]][] {
  if (group === 'none') return [['', rows]]
  const grouped = new Map<string, ProjectSummary[]>()
  for (const row of rows) {
    const key = group === 'stage' ? stageLabel(paperStage(row)) : group === 'venue' ? row.submission?.venue || '未设置投稿目标' : formatLabel(row)
    grouped.set(key, [...(grouped.get(key) ?? []), row])
  }
  return [...grouped.entries()]
}

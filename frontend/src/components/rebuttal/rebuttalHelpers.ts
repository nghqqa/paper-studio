import type { RebuttalItem, RebuttalLocation, RebuttalStatus } from '@/lib/api/rebuttal'
import type { RebuttalExportFormat } from '@/lib/api/rebuttal'

export const STATUS_ZH: Record<RebuttalStatus, string> = { todo: '待处理', drafted: '草稿', addressed: '已修改' }
export const CATEGORY_ZH: Record<string, string> = { major: '重大', minor: '次要', editorial: '编辑性', general: '一般' }
export const STATUSES: RebuttalStatus[] = ['todo', 'drafted', 'addressed']
export const EXPORTS: { fmt: RebuttalExportFormat; label: string }[] = [
  { fmt: 'docx', label: 'DOCX' },
  { fmt: 'tex', label: 'TeX' },
  { fmt: 'md', label: 'MD' },
]

export const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export interface ItemForm {
  status: RebuttalStatus
  response: string
  editsSummary: string
  location: RebuttalLocation
}

export const formOf = (it: RebuttalItem): ItemForm => ({
  status: it.status,
  response: it.response,
  editsSummary: it.edits_summary,
  location: { ...(it.location ?? {}) },
})

export const FIELD_CLS = 'w-full rounded-md border border-line bg-app p-2 text-xs leading-5'

import { postSse, req, type SseOptions } from './net'

/**
 * P1-1 审稿回复信（Rebuttal / Response Letter）API。后端 /api/projects/{pid}/rebuttal（仅 paper 项目）。
 * 拆条（JSON 文本 / txt·md·pdf 上传）→ 逐条状态·回复·修改位置更新 → AI 起草建议（ai_draft）→ 导出 docx/md/tex。
 * 契约：AI 只写建议字段 ai_draft，绝不覆盖用户 response；稿件文件零接触。
 */
export type RebuttalStatus = 'todo' | 'drafted' | 'addressed'
export type RebuttalCategory = 'major' | 'minor' | 'editorial' | 'general'
export type RebuttalMode = 'replace' | 'append'
export type RebuttalExportFormat = 'docx' | 'md' | 'tex'

export interface RebuttalLocation {
  file?: string | null
  line?: number | null
  section?: string | null
  label?: string | null
}

export interface RebuttalAiDraft {
  response_draft: string
  edits_summary_draft: string
  created_at: string
}

export interface RebuttalSnapshot {
  type: 'word-version' | 'latex-history'
  sha: string
  vid?: string | null
  file?: string | null
}

export interface RebuttalItem {
  id: string
  reviewer: string
  category: RebuttalCategory
  text: string
  status: RebuttalStatus
  location: RebuttalLocation | null
  response: string
  edits_summary: string
  ai_draft: RebuttalAiDraft | null
  updated_at: string | null
  round: number
  /** B3 工程锚点：平台批注线程 id（uuid12）+ 已保存版本快照 */
  comment_ids?: string[]
  snapshot?: RebuttalSnapshot | null
}

export interface RebuttalState {
  updated_at: string | null
  round: number
  items: RebuttalItem[]
  warnings: string[]
}

export interface RebuttalParseResult {
  round: number
  items: RebuttalItem[]
  warnings: string[]
}

export interface RebuttalDraftResult {
  item: RebuttalItem
  warnings: string[]
}

export interface RebuttalItemPatch {
  status?: RebuttalStatus | null
  location?: RebuttalLocation | null
  response?: string | null
  edits_summary?: string | null
  comment_ids?: string[] | null
  snapshot?: RebuttalSnapshot | null
}

export interface RebuttalRoundSummary {
  round: number
  items: number
  archived_at: string | null
}

export interface RebuttalRoundDetail {
  round: number
  archived_at: string | null
  items: RebuttalItem[]
}

const enc = encodeURIComponent

export const rebuttalApi = {
  load: (pid: string) => req<RebuttalState>(`/api/projects/${enc(pid)}/rebuttal`),

  parse: (pid: string, text: string, mode: RebuttalMode = 'replace') =>
    req<RebuttalParseResult>(`/api/projects/${enc(pid)}/rebuttal/parse`, {
      method: 'POST',
      body: JSON.stringify({ text, mode }),
    }),

  parseFile: (pid: string, file: File, mode: RebuttalMode = 'replace') => {
    const fd = new FormData()
    fd.append('file', file, file.name)
    fd.append('mode', mode)
    return req<RebuttalParseResult>(`/api/projects/${enc(pid)}/rebuttal/parse`, { method: 'POST', body: fd })
  },

  rounds: (pid: string) => req<{ rounds: RebuttalRoundSummary[] }>(`/api/projects/${enc(pid)}/rebuttal/rounds`),
  round: (pid: string, n: number) =>
    req<RebuttalRoundDetail>(`/api/projects/${enc(pid)}/rebuttal/rounds/${n}`),
  updateItem: (pid: string, itemId: string, patch: RebuttalItemPatch) =>
    req<RebuttalItem>(`/api/projects/${enc(pid)}/rebuttal/items/${enc(itemId)}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),

  draft: (pid: string, itemId: string, context?: string | null) =>
    req<RebuttalDraftResult>(`/api/projects/${enc(pid)}/rebuttal/items/${enc(itemId)}/draft`, {
      method: 'POST',
      body: JSON.stringify({ context: context ?? null }),
    }),

  draftStream: (pid: string, itemId: string, context?: string | null, opts?: SseOptions) =>
    postSse<RebuttalDraftResult>(
      `/api/projects/${enc(pid)}/rebuttal/items/${enc(itemId)}/draft/stream`,
      { context: context ?? null },
      opts,
    ),

  /** 产物 URL 不 fetch，交给 downloadFile 触发浏览器下载（Content-Disposition 命名）。 */
  exportUrl: (pid: string, format: RebuttalExportFormat) =>
    `/api/projects/${enc(pid)}/rebuttal/export?format=${format}`,
}

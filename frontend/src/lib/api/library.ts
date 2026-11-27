import { handle, netFetch, req } from './net'

/**
 * 智能文献管理 API（v0.4）。
 * LaTeX 工程 mode="bib"（.bib 是事实源，index 是可重建视图）；Word 等 mode="index"。
 */

export interface FieldProvenance {
  source: string
  confirmed: boolean
  at: number
}

export interface SourceQuery {
  source: string
  query: string
  at: number
  matched: boolean
  note: string | null
}

export interface RetractionInfo {
  status: 'retracted' | 'corrected' | 'unknown'
  source: string | null
  checked_at: number | null
  note: string | null
}

export interface LibraryEntry {
  reference_id: string
  citation_key: string
  entry_type: string
  title: string
  authors: string[]
  year: string | null
  venue: string | null
  volume: string | null
  number: string | null
  pages: string | null
  publisher: string | null
  doi: string | null
  arxiv_id: string | null
  url: string | null
  abstract: string | null
  keywords: string | null
  fields: Record<string, string>
  raw_bibtex: string
  field_provenance: Record<string, FieldProvenance>
  queries: SourceQuery[]
  retraction: RetractionInfo | null
  verified: 'unverified' | 'verified' | 'conflict'
  bib_files: string[]
  suggested?: Record<string, string>
  suggested_model?: string | null
  origin?: string
  pdf?: EntryPdfMeta
  created_at: number
  updated_at: number
}

export interface EntryPdfMeta {
  has_pdf: boolean
  filename: string
  pages: number
  size: number
  text_chars: number
  uploaded_at: number
}

export interface LibraryDiagnostics {
  duplicate_keys: { key: string; reference_ids: string[]; bib_files: string[] }[]
  fuzzy_duplicates: { reference_ids: string[]; title: string }[]
  missing_fields: { reference_id: string; citation_key: string; missing: string[] }[]
  undefined_in_tex: string[]
  uncited_entries: string[]
  parse_errors: { line: number; raw: string; error: string }[]
}

export interface CiteStyle {
  style: 'natbib' | 'biblatex' | 'plain'
  command: string
  detected_from: string
}

export interface LibraryReply {
  mode: 'bib' | 'index'
  schema_version: number
  entries: LibraryEntry[]
  diagnostics: LibraryDiagnostics
  bib_files: string[]
  cite_style: CiteStyle | null
  source_labels: Record<string, string>
}

export interface ImportPreviewEntry extends LibraryEntry {
  duplicates: { kind: string; reference_id: string; citation_key: string }[]
  key_conflict: boolean
  suggested_key: string
}

export interface ImportReply {
  entries: ImportPreviewEntry[]
  errors: { line: number; raw: string; error: string }[]
  total_blocks: number
}

export interface PdfExtractFileReport {
  filename: string
  status: 'matched' | 'partial' | 'failed'
  source?: string
  doi?: string | null
  arxiv_id?: string | null
  title?: string
  warning?: string
  error?: string
}

export interface PdfExtractReply extends ImportReply {
  files: PdfExtractFileReport[]
}

/** Zotero 公开群组（v0.5）。 */
export interface ZoteroGroup {
  id: number
  name: string
  description: string
}

export interface ZoteroCollection {
  key: string
  name: string
  parent: string | null
}

export type ZoteroLibraryType = 'group' | 'user'

export interface ZoteroImportSource {
  provider: 'zotero'
  group_id: number | null
  collection_key: string | null
  group_name: string
  library_type: ZoteroLibraryType
  zotero_user_id: string | null
}

export interface ZoteroCredentials {
  has_api_key: boolean
  api_key_hint: string
  zotero_user_id: string | null
  updated_at: number | null
}

export interface ZoteroRefreshEntry {
  reference_id: string
  citation_key: string
  in_citation_order?: boolean
}

export interface ZoteroRefreshUpdate {
  reference_id: string
  citation_key: string
  old: Record<string, string>
  new: Record<string, string>
  entry: Record<string, unknown>
}

export interface ZoteroRefreshPreview {
  source: { provider: 'zotero'; library_type: ZoteroLibraryType; group_id: number | null;
            collection_key: string | null; zotero_user_id: string | null }
  mode: 'bib' | 'index'
  truncated: boolean
  counts: { added: number; updated: number; removed: number; unchanged: number }
  added: Record<string, unknown>[]
  updated: ZoteroRefreshUpdate[]
  removed: ZoteroRefreshEntry[]
  removed_supported: boolean
  notice?: string
}

export interface ZoteroPreviewReply extends ImportReply {
  group: ZoteroGroup
  source: { provider: 'zotero'; library_type: ZoteroLibraryType; group_id: number | null;
            collection_key: string | null; zotero_user_id: string | null; truncated: boolean }
  notice?: string
}

export interface SourceCandidate {
  candidate: {
    source: string
    matched: boolean
    query: string
    fields: Record<string, unknown>
    retraction: RetractionInfo | null
  }
  diff: { field: string; current: string; source: string; same: boolean }[] | null
}

const enc = encodeURIComponent

export interface CitationVerifyDiff {
  field: string
  local: string
  remote: string
}

export interface CitationVerifyRemoteFields {
  title?: string
  year?: string
  authors?: string[]
  venue?: string
  doi?: string
  url?: string
}

export interface CitationVerifyItem {
  reference_id: string
  citation_key: string
  status: 'verified' | 'mismatch' | 'retracted' | 'unverified' | 'error'
  source: string | null
  title_similarity: number
  matched_title: string
  matched_year: string
  matched_doi: string
  remote_fields?: CitationVerifyRemoteFields
  retraction_status: string
  diffs: CitationVerifyDiff[]
  reason: string
  checked_at: number
}

export interface CitationVerifyReport {
  checked_at: number | null
  total: number
  batch_size: number
  truncated: boolean
  max_batch: number
  counts: { verified: number; mismatch: number; retracted: number; unverified: number; error: number }
  items: CitationVerifyItem[]
}

export const libraryApi = {
  get: (pid: string) => req<LibraryReply>(`/api/projects/${enc(pid)}/library`),
  reindex: (pid: string) =>
    req<{ entries: number }>(`/api/projects/${enc(pid)}/library/reindex`, { method: 'POST', body: JSON.stringify({}) }),
  import: (pid: string, text: string) =>
    req<ImportReply>(`/api/projects/${enc(pid)}/library/import`, { method: 'POST', body: JSON.stringify({ text }) }),
  extractPdf: (pid: string, files: File[]) => {
    const fd = new FormData()
    for (const f of files) fd.append('files', f)
    return req<PdfExtractReply>(`/api/projects/${enc(pid)}/library/extract-pdf`, { method: 'POST', body: fd })
  },
  commit: (pid: string, entries: Record<string, unknown>[], targetBib: string | null, baseSha?: string | null,
           source?: ZoteroImportSource) =>
    req<{ reference_ids: string[]; bib_sha: string | null; total: number }>(`/api/projects/${enc(pid)}/library/commit`, {
      method: 'POST',
      body: JSON.stringify({ entries, target_bib: targetBib, base_sha: baseSha ?? null, source: source ?? null }),
    }),
  zoteroCollections: (pid: string, groupId: string, libraryType: ZoteroLibraryType = 'group', zoteroUserId?: string | null) =>
    req<{ group: ZoteroGroup; collections: ZoteroCollection[] }>(`/api/projects/${enc(pid)}/library/zotero/collections`, {
      method: 'POST',
      body: JSON.stringify({ group_id: groupId, library_type: libraryType, zotero_user_id: zoteroUserId ?? null }),
    }),
  zoteroPreview: (pid: string, groupId: string, collectionKey?: string | null,
                  libraryType?: ZoteroLibraryType, zoteroUserId?: string | null) =>
    req<ZoteroPreviewReply>(`/api/projects/${enc(pid)}/library/zotero/preview`, {
      method: 'POST',
      body: JSON.stringify({ group_id: groupId, collection_key: collectionKey ?? null,
                             library_type: libraryType ?? 'group', zotero_user_id: zoteroUserId ?? null }),
    }),
  /** B2 修补：导入记录回显（恢复最近一次可刷新来源）。 */
  zoteroImports: (pid: string) =>
    req<{ imports: Record<string, unknown>[]; latest_refreshable: Record<string, unknown> | null }>(
      `/api/projects/${enc(pid)}/library/zotero/imports`),
  /** B2 v2：私有库授权（用户级凭据；key 本体只在 PUT 请求体，永不回传）。 */
  zoteroCredentials: () =>
    req<{ credentials: ZoteroCredentials }>('/api/zotero/credentials'),
  saveZoteroCredentials: (apiKey: string, zoteroUserId: string) =>
    req<{ ok: boolean; credentials: ZoteroCredentials }>('/api/zotero/credentials', {
      method: 'PUT', body: JSON.stringify({ api_key: apiKey, zotero_user_id: zoteroUserId }),
    }),
  clearZoteroCredentials: () =>
    req<{ ok: boolean; removed: boolean; credentials: ZoteroCredentials }>('/api/zotero/credentials', { method: 'DELETE' }),
  zoteroRefreshPreview: (pid: string, source: Pick<ZoteroImportSource, 'library_type' | 'group_id' | 'collection_key' | 'zotero_user_id'>) =>
    req<ZoteroRefreshPreview>(`/api/projects/${enc(pid)}/library/zotero/refresh-preview`, {
      method: 'POST',
      body: JSON.stringify({ library_type: source.library_type, group_id: source.group_id,
                             collection_key: source.collection_key, zotero_user_id: source.zotero_user_id }),
    }),
  zoteroRefreshCommit: (pid: string, source: Pick<ZoteroImportSource, 'library_type' | 'group_id' | 'collection_key' | 'group_name' | 'zotero_user_id'>,
                        payload: { additions: Record<string, unknown>[]; updates: { reference_id: string; entry: Record<string, unknown> }[];
                                   removals: string[]; remove_from_citation_order: boolean;
                                   target_bib?: string | null; base_sha?: string | null }) =>
    req<{ ok: boolean; applied: { added: number; updated: number; removed: number } }>(`/api/projects/${enc(pid)}/library/zotero/refresh-commit`, {
      method: 'POST',
      body: JSON.stringify({ library_type: source.library_type, group_id: source.group_id,
                             collection_key: source.collection_key, group_name: source.group_name,
                             zotero_user_id: source.zotero_user_id, ...payload }),
    }),
  lookup: (pid: string, body: { doi?: string; arxiv?: string; query?: string; reference_id?: string }) =>
    req<{ candidates: SourceCandidate[]; existing_reference_id: string | null }>(`/api/projects/${enc(pid)}/library/lookup`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  confirm: (pid: string, rid: string, fields: string[]) =>
    req<{ entry: LibraryEntry | null }>(`/api/projects/${enc(pid)}/library/entries/${enc(rid)}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ fields }),
    }),
  editEntry: (pid: string, rid: string, fields: Record<string, string>, baseSha?: string | null) =>
    req<{ entry: LibraryEntry | null; bib_sha: string | null }>(`/api/projects/${enc(pid)}/library/entries/${enc(rid)}`, {
      method: 'PATCH',
      body: JSON.stringify({ fields, base_sha: baseSha ?? null }),
    }),
  deleteEntry: (pid: string, rid: string, baseSha?: string | null) =>
    req<{ ok: boolean }>(`/api/projects/${enc(pid)}/library/entries/${enc(rid)}`, {
      method: 'DELETE',
      body: JSON.stringify({ base_sha: baseSha ?? null }),
    }),
  merge: (pid: string, body: Record<string, unknown>) =>
    req<{ merged_reference_id: string; renames: Record<string, string>; tex_updates: { replaced: number }[] }>(
      `/api/projects/${enc(pid)}/library/merge`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  newBibFile: (pid: string, name: string) =>
    req<{ path: string; sha: string }>(`/api/projects/${enc(pid)}/library/bib-file`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  citations: (pid: string) =>
    req<{ usage: Record<string, { file: string; count: number }[]>; cited_files: Record<string, string[]> }>(
      `/api/projects/${enc(pid)}/library/citations`,
    ),
  bibliography: (pid: string, order: string[], style = 'ieee') =>
    req<{ style: string; labels: Record<string, string>; bibliography: string[]; note: string }>(
      `/api/projects/${enc(pid)}/library/bibliography`,
      { method: 'POST', body: JSON.stringify({ order, style }) },
    ),
  registerCitations: (pid: string, append: string[]) =>
    req<{ order: string[]; changed: boolean }>(
      `/api/projects/${enc(pid)}/library/citations/register`,
      { method: 'POST', body: JSON.stringify({ append }) },
    ),
  aiSuggest: (pid: string, rid: string) =>
    req<{ suggested: Record<string, string>; model: string | null; note: string }>(
      `/api/projects/${enc(pid)}/library/entries/${enc(rid)}/ai-suggest`,
      { method: 'POST', body: JSON.stringify({}) },
    ),
  exportUrl: (pid: string, format: 'bibtex' | 'csl-json') =>
    `/api/projects/${enc(pid)}/library/export?format=${format}`,
  getVerify: (pid: string) =>
    req<CitationVerifyReport>(`/api/projects/${enc(pid)}/library/verify`),
  runVerify: (pid: string, referenceIds?: string[]) =>
    req<CitationVerifyReport>(`/api/projects/${enc(pid)}/library/verify`, {
      method: 'POST',
      body: JSON.stringify({ reference_ids: referenceIds ?? null }),
    }),
  uploadEntryPdf: (pid: string, rid: string, file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return req<{ pdf: EntryPdfMeta }>(`/api/projects/${enc(pid)}/library/entries/${enc(rid)}/pdf`, {
      method: 'POST',
      body: fd,
    })
  },
  entryPdfUrl: (pid: string, rid: string, version?: number | string) =>
    `/api/projects/${enc(pid)}/library/entries/${enc(rid)}/pdf${version ? `?v=${encodeURIComponent(String(version))}` : ''}`,
  entryPdfText: (pid: string, rid: string) =>
    req<{
      filename: string
      pages: number
      text: string
      reference_id: string
      citation_key: string
      title: string
      authors: string[]
      year: string | null
      venue: string | null
    }>(`/api/projects/${enc(pid)}/library/entries/${enc(rid)}/pdf/text`),
  deleteEntryPdf: async (pid: string, rid: string) => {
    const res = await netFetch(`/api/projects/${enc(pid)}/library/entries/${enc(rid)}/pdf`, {
      method: 'DELETE',
    })
    return handle<{ ok: boolean }>(res)
  },
}

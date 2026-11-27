import { P, req } from './net'

export interface SharedLibraryItem {
  id: string
  citation_key: string
  entry_type: string
  title: string
  authors: string[]
  year: string | null
  venue: string | null
  doi: string | null
  arxiv_id: string | null
  url: string | null
  abstract: string | null
  raw_bibtex: string
  tags: string[]
  source_project: string | null
  updated_at: number
}

export interface LatexSnippetItem {
  id: string
  title: string
  category: string
  description: string
  code: string
  builtin?: boolean
  updated_at?: number
}

export const sharedAssetsApi = {
  listLibrary: () => req<{ items: SharedLibraryItem[] }>('/api/shared/library'),
  addLibrary: (body: { bibtex?: string; entries?: Record<string, unknown>[]; from_project_id?: string; reference_ids?: string[] }) =>
    req<{ added: number; items: SharedLibraryItem[] }>('/api/shared/library', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  deleteLibraryItem: (id: string) =>
    req<{ ok: boolean; items: SharedLibraryItem[] }>(`/api/shared/library/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  importToProject: (pid: string, itemIds: string[], targetBib?: string) =>
    req<{ imported: number; reference_ids: string[]; total: number }>(`${P(pid)}/library/import-from-shared`, {
      method: 'POST',
      body: JSON.stringify({ item_ids: itemIds, target_bib: targetBib ?? null }),
    }),
  listSnippets: () => req<{ items: LatexSnippetItem[] }>('/api/shared/snippets'),
  saveSnippet: (body: { id?: string; title: string; category?: string; description?: string; code: string }) =>
    req<{ item: LatexSnippetItem; items: LatexSnippetItem[] }>('/api/shared/snippets', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  deleteSnippet: (id: string) =>
    req<{ ok: boolean; items: LatexSnippetItem[] }>(`/api/shared/snippets/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
}

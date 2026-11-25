import type { LibraryReply } from '@/lib/api/library'

export type CitationStyle = 'gb-t-7714-2015' | 'ieee' | 'springer-lncs' | 'acm' | 'elsevier-vancouver'

export const CITATION_STYLE_LABELS: Record<CitationStyle, string> = {
  'gb-t-7714-2015': 'GB/T 7714-2015（默认）',
  ieee: 'IEEE',
  'springer-lncs': 'Springer LNCS',
  acm: 'ACM',
  'elsevier-vancouver': 'Elsevier Vancouver',
}

export const SOURCE_LABEL_FALLBACK: Record<string, string> = {
  user: '用户提供',
  bib: 'BibTeX 文件',
  crossref: 'Crossref',
  openalex: 'OpenAlex',
  arxiv: 'arXiv',
  ai_suggested: 'AI 建议（未验证）',
}

export type LibraryTab = 'list' | 'import' | 'diagnostics'

export function errText(e: unknown): string {
  const anyErr = e as { message?: string; detail?: { message?: string } }
  return anyErr?.detail?.message || anyErr?.message || String(e)
}

export function diagCount(lib: LibraryReply | null): number {
  if (!lib) return 0
  const d = lib.diagnostics
  return (
    d.duplicate_keys.length +
    d.fuzzy_duplicates.length +
    d.missing_fields.length +
    d.undefined_in_tex.length +
    (d.parse_errors?.length ?? 0)
  )
}

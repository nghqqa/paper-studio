import { P, req } from './net'

export type GlossaryCategory = 'term' | 'notation' | 'acronym'

export interface GlossaryEntry {
  id: string
  term: string
  category: GlossaryCategory
  aliases: string[]
  symbol: string
  definition: string
  enforce: boolean
  updated_at: number
}

export interface GlossaryCandidate {
  term: string
  category: GlossaryCategory
  symbol: string
  definition: string
  aliases: string[]
  source_file: string
  exists: boolean
}

export const glossaryApi = {
  list: (pid: string) => req<{ entries: GlossaryEntry[] }>(`${P(pid)}/glossary`),
  upsert: (
    pid: string,
    body: {
      id?: string
      term: string
      category: GlossaryCategory
      aliases?: string[]
      symbol?: string
      definition?: string
      enforce?: boolean
    },
  ) =>
    req<{ entry: GlossaryEntry; entries: GlossaryEntry[] }>(`${P(pid)}/glossary`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  update: (
    pid: string,
    gid: string,
    patch: Partial<{
      term: string
      category: GlossaryCategory
      aliases: string[]
      symbol: string
      definition: string
      enforce: boolean
    }>,
  ) =>
    req<{ entry: GlossaryEntry; entries: GlossaryEntry[] }>(
      `${P(pid)}/glossary/${encodeURIComponent(gid)}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    ),
  remove: (pid: string, gid: string) =>
    req<{ ok: boolean; entries: GlossaryEntry[] }>(
      `${P(pid)}/glossary/${encodeURIComponent(gid)}`,
      { method: 'DELETE' },
    ),
  extract: (pid: string, commit = false) =>
    req<{ candidates: GlossaryCandidate[]; added: number; entries: GlossaryEntry[] }>(
      `${P(pid)}/glossary/extract`,
      { method: 'POST', body: JSON.stringify({ commit }) },
    ),
}

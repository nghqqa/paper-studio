// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { libraryApi, type LibraryEntry, type SourceCandidate } from '@/lib/api/library'
import { EntryDetail } from '../EntryDetail'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

let host: HTMLDivElement | null = null
let root: Root | null = null

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = null
  vi.restoreAllMocks()
})

const PREPRINT: LibraryEntry = {
  reference_id: 'r1',
  citation_key: 'doe2025paper',
  entry_type: 'article',
  title: 'Attention Is All You Need',
  authors: ['Doe, Jane'],
  year: '2025',
  venue: 'arXiv',
  volume: null,
  number: null,
  pages: null,
  publisher: null,
  doi: null,
  arxiv_id: '2501.00001',
  url: null,
  abstract: null,
  keywords: null,
  fields: {},
  raw_bibtex: '',
  field_provenance: {},
  queries: [],
  retraction: null,
  verified: 'unverified',
  bib_files: ['refs.bib'],
  created_at: 1,
  updated_at: 1,
}

describe('EntryDetail arXiv 预印本升级正式版', () => {
  it('预印本条目显示「升级正式版」按钮并优先展示正式出版候选', async () => {
    const candidates: SourceCandidate[] = [
      {
        candidate: {
          source: 'arxiv',
          matched: true,
          query: PREPRINT.title,
          retraction: null,
          fields: { title: 'Attention Is All You Need', authors: 'Doe, Jane', year: '2025', venue: 'arXiv', arxiv_id: '2501.00001' },
        },
        diff: [],
      },
      {
        candidate: {
          source: 'crossref',
          matched: true,
          query: PREPRINT.title,
          retraction: null,
          fields: { title: 'Attention Is All You Need', authors: 'Doe, Jane', year: '2025', venue: 'NeurIPS', doi: '10.5555/neurips.2025' },
        },
        diff: [{ field: 'venue', current: 'arXiv', source: 'NeurIPS', same: false }],
      },
    ]
    const spy = vi.spyOn(libraryApi, 'lookup').mockResolvedValue({ candidates } as unknown as Awaited<ReturnType<typeof libraryApi.lookup>>)

    host = document.body.appendChild(document.createElement('div'))
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <EntryDetail
          pid="p1"
          entry={PREPRINT}
          canEdit
          sourceLabels={{}}
          onChanged={() => {}}
          onNotice={() => {}}
          onError={() => {}}
          entries={[PREPRINT]}
        />,
      )
    })

    const btn = host.querySelector<HTMLButtonElement>('[data-testid="library-upgrade-preprint-doe2025paper"]')!
    expect(btn).not.toBeNull()
    await act(async () => btn.click())
    await act(async () => {})

    expect(spy).toHaveBeenCalledWith('p1', { query: PREPRINT.title, reference_id: 'r1' })
    const box = host.querySelector('[data-testid="library-lookup-result-doe2025paper"]')!
    expect(box.textContent).toContain('检测到正式发表版本候选')
    expect(box.textContent).toContain('正式出版')
    // NeurIPS 正式候选应排在 arXiv 前面
    const boxText = box.textContent ?? ''
    expect(boxText.indexOf('NeurIPS')).toBeLessThan(boxText.indexOf('来源 arxiv'))
  })
})

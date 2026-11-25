// @vitest-environment jsdom
import axe from 'axe-core'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { latexApi, type LatexDiffItem, type LatexVersion } from '@/lib/api/latex'
import { LatexHistory } from '../LatexHistory'

vi.mock('@/lib/api/latex', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/api/latex')>()
  return {
    ...mod,
    latexApi: {
      ...mod.latexApi,
      history: vi.fn(),
      historyDiff: vi.fn(),
      restoreVersion: vi.fn(),
      listDiffs: vi.fn(),
      createMilestone: vi.fn(),
      deleteMilestone: vi.fn(),
      generateDiffPdf: vi.fn(),
    },
  }
})

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

let host: HTMLDivElement | null = null
let root: Root | null = null

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

function renderHistory(canEdit = true) {
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  act(() => root!.render(<LatexHistory pid="p1" canEdit={canEdit} onRestore={() => Promise.resolve('ok')} />))
}

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = null
  vi.restoreAllMocks()
})

async function violations(el: Element = document.body) {
  const res = await axe.run(el, {
    resultTypes: ['violations'],
    rules: { 'color-contrast': { enabled: false }, 'scrollable-region-focusable': { enabled: false }, region: { enabled: false } },
  })
  return res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
}

const VERSIONS: LatexVersion[] = [
  {
    sha: 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111',
    at: 1761500000,
    message: 'milestone 初稿投稿',
    author: 'author@univ.edu.cn',
    added: 5,
    deleted: 1,
    files: 1,
    milestones: ['初稿投稿'],
  },
]

const DIFF_ITEM: LatexDiffItem = {
  diff_id: '20261125-131000-000000001',
  pid: 'p1',
  engine: 'xelatex',
  base_sha: VERSIONS[0]!.sha,
  target_sha: 'work',
  base_label: '初稿投稿 (aaaa111)',
  target_label: '当前工作区',
  status: 'ok',
  error: null,
  elapsed_ms: 800,
  created_at: 1761500100,
  pdf_url: '/api/projects/p1/latex/diffs/20261125-131000-000000001/pdf',
}

describe('LatexHistory 命名里程碑与返修高亮 PDF', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(latexApi.history).mockResolvedValue(VERSIONS)
    vi.mocked(latexApi.historyDiff).mockResolvedValue({ a: VERSIONS[0]!.sha, b: 'work', diff: '+revised' })
    vi.mocked(latexApi.listDiffs).mockResolvedValue({ available: true, items: [] })
    vi.mocked(latexApi.createMilestone).mockResolvedValue({ name: '二轮返修', sha: VERSIONS[0]!.sha, at: 1761500200, author: 'author@univ.edu.cn' })
    vi.mocked(latexApi.deleteMilestone).mockResolvedValue({ ok: true })
    vi.mocked(latexApi.generateDiffPdf).mockResolvedValue(DIFF_ITEM)
  })

  it('展示里程碑徽章、支持新增/移除里程碑、生成返修高亮 PDF 下载链接且无障碍合规', async () => {
    renderHistory(true)
    await act(async () => {})

    expect(host!.querySelector('[data-testid="latex-version-milestones"]')?.textContent).toContain('初稿投稿')
    expect(await violations(host!)).toEqual([])

    const input = host!.querySelector<HTMLInputElement>('[data-testid="latex-milestone-input"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '二轮返修')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => host!.querySelector<HTMLFormElement>('form')!.requestSubmit())
    expect(latexApi.createMilestone).toHaveBeenCalledWith('p1', '二轮返修', undefined)

    await act(async () => host!.querySelector<HTMLButtonElement>('[data-testid="latex-history-list"] [role="option"]')!.click())
    await act(async () => {})
    expect(await violations(host!)).toEqual([])

    await act(async () => host!.querySelector<HTMLButtonElement>('[data-testid="latex-diff-pdf-btn"]')!.click())
    await act(async () => {})
    expect(latexApi.generateDiffPdf).toHaveBeenCalledWith('p1', VERSIONS[0]!.sha, 'work')
    const link = host!.querySelector<HTMLAnchorElement>('[data-testid="latex-diff-pdf-link"]')
    expect(link?.getAttribute('href')).toContain('/diffs/20261125-131000-000000001/pdf?download=1')

    await act(async () => host!.querySelector<HTMLButtonElement>('[data-testid="latex-milestone-del-初稿投稿"]')!.click())
    expect(latexApi.deleteMilestone).toHaveBeenCalledWith('p1', '初稿投稿')
  })
})

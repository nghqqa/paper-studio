// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api/net'
import { wordApi } from '@/lib/api/word'
import { libraryApi } from '@/lib/api/library'
import { useStudio } from '@/store'
import type { ProjectDetail } from '@/lib/types'
import { WordWorkbench } from '../WordWorkbench'
import { loadOnlyOffice } from '../onlyoffice'

vi.mock('@/lib/api/word', () => ({ wordApi: { editorConfig: vi.fn(), state: vi.fn(), save: vi.fn(), downloadUrl: vi.fn(() => '/saved.docx'), versionDownloadUrl: vi.fn(), exportPdf: vi.fn(), uploadVersion: vi.fn(), renumberCitations: vi.fn() } }))
vi.mock('@/lib/api/library', () => ({ libraryApi: { get: vi.fn(), registerCitations: vi.fn(), bibliography: vi.fn(), exportUrl: vi.fn(() => '/exp') } }))
vi.mock('@/lib/api/refsPlugin', () => ({ runRefsTaskAuto: vi.fn(), bridgeAlive: vi.fn(), refreshDocKey: vi.fn() }))
vi.mock('@/lib/download', () => ({ downloadFile: vi.fn() }))
vi.mock('../onlyoffice', () => ({ loadOnlyOffice: vi.fn() }))
vi.mock('@/components/paper/ProposalPanel', () => ({ ProposalPanel: () => null }))
vi.mock('@/components/word/WordPreflightPanel', () => ({ WordPreflightPanel: () => null }))

let root: Root | null = null
let host: HTMLElement
let events: Record<string, (data?: unknown) => void>
let destroy = vi.fn<() => void>()
const state = { sha: 'abc', version: 1, updated_at: '2026-10-21T00:00:00Z', saving: false, versions: [{ id: 'v1', sha: 'abc', created_at: '2026-10-21T00:00:00Z', source: 'create' }] }
const EMPTY_LIB = {
  mode: 'index', entries: [], bib_files: [], source_labels: {}, cite_style: null,
  diagnostics: { duplicate_keys: [], fuzzy_duplicates: [], missing_fields: [], undefined_in_tex: [], parse_errors: [] },
}

beforeAll(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true })
beforeEach(() => {
  vi.resetAllMocks()
  destroy = vi.fn()
  useStudio.setState({ project: { id: 'p', title: '中文论文', settings: { source_format: 'docx' } } as ProjectDetail })
  vi.mocked(wordApi.editorConfig).mockResolvedValue({ document_server_url: 'https://docs.test', config: { document: { permissions: { edit: true, download: true } }, editorConfig: { mode: 'edit' }, token: 'server-signed' } })
  vi.mocked(wordApi.state).mockResolvedValue(state)
  vi.mocked(libraryApi.get).mockResolvedValue(EMPTY_LIB as never)
  class DocEditor {
    constructor(_id: string, config: Record<string, unknown>) { events = config.events as typeof events }
    destroyEditor() { destroy() }
  }
  vi.mocked(loadOnlyOffice).mockResolvedValue({ DocEditor })
})
afterEach(async () => { await act(async () => root?.unmount()); root = null; host?.remove() })

async function mount() {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  await act(async () => root!.render(<WordWorkbench pid="p" />))
  await act(async () => events.onDocumentReady())
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === '文献')!.click())
  return host
}

async function flush(times = 4) {
  for (let i = 0; i < times; i++) await act(async () => { await Promise.resolve() })
}

async function clickRenumber() {
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="library-renumber-citations"]')!.click())
  await flush()
}

describe('Word 文献面板「按出现顺序重排引用」（P1-0-B）', () => {
  it('按钮仅在 Word 文献面板渲染，未保存修改时先确认；取消则不调用 API', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await mount()
    expect(host.querySelector('[data-testid="library-renumber-citations"]')).not.toBeNull()
    await act(async () => { events.onDocumentStateChange({ data: true }); events.onDocumentStateChange({ data: false }) })
    await clickRenumber()
    expect(confirmSpy).toHaveBeenCalledOnce()
    expect(String(confirmSpy.mock.calls[0][0])).toContain('尚未保存的修改将被丢弃')
    expect(wordApi.renumberCitations).not.toHaveBeenCalled()
  })

  it('确认后带当前 sha 调用；changed=true 清脏、刷新快照并重载编辑器（新 doc_key）', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await mount()
    await act(async () => { events.onDocumentStateChange({ data: true }); events.onDocumentStateChange({ data: false }) })
    const renumbered = { changed: true, mapping: { '2': '1', '1': '2' }, order: ['rid-b', 'rid-a'], warnings: [], rebuilt_block: true,
      doc_key: 'rotated-key',
      state: { ...state, sha: 'newsha', version: 2, versions: [...state.versions, { id: 'v2', sha: 'newsha', created_at: '2026-11-17T00:00:00Z', source: 'renumber-citations' }] } }
    vi.mocked(wordApi.renumberCitations).mockResolvedValue(renumbered)
    await clickRenumber()
    expect(wordApi.renumberCitations).toHaveBeenCalledWith('p', { style: 'gb-t-7714-2015', expected_sha: 'abc' })
    expect(host.textContent).toContain('已按出现顺序重排引用（映射 2 处编号）')
    expect(host.textContent).not.toContain('有修改待确认保存')
    expect(destroy).toHaveBeenCalledOnce()
    expect(wordApi.editorConfig).toHaveBeenCalledTimes(2)
  })

  it('changed=false 幂等：提示无需修改，不重载编辑器', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    await mount()
    vi.mocked(wordApi.renumberCitations).mockResolvedValue({ changed: false, mapping: {}, order: ['rid-a', 'rid-b'], warnings: [], rebuilt_block: false, doc_key: 'same-key', state })
    await clickRenumber()
    expect(wordApi.renumberCitations).toHaveBeenCalledWith('p', { style: 'gb-t-7714-2015', expected_sha: 'abc' })
    expect(host.textContent).toContain('引用已按出现顺序排列，无需修改')
    expect(destroy).not.toHaveBeenCalled()
    expect(wordApi.editorConfig).toHaveBeenCalledTimes(1)
  })

  it('409 冲突展示错误并刷新服务器快照，不重载编辑器', async () => {
    await mount()
    vi.mocked(wordApi.renumberCitations).mockRejectedValue(new ApiError(409, '服务器在此期间已有他人保存新版本，请刷新核对最新版本后再重排'))
    await clickRenumber()
    expect(host.textContent).toContain('他人保存新版本')
    expect(wordApi.state).toHaveBeenCalledTimes(2)
    expect(wordApi.editorConfig).toHaveBeenCalledTimes(1)
    expect(destroy).not.toHaveBeenCalled()
  })

  it('重排警示回显在文献面板（warnings 透传）', async () => {
    await mount()
    vi.mocked(wordApi.renumberCitations).mockResolvedValue({
      changed: true, mapping: { '3': '1', '1': '2' }, order: ['rid-c', 'rid-a', 'rid-b'], warnings: ['托管参考文献表已按新顺序重建（3 条，样式 gb-t-7714-2015）'], rebuilt_block: true,
      doc_key: 'rotated', state,
    })
    await clickRenumber()
    // changed=true 会重载编辑器（侧栏重开），警示并入工作台状态行展示
    expect(host.textContent).toContain('托管参考文献表已按新顺序重建')
  })
})

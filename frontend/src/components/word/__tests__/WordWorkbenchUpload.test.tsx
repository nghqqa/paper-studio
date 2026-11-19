// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api/net'
import { wordApi } from '@/lib/api/word'
import { useStudio } from '@/store'
import type { ProjectDetail } from '@/lib/types'
import { WordWorkbench } from '../WordWorkbench'
import { loadOnlyOffice } from '../onlyoffice'

vi.mock('@/lib/api/word', () => ({ wordApi: { editorConfig: vi.fn(), state: vi.fn(), save: vi.fn(), downloadUrl: vi.fn(() => '/saved.docx'), versionDownloadUrl: vi.fn(), exportPdf: vi.fn(), uploadVersion: vi.fn() } }))
vi.mock('@/lib/download', () => ({ downloadFile: vi.fn() }))
vi.mock('../onlyoffice', () => ({ loadOnlyOffice: vi.fn() }))

let root: Root | null = null
let host: HTMLElement
let events: Record<string, (data?: unknown) => void>
let destroy = vi.fn<() => void>()
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const state = { sha: 'abc', version: 1, updated_at: '2026-10-21T00:00:00Z', saving: false, versions: [{ id: 'v1', sha: 'abc', created_at: '2026-10-21T00:00:00Z', source: 'create' }] }

beforeAll(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true })
beforeEach(() => {
  vi.resetAllMocks()
  destroy = vi.fn()
  useStudio.setState({ project: { id: 'p', title: '中文论文', settings: { source_format: 'docx' } } as ProjectDetail })
  vi.mocked(wordApi.editorConfig).mockResolvedValue({ document_server_url: 'https://docs.test', config: { document: { permissions: { edit: true, download: true } }, editorConfig: { mode: 'edit' }, token: 'server-signed' } })
  vi.mocked(wordApi.state).mockResolvedValue(state)
  vi.mocked(wordApi.versionDownloadUrl).mockImplementation((pid, id) => `/api/projects/${pid}/word/versions/${id}/download`)
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
  return host
}

const openDrawer = async () => {
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === '版本')!.click())
}

const pickLocalDocx = async () => {
  const input = host.querySelector<HTMLInputElement>('aside input[type="file"]')!
  Object.defineProperty(input, 'files', { value: [new File([new Uint8Array([1])], 'local.docx', { type: DOCX })], configurable: true })
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
}

describe('版本抽屉上传本地修改稿', () => {
  it('上传入口仅可编辑（canSave）用户可见', async () => {
    await mount()
    await act(async () => events.onDocumentReady())
    await openDrawer()
    expect(host.querySelector('aside [data-testid="word-upload-version"]')).not.toBeNull()
    expect(host.querySelector('aside [data-testid="word-upload-version"]')!.textContent).toContain('上传本地修改稿')
    await act(async () => root!.unmount()); root = null
    vi.mocked(wordApi.editorConfig).mockResolvedValue({ document_server_url: 'https://docs.test', config: { document: { permissions: { edit: false, review: false, download: true } }, editorConfig: { mode: 'view' } } })
    await mount()
    await act(async () => events.onDocumentReady())
    await openDrawer()
    expect(host.querySelector('aside [data-testid="word-upload-version"]')).toBeNull()
  })

  it('本地有未保存修改时先弹确认警示；取消则不上传', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await mount()
    await act(async () => events.onDocumentReady())
    await act(async () => { events.onDocumentStateChange({ data: true }); events.onDocumentStateChange({ data: false }) })
    await openDrawer()
    await pickLocalDocx()
    expect(confirmSpy).toHaveBeenCalledOnce()
    expect(String(confirmSpy.mock.calls[0][0])).toContain('覆盖当前网页编辑器中的未保存修改')
    expect(wordApi.uploadVersion).not.toHaveBeenCalled()
    expect(host.textContent).not.toContain('已上传为版本')
  })

  it('确认后带当前 sha 上传，成功后清脏标记、刷新快照并重载编辑器（新 doc_key）', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await mount()
    await act(async () => events.onDocumentReady())
    await act(async () => { events.onDocumentStateChange({ data: true }); events.onDocumentStateChange({ data: false }) })
    const uploaded = { version: 2, sha: 'newsha', doc_key: 'rotated-key', unchanged: false,
      state: { ...state, sha: 'newsha', version: 2, versions: [...state.versions, { id: 'v2', sha: 'newsha', created_at: '2026-11-16T00:00:00Z', source: 'upload-version' }] } }
    vi.mocked(wordApi.uploadVersion).mockResolvedValue(uploaded)
    await openDrawer()
    await pickLocalDocx()
    await act(async () => {})
    expect(wordApi.uploadVersion).toHaveBeenCalledWith('p', expect.any(File), 'abc')
    expect(host.textContent).toContain('已上传为版本 2')
    expect(host.textContent).not.toContain('有修改待确认保存')
    expect(destroy).toHaveBeenCalledOnce()
    expect(wordApi.editorConfig).toHaveBeenCalledTimes(2)
  })

  it('409 冲突展示明确错误并刷新服务器快照，不静默强覆、不触发重载', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await mount()
    await act(async () => events.onDocumentReady())
    await openDrawer()
    vi.mocked(wordApi.uploadVersion).mockRejectedValue(new ApiError(409, '服务器在此期间已有他人保存新版本，请刷新核对最新版本后再上传'))
    await pickLocalDocx()
    await act(async () => {})
    expect(host.textContent).toContain('他人保存新版本')
    expect(wordApi.state).toHaveBeenCalledTimes(2)
    expect(wordApi.editorConfig).toHaveBeenCalledTimes(1)
    expect(destroy).not.toHaveBeenCalled()
  })
})

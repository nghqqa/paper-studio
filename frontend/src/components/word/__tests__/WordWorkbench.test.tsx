// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { wordApi } from '@/lib/api/word'
import { downloadFile } from '@/lib/download'
import { useStudio } from '@/store'
import type { ProjectDetail } from '@/lib/types'
import { WordWorkbench } from '../WordWorkbench'
import { loadOnlyOffice } from '../onlyoffice'

vi.mock('@/lib/api/word', () => ({ wordApi: { editorConfig: vi.fn(), state: vi.fn(), save: vi.fn(), downloadUrl: vi.fn(() => '/saved.docx'), versionDownloadUrl: vi.fn(), exportPdf: vi.fn() } }))
vi.mock('@/lib/download', () => ({ downloadFile: vi.fn() }))
vi.mock('../onlyoffice', () => ({ loadOnlyOffice: vi.fn() }))

let root: Root | null = null
let host: HTMLElement
let events: Record<string, (data?: unknown) => void>
let destroy = vi.fn<() => void>()
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

describe('Word 工作台', () => {
  it('加载服务端配置，文档 ready 后启用保存，卸载销毁编辑器', async () => {
    await mount()
    expect(wordApi.editorConfig).toHaveBeenCalledWith('p')
    expect(loadOnlyOffice).toHaveBeenCalledWith('https://docs.test')
    expect(host.querySelector<HTMLButtonElement>('[data-testid="word-save"]')!.disabled).toBe(true)
    await act(async () => events.onDocumentReady())
    expect(host.querySelector<HTMLButtonElement>('[data-testid="word-save"]')!.disabled).toBe(false)
    await act(async () => root!.unmount()); root = null
    expect(destroy).toHaveBeenCalledOnce()
  })

  it('保存失败保留明确错误并取消下载，不声称已保存', async () => {
    vi.mocked(wordApi.save).mockRejectedValue(new Error('文档服务未能保存'))
    await mount()
    await act(async () => events.onDocumentReady())
    await act(async () => events.onDocumentStateChange({ data: true }))
    await act(async () => events.onDocumentStateChange({ data: false }))
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="word-download"]')!.click())
    expect(host.textContent).toContain('文档服务未能保存')
    expect(host.textContent).toContain('有修改待确认保存')
    expect(host.textContent).not.toContain('已确认保存到服务器')
    expect(downloadFile).not.toHaveBeenCalled()
  })

  it('保存未确认时可显式下载历史版本，但不清除未保存标记或冒充当前修改成功', async () => {
    vi.mocked(wordApi.save).mockRejectedValue(new Error('尚未确认本次保存'))
    await mount()
    await act(async () => events.onDocumentReady())
    await act(async () => { events.onDocumentStateChange({ data: true }); events.onDocumentStateChange({ data: false }) })
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="word-download"]')!.click())
    expect(downloadFile).not.toHaveBeenCalled()
    const openVersions = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === '查看已保存版本')!
    await act(async () => openVersions.click())
    expect(host.textContent).toContain('历史版本不包含尚未回传的修改')
    const downloadVersion = [...host.querySelectorAll<HTMLButtonElement>('aside button')].find((b) => b.textContent === '下载此版本')!
    await act(async () => downloadVersion.click())
    expect(downloadFile).toHaveBeenCalledWith('/api/projects/p/word/versions/v1/download', '中文论文-v1.docx')
    expect(host.textContent).toContain('有修改待确认保存')
    expect(host.textContent).toContain('尚未确认本次保存')
    expect(host.textContent).toContain('已发起所选已保存版本的下载')
    expect(host.textContent).not.toContain('已确认保存到服务器')
    expect(wordApi.save).toHaveBeenCalledOnce()
  })

  it('只读配置保持只读，不向服务端发保存请求', async () => {
    vi.mocked(wordApi.editorConfig).mockResolvedValue({ document_server_url: 'https://docs.test', config: { document: { permissions: { edit: false, review: false, download: true } }, editorConfig: { mode: 'view' } } })
    await mount()
    await act(async () => events.onDocumentReady())
    expect(host.querySelector<HTMLButtonElement>('[data-testid="word-save"]')!.disabled).toBe(true)
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="word-download"]')!.click())
    expect(wordApi.save).not.toHaveBeenCalled()
    expect(downloadFile).toHaveBeenCalled()
  })

  it('保存等待期间又有编辑时取消下载，避免下载被当成最新稿', async () => {
    let finish!: (value: { pending: boolean; request_id: string }) => void
    vi.mocked(wordApi.save).mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    await mount()
    await act(async () => events.onDocumentReady())
    await act(async () => { events.onDocumentStateChange({ data: true }); events.onDocumentStateChange({ data: false }) })
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="word-download"]')!.click())
    expect(wordApi.save).toHaveBeenCalled()
    await act(async () => {
      events.onDocumentStateChange({ data: true })
      vi.mocked(wordApi.state).mockResolvedValue({ ...state, last_saved_request_id: 'request-1' })
      finish({ pending: true, request_id: 'request-1' })
    })
    expect(downloadFile).not.toHaveBeenCalled()
    expect(host.textContent).toContain('保存期间又有新修改')
  })

  it('本地干净时读取最新已保存版本下载，不发 forcesave，不使用打开时的旧快照', async () => {
    await mount()
    await act(async () => events.onDocumentReady())
    vi.mocked(wordApi.state).mockResolvedValue({ ...state, sha: 'newest', version: 2, versions: [...state.versions, { ...state.versions[0], id: 'v2', sha: 'newest' }] })
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="word-download"]')!.click())
    expect(wordApi.save).not.toHaveBeenCalled()
    expect(wordApi.versionDownloadUrl).toHaveBeenCalledWith('p', 'v2')
    expect(downloadFile).toHaveBeenCalledWith('/api/projects/p/word/versions/v2/download', '中文论文.docx')
  })

  it('最新状态有保存错误时立即拒绝下载', async () => {
    await mount()
    await act(async () => events.onDocumentReady())
    vi.mocked(wordApi.state).mockResolvedValue({ ...state, last_error: '原稿接收失败' })
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="word-download"]')!.click())
    expect(wordApi.save).not.toHaveBeenCalled()
    expect(downloadFile).not.toHaveBeenCalled()
    expect(host.textContent).toContain('原稿接收失败')
  })

  it('干净稿件有服务端保存正在进行时不重复发送 forcesave', async () => {
    await mount()
    await act(async () => events.onDocumentReady())
    vi.mocked(wordApi.state).mockResolvedValue({ ...state, saving: true })
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="word-download"]')!.click())
    expect(wordApi.save).not.toHaveBeenCalled()
    expect(downloadFile).not.toHaveBeenCalled()
    expect(host.textContent).toContain('请等待保存完成后再试')
  })

  it('脏稿的旧错误允许通过新请求重试，成功后才清待确认标记', async () => {
    await mount()
    await act(async () => events.onDocumentReady())
    await act(async () => { events.onDocumentStateChange({ data: true }); events.onDocumentStateChange({ data: false }) })
    vi.mocked(wordApi.state).mockResolvedValueOnce({ ...state, last_error: '上次保存失败' }).mockResolvedValue({ ...state, last_saved_request_id: 'retry-save' })
    vi.mocked(wordApi.save).mockResolvedValue({ pending: true, request_id: 'retry-save' })
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="word-save"]')!.click())
    expect(wordApi.save).toHaveBeenCalledOnce()
    expect(host.textContent).toContain('已确认保存到服务器')
    expect(host.textContent).not.toContain('有修改待确认保存')
  })

  it('自动保存更新快照后仍保留本地待确认状态，不用 SHA 变化跳过当前保存', async () => {
    await mount()
    await act(async () => events.onDocumentReady())
    await act(async () => { events.onDocumentStateChange({ data: true }); events.onDocumentStateChange({ data: false }) })
    vi.mocked(wordApi.state).mockResolvedValue({ ...state, sha: 'auto-saved', version: 2 })
    vi.mocked(wordApi.save).mockRejectedValue(new Error('另一次保存正在进行，请稍后重试'))
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="word-download"]')!.click())
    expect(wordApi.save).toHaveBeenCalledOnce()
    expect(downloadFile).not.toHaveBeenCalled()
    expect(host.textContent).toContain('有修改待确认保存')
  })

  it('脚本无法加载时呈现可重试错误', async () => {
    vi.mocked(loadOnlyOffice).mockRejectedValue(new Error('Word 编辑器加载失败'))
    await mount()
    expect(host.textContent).toContain('Word 编辑器加载失败')
    expect(host.textContent).toContain('重试')
    expect(host.querySelector<HTMLButtonElement>('[data-testid="word-save"]')!.disabled).toBe(true)
  })

  it('切换 pid 销毁旧编辑器并隔离 dirty 与迟到事件，不串入新项目', async () => {
    await mount()
    await act(async () => events.onDocumentReady())
    await act(async () => { events.onDocumentStateChange({ data: true }); events.onDocumentStateChange({ data: false }) })
    const previousEvents = events
    await act(async () => root!.render(<WordWorkbench pid="p2" />))
    expect(destroy).toHaveBeenCalledOnce()
    await act(async () => events.onDocumentReady())
    await act(async () => previousEvents.onDocumentStateChange({ data: true }))
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="word-download"]')!.click())
    expect(wordApi.save).not.toHaveBeenCalled()
    expect(wordApi.versionDownloadUrl).toHaveBeenCalledWith('p2', 'v1')
    expect(host.textContent).not.toContain('有修改待确认保存')
  })

  it('同稿重试重新加载时保留 dirty，重连后仍须本次回调确认', async () => {
    await mount()
    await act(async () => events.onDocumentReady())
    await act(async () => { events.onDocumentStateChange({ data: true }); events.onDocumentStateChange({ data: false }); events.onError() })
    const retry = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === '重试')!
    await act(async () => retry.click())
    expect(destroy).toHaveBeenCalledOnce()
    await act(async () => events.onDocumentReady())
    expect(host.textContent).toContain('有修改待确认保存')
    vi.mocked(wordApi.state).mockResolvedValueOnce(state).mockResolvedValue({ ...state, last_saved_request_id: 'after-reconnect' })
    vi.mocked(wordApi.save).mockResolvedValue({ pending: true, request_id: 'after-reconnect' })
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="word-save"]')!.click())
    expect(wordApi.save).toHaveBeenCalledOnce()
    expect(host.textContent).toContain('已确认保存到服务器')
  })

  it('返回项目列表时脏稿先保存，失败则留在稿件中', async () => {
    await mount()
    await act(async () => events.onDocumentReady())
    await act(async () => { events.onDocumentStateChange({ data: true }); events.onDocumentStateChange({ data: false }) })
    vi.mocked(wordApi.save).mockRejectedValue(new Error('保存失败，请重试'))
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    await act(async () => host.querySelector<HTMLAnchorElement>('a[href="#/"]')!.dispatchEvent(click))
    expect(click.defaultPrevented).toBe(true)
    expect(host.textContent).toContain('保存失败，请重试')
    expect(host.textContent).toContain('有修改待确认保存')
  })

  it('只读无修改时服务器保存任务不阻止返回列表，协作入口显示查看语义', async () => {
    useStudio.setState((s) => ({ project: { ...s.project!, role: 'viewer' } }))
    vi.mocked(wordApi.editorConfig).mockResolvedValue({ document_server_url: 'https://docs.test', config: { document: { permissions: { edit: false, review: false, download: true } }, editorConfig: { mode: 'view' } } })
    vi.mocked(wordApi.state).mockResolvedValue({ ...state, saving: true })
    await mount()
    await act(async () => events.onDocumentReady())
    expect(host.textContent).toContain('协作者')
    expect(host.textContent).not.toContain('邀请协作')
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    await act(async () => host.querySelector<HTMLAnchorElement>('a[href="#/"]')!.dispatchEvent(click))
    expect(click.defaultPrevented).toBe(false)
    expect(wordApi.save).not.toHaveBeenCalled()
  })

  it('服务端禁止下载时主下载、历史下载和故障回退下载全部关闭', async () => {
    vi.mocked(wordApi.editorConfig).mockResolvedValue({ document_server_url: 'https://docs.test', config: { document: { permissions: { edit: false, review: false, download: false } }, editorConfig: { mode: 'view' } } })
    await mount()
    await act(async () => events.onDocumentReady())
    expect(host.querySelector<HTMLButtonElement>('[data-testid="word-download"]')!.disabled).toBe(true)
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === '版本')!.click())
    expect(host.querySelector('aside[aria-label="Word 已保存版本"]')).not.toBeNull()
    expect(host.textContent).not.toContain('下载此版本')
    await act(async () => events.onError())
    expect(host.textContent).not.toContain('下载服务器已保存版本')
  })
})

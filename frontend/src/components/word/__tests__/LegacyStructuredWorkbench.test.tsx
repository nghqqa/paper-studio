// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { structApi, type StructContent, type StructContentReply, type StructSaveReply } from '@/lib/api/struct'
import { wordApi } from '@/lib/api/word'
import { ApiError } from '@/lib/api/net'
import { useStudio } from '@/store'
import type { ProjectDetail } from '@/lib/types'
import { LegacyStructuredWorkbench } from '../LegacyStructuredWorkbench'

vi.mock('@/lib/api/struct', () => ({ structApi: { getContent: vi.fn(), artifacts: vi.fn(), preview: vi.fn(), putContent: vi.fn() } }))
vi.mock('@/lib/api/word', () => ({ wordApi: { convertStructured: vi.fn() } }))
vi.mock('@/components/struct/StructPreviewPane', () => ({ StructPreviewPane: () => <div /> }))
vi.mock('@/components/struct/StructContinuousEditor', () => ({
  StructContinuousEditor: ({ content, onChange }: { content: StructContent; onChange: (content: StructContent) => void }) =>
    <textarea data-testid="draft-title" value={content.title} onChange={(event) => onChange({ ...content, title: event.target.value })} />,
}))

const content: StructContent = { schema_version: 1, title: '旧稿', title_en: '', authors: '', affil: '', abstract_zh: '', abstract_en: '', keywords: '', body: [] }
const initial: StructContentReply = { content, sha: 's1', versions: [] }
const saved: StructSaveReply = { saved: true, sha: 's2', version: { vid: 'v2', sha: 's2', at: 1, source: 'save' }, gate: { ok: true, errors: [], warnings: [] } }
let root: Root | null = null
let host: HTMLElement

beforeAll(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true })
beforeEach(() => {
  vi.resetAllMocks()
  useStudio.setState({ wordEditorEnabled: true, wordEditorReady: true, project: { id: 'old', title: '旧稿', role: 'owner', settings: { source_format: 'structured' } } as ProjectDetail })
  vi.mocked(structApi.getContent).mockResolvedValue(initial)
  vi.mocked(structApi.artifacts).mockResolvedValue({ artifacts: [], current_sha: 's1' })
  vi.mocked(structApi.preview).mockResolvedValue({ status: 'cached', sha: 's1', vid: 'v1', mode: 'tab', pdfUrl: '/preview.pdf', bytes: 1, duration_ms: 1 })
})
afterEach(async () => { await act(async () => root?.unmount()); root = null; host?.remove() })

async function mount() {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  await act(async () => root!.render(<LegacyStructuredWorkbench pid="old" />))
}
const convertButton = () => host.querySelector<HTMLButtonElement>('[data-testid="legacy-convert"]')!
async function edit() {
  await act(async () => {
    const input = host.querySelector<HTMLTextAreaElement>('[data-testid="draft-title"]')!
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '未保存的新标题')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('旧稿迁移防丢失', () => {
  it('稿件尚未加载完成时禁止迁移', async () => {
    let finish!: (value: StructContentReply) => void
    vi.mocked(structApi.getContent).mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    await mount()
    expect(convertButton().disabled).toBe(true)
    await act(async () => convertButton().click())
    expect(wordApi.convertStructured).not.toHaveBeenCalled()
    await act(async () => finish(initial))
    expect(convertButton().disabled).toBe(false)
  })

  it('编辑后立即禁止迁移，保存中仍禁止，仅完整保存成功后恢复', async () => {
    let finish!: (value: StructSaveReply) => void
    vi.mocked(structApi.putContent).mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    await mount()
    expect(convertButton().disabled).toBe(false)
    await edit()
    expect(convertButton().disabled).toBe(true)
    expect(host.textContent).toContain('有未保存修改，请先保存旧稿')
    expect(structApi.putContent).not.toHaveBeenCalled()
    await act(async () => convertButton().click())
    expect(wordApi.convertStructured).not.toHaveBeenCalled()
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="struct-save"]')!.click())
    expect(convertButton().disabled).toBe(true)
    expect(host.textContent).toContain('旧稿正在保存')
    await act(async () => finish(saved))
    expect(convertButton().disabled).toBe(false)
  })

  it('保存存在冲突时禁止迁移并显示处理提示', async () => {
    vi.mocked(structApi.putContent).mockRejectedValue(new ApiError(409, '保存冲突'))
    await mount()
    await edit()
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="struct-save"]')!.click())
    expect(convertButton().disabled).toBe(true)
    expect(host.textContent).toContain('旧稿存在保存冲突，请先处理冲突')
    expect(wordApi.convertStructured).not.toHaveBeenCalled()
  })

  it('转换进行时禁止继续编辑，失败后恢复旧稿编辑且内容保留', async () => {
    let fail!: (reason: Error) => void
    vi.mocked(wordApi.convertStructured).mockImplementation(() => new Promise((_resolve, reject) => { fail = reject }))
    await mount()
    await act(async () => convertButton().click())
    expect(wordApi.convertStructured).toHaveBeenCalledWith('old')
    expect(convertButton().disabled).toBe(true)
    expect(host.querySelector('[data-testid="legacy-editor"]')!.hasAttribute('inert')).toBe(true)
    await act(async () => fail(new Error('转换失败')))
    expect(host.querySelector('[data-testid="legacy-editor"]')!.hasAttribute('inert')).toBe(false)
    expect(host.querySelector<HTMLTextAreaElement>('[data-testid="draft-title"]')!.value).toBe('旧稿')
    expect(host.textContent).toContain('转换失败')
    expect(convertButton().disabled).toBe(false)
  })
})

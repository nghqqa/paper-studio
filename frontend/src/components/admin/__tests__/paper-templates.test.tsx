// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStudio } from '@/store'
import { paperTemplatesApi } from '@/lib/api/paperTemplates'
import { PaperTemplatesPanel } from '../PaperTemplatesPanel'

vi.mock('@/lib/api/paperTemplates', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/paperTemplates')>()
  return { ...actual, paperTemplatesApi: { list: vi.fn(), upload: vi.fn(), remove: vi.fn(), restore: vi.fn(), updateMeta: vi.fn(), replaceFile: vi.fn(), verify: vi.fn(), preview: vi.fn() } }
})
const template = { id: 'custom-team', name: '团队期刊模板', desc: '排版原件', format: 'docx' as const,
  origin: 'upload' as const, enabled: true, verify: 'unverified', version: 2, updated_at: 1700000000, thumb: true }
let root: Root
let host: HTMLDivElement
const initial = useStudio.getInitialState()
const click = async (text: string) => act(async () => { [...document.querySelectorAll('button')].find((b) => b.textContent === text)!.click() })
async function mount() {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root.render(<PaperTemplatesPanel />))
}
async function type(id: string, text: string) {
  await act(async () => {
    const input = document.getElementById(id) as HTMLInputElement
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = (q) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
})
beforeEach(() => {
  vi.resetAllMocks(); useStudio.setState(initial, true); useStudio.setState({ authStatus: 'authed', product: 'paper' })
  vi.mocked(paperTemplatesApi.list).mockResolvedValue({ items: [template], auto_accept: false })
})
afterEach(async () => { await act(async () => root?.unmount()); host?.remove() })

describe('平台论文模板', () => {
  it('上传完整文件和元数据，刷新后出现在列表', async () => {
    vi.mocked(paperTemplatesApi.upload).mockResolvedValue(template)
    await mount(); await click('添加模板')
    await type('pt-name', '团队期刊模板'); await type('pt-venue', '团队期刊')
    const file = new File(['native-docx'], 'journal.docx')
    await act(async () => {
      const el = document.getElementById('pt-file') as HTMLInputElement
      Object.defineProperty(el, 'files', { value: [file] }); el.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(paperTemplatesApi.upload).toHaveBeenCalledWith(expect.objectContaining({ format: 'docx', name: '团队期刊模板', venue: '团队期刊' }), file)
    expect(paperTemplatesApi.list).toHaveBeenCalledTimes(2)
    expect(document.querySelector('[data-testid="paper-template-upload"]')).toBeNull()
  })
  it('确认移除、隐藏和恢复，不触碰项目接口', async () => {
    vi.mocked(paperTemplatesApi.remove).mockResolvedValue({ ...template, enabled: false })
    vi.mocked(paperTemplatesApi.restore).mockResolvedValue(template)
    await mount(); await click('移除')
    expect(paperTemplatesApi.remove).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('已有项目不受影响')
    await click('确认移除')
    expect(paperTemplatesApi.remove).toHaveBeenCalledWith(template)
    expect(document.querySelector('[data-testid="pt-row-docx-custom-team"]')).toBeNull()
    await act(async () => (document.querySelector('input[type="checkbox"]') as HTMLInputElement).click())
    await click('恢复')
    expect(paperTemplatesApi.restore).toHaveBeenCalledWith({ ...template, enabled: false })
    expect(document.body.textContent).toContain('可使用')
  })
  it('账号关闭时不请求管理员接口，也不给上传入口', async () => {
    useStudio.setState({ authStatus: 'off' }); await mount()
    expect(paperTemplatesApi.list).not.toHaveBeenCalled()
    expect(document.querySelector('[data-testid="paper-template-auth-off"]')).not.toBeNull()
    expect(document.querySelector('button')).toBeNull()
  })
  it('服务端拒绝上传时保留表单并显示原因', async () => {
    vi.mocked(paperTemplatesApi.upload).mockRejectedValue(new Error('无法读取 DOCX'))
    await mount(); await click('添加模板'); await type('pt-name', '损坏模板')
    await act(async () => document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('无法读取 DOCX')
    expect(document.querySelector('[data-testid="paper-template-upload"]')).not.toBeNull()
  })
})
describe('平台论文模板 · C1 增强', () => {
  it('编辑元信息：PATCH 携带展示字段（docx 不含 main/engine）', async () => {
    vi.mocked(paperTemplatesApi.updateMeta).mockResolvedValue({ ...template, name: '改名后', venue: 'CVPR' })
    await mount(); await click('编辑')
    expect(document.querySelector('[data-testid="paper-template-edit"]')).not.toBeNull()
    await type('pte-name', '改名后'); await type('pte-venue', 'CVPR')
    await act(async () => document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    )
    expect(paperTemplatesApi.updateMeta).toHaveBeenCalledWith(template, expect.objectContaining({ name: '改名后', venue: 'CVPR' }))
    expect(document.body.textContent).toContain('改名后')
  })
  it('替换版本：PUT file 携带新文件（docx 不带 metadata），成功后行内更新', async () => {
    vi.mocked(paperTemplatesApi.replaceFile).mockResolvedValue({ ...template, version: 3, updated_at: 1700000001 })
    await mount(); await click('替换')
    expect(document.querySelector('[data-testid="paper-template-replace"]')).not.toBeNull()
    expect(document.body.textContent).toContain('当前第 2 版')
    const file = new File(['native-docx'], 'journal-v2.docx')
    await act(async () => {
      const el = document.getElementById('ptr-file') as HTMLInputElement
      Object.defineProperty(el, 'files', { value: [file] }); el.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(paperTemplatesApi.replaceFile).toHaveBeenCalledWith(template, file, undefined)
    expect(document.body.textContent).toContain('第 3 版')
  })
  it('详情弹窗：预览图 + 失败原因与日志尾部', async () => {
    const failed = { ...template, verify_error: 'latexmk 退出码 1', verify_log_tail: '! LaTeX Error: missing \begin{document}' }
    vi.mocked(paperTemplatesApi.list).mockResolvedValue({ items: [failed], auto_accept: false })
    await mount(); await click('详情')
    expect(document.querySelector('[data-testid="paper-template-detail"]')).not.toBeNull()
    expect(document.body.textContent).toContain('latexmk 退出码 1')
    expect(document.body.textContent).toContain('LaTeX Error')
    await click('关闭')
    expect(document.querySelector('[data-testid="paper-template-detail"]')).toBeNull()
  })
  it('Word 未验收模板提供生成预览动作，成功后行内翻为已验收', async () => {
    vi.mocked(paperTemplatesApi.preview).mockResolvedValue({ ...template, verify: 'verified', thumb: true, status: 'ok', duration_ms: 800, log_tail: '' })
    await mount(); await click('生成预览')
    expect(paperTemplatesApi.preview).toHaveBeenCalledWith(template)
    expect(document.body.textContent).toContain('可使用')
  })
})
describe('详情弹窗实时跟随（行标识派生）', () => {
  const dialogPreviewBtn = () => [...document.querySelectorAll<HTMLButtonElement>('[data-testid="paper-template-detail"] button')]
    .find((b) => b.textContent === '生成预览') ?? null
  it('弹窗内点击生成预览后，缩略图与验收状态即时刷新', async () => {
    const stale = { ...template, thumb: false, verify: 'unverified' as const }
    vi.mocked(paperTemplatesApi.list).mockResolvedValue({ items: [stale], auto_accept: false })
    vi.mocked(paperTemplatesApi.preview).mockResolvedValue({ ...stale, verify: 'verified', thumb: true, status: 'ok', duration_ms: 500, log_tail: '' })
    await mount(); await click('详情')
    expect(dialogPreviewBtn()).not.toBeNull()
    await act(async () => dialogPreviewBtn()!.click())
    expect(paperTemplatesApi.preview).toHaveBeenCalledWith(stale)
    // mergeRow 更新 items → detailRow 按标识重新派生 → 弹窗内「生成预览」入口消失
    expect(dialogPreviewBtn()).toBeNull()
    expect(document.querySelector('[data-testid="paper-template-detail"]')).not.toBeNull()
  })
  it('自动验收轮询刷新后，已打开的详情弹窗跟随最新状态', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(paperTemplatesApi.list).mockResolvedValue({ items: [{ ...template, thumb: false, verify: 'unverified' }], auto_accept: true })
      await mount(); await click('详情')
      expect(dialogPreviewBtn()).not.toBeNull()
      vi.mocked(paperTemplatesApi.list).mockResolvedValue({ items: [{ ...template, thumb: true, verify: 'verified' }], auto_accept: true })
      await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      expect(dialogPreviewBtn()).toBeNull()
    } finally { vi.useRealTimers() }
  })
})

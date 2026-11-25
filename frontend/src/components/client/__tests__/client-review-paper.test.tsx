// @vitest-environment jsdom
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { api } from '@/lib/api'
import { useStudio } from '@/store'
import type { PublicComment, PublicShareMeta } from '@/types/public-share'
import { ClientReviewPage } from '../ClientReviewPage'

vi.mock('react-pdf', () => ({
  Document: ({ children }: { children?: React.ReactNode }) => <div data-testid="mock-pdf-document">{children}</div>,
  Page: ({ pageNumber }: { pageNumber: number }) => <div data-testid="mock-pdf-page">{pageNumber}</div>,
  pdfjs: { GlobalWorkerOptions: {} },
}))

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

let root: Root | null = null
let host: HTMLElement | null = null

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = (q: string) =>
    ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList
  Element.prototype.scrollIntoView ??= () => {}
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.releasePointerCapture ??= () => {}
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('no network in test'))))
})

const paperMeta = (overrides: Partial<PublicShareMeta> = {}): PublicShareMeta => ({
  org_name: '研稿实验室',
  title: '基于扩散模型的时序预测方法',
  case_no: null,
  status: 'drafting',
  version: 3,
  sha: 'abc123',
  scope: 'confirm',
  baseline: 'original',
  pending_revisions: 0,
  sub_except: [],
  allow_download: true,
  allow_copy: true,
  allow_comment: true,
  expires_at: null,
  confirmation: null,
  pdf_ready: true,
  source_format: 'latex',
  document_type: 'paper',
  layout_supported: false,
  ...overrides,
})

const q = <T extends Element = HTMLElement>(sel: string, el: ParentNode = document) => el.querySelector<T>(sel)

async function mount(el: ReactElement) {
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  await act(async () => root!.render(<TooltipProvider>{el}</TooltipProvider>))
  await act(async () => {})
  await act(async () => {})
  return host
}

const type = (el: HTMLInputElement | HTMLTextAreaElement, value: string) =>
  act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })

beforeEach(() => {
  localStorage.clear()
  useStudio.getState().resetPublic()
  useStudio.setState({ toasts: [], guestName: '' })
  vi.spyOn(api, 'publicMeta').mockResolvedValue(paperMeta())
  vi.spyOn(api, 'publicComments').mockResolvedValue([])
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  host?.remove()
  host = null
  vi.restoreAllMocks()
})

describe('ClientReviewPage 论文工程适配（P1-4）', () => {
  it('LaTeX 论文链接：仅渲染 PDF 审阅视图、隐藏切换条、顶栏不渲染 null 案号', async () => {
    const el = await mount(<ClientReviewPage token="tok-latex" />)
    expect(q('[data-testid="client-viewbar"]', el)).toBeNull()
    expect(q('[data-testid="client-pdf"]', el)).not.toBeNull()
    expect(q('[data-testid="client-header"]', el)!.textContent).not.toContain('null')
    expect(q('[data-testid="client-actionbar"]', el)!.textContent).toContain('项目所有者')
    expect(q('[data-testid="client-actionbar"]', el)!.textContent).toContain('投稿')
    expect(q('[data-testid="client-doctb"]', el)!.textContent).not.toContain('选中文字即可批注')
  })

  it('Word 论文 pdf_ready=false 时展示「项目所有者」导出指引空态', async () => {
    vi.mocked(api.publicMeta).mockResolvedValueOnce(
      paperMeta({ source_format: 'docx', pdf_ready: false }),
    )
    const el = await mount(<ClientReviewPage token="tok-word" />)
    const empty = q('[data-testid="client-pdf-pending-paper"]', el)
    expect(empty).not.toBeNull()
    expect(empty!.textContent).toContain('作者尚未编译或导出当前版本 PDF，请联系项目所有者生成后再试')
  })

  it('仅 PDF 审阅提交意见走 pdf:page-N 页级锚点，抽屉/Toast 使用「项目所有者」文案', async () => {
    const added: PublicComment = {
      id: 'cm-p1',
      anchor: { block_id: 'pdf:page-1', line: 1, quote: '第 1 页' },
      body: '摘要请补充指标',
      author: { id: null, name: '王老师' },
      created_at: 1700000000,
      updated_at: 1700000000,
      resolved: false,
      replies: [],
      guest: true,
    }
    vi.spyOn(api, 'addPublicComment').mockResolvedValue(added)
    const el = await mount(<ClientReviewPage token="tok-comment" />)
    await act(async () => q('[data-testid="client-comment"]', el)!.click())
    const sheet = q('[data-testid="client-comment-sheet"]')!
    expect(sheet.textContent).toContain('项目所有者')
    expect(q('[data-testid="client-comment-quote"]')!.textContent).toContain('第 1 页')

    await type(q<HTMLInputElement>('[data-testid="client-guest-name"]')!, '王老师')
    await type(q<HTMLTextAreaElement>('[data-testid="client-comment-input"]')!, '摘要请补充指标')
    await act(async () =>
      q('[data-testid="client-comment-form"]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    )
    expect(api.addPublicComment).toHaveBeenCalledWith('tok-comment', {
      anchor: { block_id: 'pdf:page-1', line: 1, quote: '第 1 页' },
      body: '摘要请补充指标',
      guest_name: '王老师',
    })
    expect(useStudio.getState().toasts.some((t) => t.text.includes('项目所有者'))).toBe(true)
  })

  it('公开审阅页始终渲染 pdf 视图', async () => {
    const el = await mount(<ClientReviewPage token="tok-reset" />)
    expect(q('[data-testid="client-main"]', el)!.dataset.view).toBe('pdf')
  })

  it('论文模式确认定稿弹窗展示「项目所有者」与「投稿」，不泄露「代理师」', async () => {
    const el = await mount(<ClientReviewPage token="tok-confirm-paper" />)
    await act(async () => q('[data-testid="client-confirm"]', el)!.click())
    const dlg = q('[data-testid="client-confirm-dialog"]')!
    expect(dlg.textContent).toContain('项目所有者')
    expect(dlg.textContent).toContain('投稿')
    expect(dlg.textContent).not.toContain('代理师')
  })

  it('App 路由放行论文模式下的 #/c/<token> 免登录审阅页', async () => {
    window.location.hash = '#/c/tok-app'
    vi.spyOn(useStudio.getState(), 'fetchMeta').mockImplementation(async () => {
      useStudio.setState({ product: 'paper', authStatus: 'anon' })
    })
    const { default: App } = await import('@/App')
    const el = await mount(<App />)
    await act(async () => { await vi.waitFor(() => expect(q('[data-testid="page-client"]', el)).not.toBeNull()) })
    expect(q('[data-testid="patent-page-unavailable"]', el)).toBeNull()
    expect(q('[data-testid="client-token"]', el)!.textContent).toBe('tok-app')
    window.location.hash = ''
  })
})

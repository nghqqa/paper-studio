// @vitest-environment jsdom
/**
 * 跨源格式切换防错挂载回归（发版前加固）：从 #/p/<latex_pid> 直接切 #/p/<word_pid> 时，
 * openProject 先翻 pid、后到 project——此窗口 sourceFormat/docType 属旧案，若据它选工作台
 * 会把 LatexWorkbench 错挂到 Word 工程（首帧 GET /latex/files → 400）。
 * 锁定：pid 已换 + 旧 project 残留/加载中 ⇒ 只出 role="status" 加载占位；project 到位 ⇒ 挂对工作台；
 * 只设 pid 未设 project 的老单测形态（project=null 且非加载）不受守卫影响。
 */
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DESKTOP_QUERY, useStudio } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'

vi.mock('@/components/latex/LatexWorkbench', () => ({ LatexWorkbench: () => <div data-testid="mock-latex-workbench" /> }))
vi.mock('@/components/word/LegacyStructuredWorkbench', () => ({ LegacyStructuredWorkbench: () => <div data-testid="mock-structured-workbench" /> }))
vi.mock('@/components/word/WordWorkbench', () => ({ WordWorkbench: () => <div data-testid="mock-word-workbench" /> }))
vi.mock('@/components/paper/MarkdownPaperWorkbench', () => ({ MarkdownPaperWorkbench: () => <div data-testid="mock-markdown-workbench" /> }))
/* pdf.js 链在 jsdom 无 DOMMatrix（见 MobileShell 顶部注释）；守卫路径不渲染预览，直接 mock 掉 */
vi.mock('@/components/preview/PreviewPane', () => ({ PreviewPane: () => null }))
vi.mock('@/components/mobile/MobilePreview', () => ({ MobilePreview: () => null }))

import { DesktopShell } from '../DesktopShell'
import { MobileShell } from '@/components/mobile/MobileShell'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

let root: Root | null = null
let host: HTMLElement

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = (q: string) =>
    ({ matches: q === DESKTOP_QUERY, media: q, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList
  Element.prototype.scrollIntoView ??= () => {}
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
})

const initial = useStudio.getInitialState()
const proj = (id: string, source_format: string) =>
  ({ id, title: id, settings: { source_format, document_type: 'paper' } }) as never

beforeEach(() => {
  useStudio.setState(initial, true)
  useStudio.setState({ product: 'paper', authStatus: 'authed' })
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  host?.remove()
})

async function mount(el: ReactElement) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root!.render(<TooltipProvider>{el}</TooltipProvider>))
  await act(async () => {})
  return host
}

describe('壳层跨源格式切换防错挂载', () => {
  it('DesktopShell：pid 已换但 project 残留上一 LaTeX 案 → 只出加载占位，不挂任何工作台', async () => {
    useStudio.setState({ pid: 'word-pid', project: proj('latex-pid', 'latex'), projectLoading: true, projectError: null })
    const el = await mount(<DesktopShell />)
    expect(el.querySelector('[role="status"]')?.textContent).toContain('正在加载项目')
    for (const id of ['mock-latex-workbench', 'mock-word-workbench', 'mock-structured-workbench', 'mock-markdown-workbench']) {
      expect(el.querySelector(`[data-testid="${id}"]`)).toBeNull()
    }
  })

  it('DesktopShell：project 到位（docx）→ 挂 Word 工作台（守卫不拦截）', async () => {
    useStudio.setState({ pid: 'word-pid', project: proj('latex-pid', 'latex'), projectLoading: true, projectError: null })
    const el = await mount(<DesktopShell />)
    await act(async () => useStudio.setState({ project: proj('word-pid', 'docx'), projectLoading: false }))
    expect(el.querySelector('[data-testid="mock-word-workbench"]')).not.toBeNull()
    expect(el.querySelector('[role="status"]')).toBeNull()
  })

  it('MobileShell：pid 已换但 project 残留 → 加载占位；project=docx 到位 → Word 工作台', async () => {
    useStudio.setState({ pid: 'word-pid', project: proj('latex-pid', 'latex'), projectLoading: true, projectError: null })
    const el = await mount(<MobileShell />)
    expect(el.querySelector('[role="status"]')?.textContent).toContain('正在加载项目')
    await act(async () => useStudio.setState({ project: proj('word-pid', 'docx'), projectLoading: false }))
    expect(el.querySelector('[data-testid="mock-word-workbench"]')).not.toBeNull()
  })

  it('老单测形态不受守卫影响：只设 pid 未设 project（非加载态）不触发占位', async () => {
    useStudio.setState({ pid: 'word-pid', project: null, projectLoading: false, projectError: null })
    const el = await mount(<DesktopShell />)
    // 放行到原 paper 兜底（!docType →「正在加载论文项目…」），而非本守卫的「正在加载项目…」
    expect(el.textContent).toContain('正在加载论文项目')
  })
})

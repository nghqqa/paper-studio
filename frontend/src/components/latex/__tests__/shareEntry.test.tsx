// @vitest-environment jsdom
/**
 * v0.1.2 工作台邀请入口：顶栏「分享」按钮打开协作者抽屉（store.collabCenterOpen）。
 * 抽屉本体（CollabDrawer/MembersSection）的邀请表单 canManage 门控与错误态由
 * collab-center/__tests__ 覆盖；这里只固化 latex 工作台存在可发现的入口。
 * 端到端（真实浏览器 邀请→批注→回复）走部署验收。
 */
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStudio } from '@/store'
import { LatexWorkbench } from '../LatexWorkbench'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

vi.mock('@/lib/api/latex', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/latex')>()
  return {
    ...actual,
    latexApi: {
      ...actual.latexApi,
      files: vi.fn().mockResolvedValue({ files: [] }),
      builds: vi.fn().mockResolvedValue({ builds: [], latest_ok_build_id: null }),
      docxExports: vi.fn().mockResolvedValue({ exports: [] }),
    },
  }
})

let root: Root | null = null
let host: HTMLElement

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  Element.prototype.scrollIntoView ??= () => {}
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.releasePointerCapture ??= () => false
})

beforeEach(() => {
  vi.clearAllMocks()
  useStudio.setState((s) => ({
    project: {
      ...(s.project ?? ({} as NonNullable<typeof s.project>)),
      id: 'p1',
      title: '邀请入口测试工程',
      role: 'owner',
      settings: { source_format: 'latex', latex: { main: 'main.tex', engine: 'xelatex' } },
    } as typeof s.project,
    authStatus: 'off',
    collabCenterOpen: false,
  }))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root?.unmount())
  host.remove()
  root = null
})

const render = (el: ReactElement) => {
  act(() => root!.render(el))
}

describe('LatexWorkbench 邀请入口', () => {
  it('顶栏「分享」按钮打开协作者抽屉（members tab）', () => {
    render(<LatexWorkbench pid="p1" />)
    const btn = document.querySelector('[data-testid="latex-share"]') as HTMLButtonElement | null
    expect(btn, '顶栏应存在 data-testid=latex-share 的分享按钮').not.toBeNull()
    expect(useStudio.getState().collabCenterOpen).toBe(false)
    act(() => btn!.click())
    expect(useStudio.getState().collabCenterOpen).toBe(true)
    expect(useStudio.getState().collabCenterTab ?? 'members').toBe('members')
  })
})

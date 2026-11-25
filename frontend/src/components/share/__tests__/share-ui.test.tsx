// @vitest-environment jsdom
import axe from 'axe-core'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { User } from '@/lib/types'
import { useStudio } from '@/store'
import { ShareAccept } from '../ShareAccept'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

let root: Root | null = null
let host: HTMLElement

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia ??= (q: string) =>
    ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList
  Element.prototype.scrollIntoView ??= () => {}
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.releasePointerCapture ??= () => {}
})

const me: User = { id: 'u1', email: 'owner@b.c', display_name: 'Owner', is_superuser: false }

beforeEach(() => {
  window.location.hash = ''
  useStudio.setState({
    pid: 'method', project: null, projects: [], dialog: null, toasts: [],
    authStatus: 'authed', user: me, authError: null, members: [], shareLinks: [],
    collabCenterOpen: false, collabCenterTab: 'members',
  })
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  host?.remove()
  vi.restoreAllMocks()
})

async function mount(el: ReactElement) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root!.render(<TooltipProvider>{el}</TooltipProvider>))
  return host
}

async function violations(el: Element = document.body) {
  const res = await axe.run(el, {
    resultTypes: ['violations'],
    rules: { 'color-contrast': { enabled: false }, 'scrollable-region-focusable': { enabled: false }, region: { enabled: false } },
  })
  return res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
}

const q = <T extends Element = HTMLElement>(sel: string, el: ParentNode = document) => el.querySelector<T>(sel)

describe('ShareAccept #/share/<token>（07 §4.1）', () => {
  it('无 token → alert + 返回工作台', async () => {
    const el = await mount(<ShareAccept />)
    expect(q('[data-testid="share-accept-missing"] [role="alert"]', el)).not.toBeNull()
    expect(q<HTMLAnchorElement>('[data-testid="share-accept-home"]', el)?.getAttribute('href')).toBe('#/')
    expect(await violations(el)).toEqual([])
  })

  it('anon → 引导登录，不调用 acceptShare', async () => {
    window.location.hash = '#/share/tok'
    const acceptShare = vi.fn(async () => 'method')
    useStudio.setState({ authStatus: 'anon', user: null, acceptShare })
    const el = await mount(<ShareAccept />)
    expect(acceptShare).not.toHaveBeenCalled()
    expect(q<HTMLAnchorElement>('[data-testid="share-accept-login"]', el)?.getAttribute('href')).toBe('#/login')
    expect(await violations(el)).toEqual([])
  })

  it('anon 点「登录 / 注册」前把 share token 暂存 sessionStorage（R14-01：#/login 覆盖 hash 后 enterWorkspace 能找回）', async () => {
    window.location.hash = '#/share/tokStash'
    useStudio.setState({ authStatus: 'anon', user: null })
    const el = await mount(<ShareAccept />)
    await act(async () => q<HTMLAnchorElement>('[data-testid="share-accept-login"]', el)!.click())
    // jsdom 不执行锚点导航；真实浏览器里 hash 会被 #/login 覆盖，暂存因此必要
    expect(sessionStorage.getItem('patent-studio:share-return')).toBe('tokStash')
    sessionStorage.removeItem('patent-studio:share-return')
  })

  it('authed → acceptShare(token) → loadProjects + openProject(pid)', async () => {
    window.location.hash = '#/share/tok%201'
    const acceptShare = vi.fn(async () => 'system')
    const loadProjects = vi.fn(async () => {})
    const openProject = vi.fn(async () => {})
    useStudio.setState({ acceptShare, loadProjects, openProject })
    const el = await mount(<ShareAccept />)
    expect(acceptShare).toHaveBeenCalledWith('tok 1')
    expect(loadProjects).toHaveBeenCalledTimes(1)
    expect(openProject).toHaveBeenCalledWith('system')
    expect(q('[data-testid="share-accept-done"]', el)?.textContent).toContain('system')
  })

  it('领取失败（过期 / 501）→ alert 显示 store.authError', async () => {
    window.location.hash = '#/share/tok'
    useStudio.setState({
      acceptShare: vi.fn(async () => {
        useStudio.setState({ authError: '链接已过期' })
        return null
      }),
    })
    const el = await mount(<ShareAccept />)
    const err = q('[data-testid="share-accept-failed"] [role="alert"]', el)!
    expect(err.textContent).toContain('链接已过期')
    expect(await violations(el)).toEqual([])
  })

  it('auth=off 也发起领取（后端 501）→ 显示说明而非一直「正在领取」', async () => {
    window.location.hash = '#/share/tok'
    const acceptShare = vi.fn(async () => {
      useStudio.setState({ authError: '账号未开启（PATENT_STUDIO_AUTH=off）' })
      return null
    })
    useStudio.setState({ authStatus: 'off', user: null, acceptShare })
    const el = await mount(<ShareAccept />)
    expect(acceptShare).toHaveBeenCalledWith('tok')
    expect(q('[data-testid="share-accept-failed"] [role="alert"]', el)?.textContent).toContain('账号未开启')
  })
})

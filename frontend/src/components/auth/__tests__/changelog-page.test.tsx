// @vitest-environment jsdom
import axe from 'axe-core'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useStudio } from '@/store'
import { ChangelogPage } from '../ChangelogPage'
import { LATEST_RELEASE_VERSION } from '../changelogData'
import { LandingPage } from '../LandingPage'

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
})

beforeEach(() => {
  window.location.hash = '#/changelog'
  useStudio.setState({ pid: null, projects: [], authStatus: 'anon', user: null, authError: null, dialog: null, toasts: [] })
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
  return host
}

async function violations(el: Element = document.body) {
  const res = await axe.run(el, {
    resultTypes: ['violations'],
    rules: { 'color-contrast': { enabled: false }, 'scrollable-region-focusable': { enabled: false }, region: { enabled: false } },
  })
  return res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
}

describe('ChangelogPage（#/changelog）与官网入口', () => {
  it('展示最新版本与演进时间线、更新 document.title，且无障碍合规', async () => {
    const el = await mount(<ChangelogPage />)
    expect(el.querySelector('[data-testid="changelog-page"]')).not.toBeNull()
    expect(document.title).toContain('更新日志')
    expect(el.textContent).toContain(LATEST_RELEASE_VERSION)
    expect(el.querySelector('[data-testid="release-v1.1.1"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="release-v1.1.0"]')).not.toBeNull()
    expect(el.querySelector('nav[aria-label="版本目录"]')?.textContent).toContain('v1.1.1')
    expect(await violations(el)).toEqual([])
  })

  it('支持按变更类型筛选并在切回全部时恢复', async () => {
    const el = await mount(<ChangelogPage />)
    const fixBtn = el.querySelector<HTMLButtonElement>('[data-testid="changelog-filter-fix"]')!
    const allBtn = el.querySelector<HTMLButtonElement>('[data-testid="changelog-filter-all"]')!

    await act(async () => fixBtn.click())
    expect(fixBtn.getAttribute('aria-pressed')).toBe('true')
    expect(el.querySelector('[data-testid="release-v1.1.1"]')).toBeNull()
    expect(el.querySelector('[data-testid="release-v1.0.8-9"]')).toBeNull()
    expect(el.querySelector('[data-testid="release-v1.1.0"]')).not.toBeNull()

    await act(async () => allBtn.click())
    expect(allBtn.getAttribute('aria-pressed')).toBe('true')
    expect(el.querySelector('[data-testid="release-v1.1.1"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="release-v1.0.8-9"]')).not.toBeNull()
  })

  it('页面文案保持纯学术 Paper Studio 语境且无内部敏感信息', async () => {
    const el = await mount(<ChangelogPage />)
    const text = el.textContent ?? ''
    expect(text).not.toMatch(/专利|发明人|代理师|代理人|案卷|权利要求|说明书|CNIPA|知撰|客户确认|OA 轮次/)
    expect(text).not.toMatch(/\b10\.\d+\.\d+\.\d+\b|\b159\.75\./)
  })

  it('LandingPage 顶栏与页脚均提供指向 #/changelog 的入口链接', async () => {
    window.location.hash = '#/'
    const el = await mount(<LandingPage />)
    const navLink = el.querySelector<HTMLAnchorElement>('[data-testid="landing-nav-changelog"]')
    const footerLink = el.querySelector<HTMLAnchorElement>('[data-testid="landing-changelog"]')
    expect(navLink?.getAttribute('href')).toBe('#/changelog')
    expect(footerLink?.getAttribute('href')).toBe('#/changelog')
  })
})

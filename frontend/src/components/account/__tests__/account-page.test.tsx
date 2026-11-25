// @vitest-environment jsdom
import axe from 'axe-core'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { User } from '@/lib/types'
import { DESKTOP_QUERY, useStudio } from '@/store'
import { AccountPage } from '../AccountPage'
import { validatePassword, validateProfile } from '../formErrors'
import { readHashTab } from '../SubNav'

/**
 * W5 账户页（docs/plan/21 §4.6）：#/account?tab=profile|security|notify|pat 二级导航（1440 左栏 200 / 375 Segmented）；
 * 通知偏好无契约 → 501 EmptyState「功能开发中」；集成 PAT 走 /api/pat（列表 / 新建一次性显示 / 撤销）；
 * formErrors：显示名 / 密码 / 令牌名校验。
 */
declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

let root: Root | null = null
let host: HTMLElement
let desktop = true
const initial = useStudio.getInitialState()

const me: User = { id: 'u1', email: 'me@x', display_name: '王代理', is_superuser: false, title: '代理师', avatar_color: '' }

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = (q: string) =>
    ({ matches: q === DESKTOP_QUERY ? desktop : false, media: q, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList
  Element.prototype.scrollIntoView ??= () => {}
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.releasePointerCapture ??= () => {}
})

beforeEach(() => {
  useStudio.setState(initial, true)
  useStudio.setState({ authStatus: 'authed', user: me })
  desktop = true
  window.location.hash = '#/account'
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
  await act(async () => root!.render(el))
  return host
}

async function serious(el: Element) {
  const res = await axe.run(el, {
    resultTypes: ['violations'],
    rules: { 'color-contrast': { enabled: false }, 'scrollable-region-focusable': { enabled: false }, region: { enabled: false } },
  })
  return res.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
}

const q = <T extends Element = HTMLElement>(sel: string, scope: ParentNode = document) => scope.querySelector<T>(sel)
const qa = (sel: string, scope: ParentNode = document) => Array.from(scope.querySelectorAll<HTMLElement>(sel))
const goTab = (hash: string) =>
  act(async () => {
    window.location.hash = hash
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  })

describe('formErrors', () => {
  it('显示名 / 密码 / 令牌名校验', () => {
    expect(validateProfile({ display_name: '' })).toHaveProperty('display_name')
    expect(validateProfile({ display_name: '王代理' })).toEqual({})
    expect(validatePassword({ current: '', next: 'short', confirm: 'x' })).toMatchObject({ current: expect.any(String), next: expect.any(String), confirm: expect.any(String) })
    expect(validatePassword({ current: 'same-secret', next: 'same-secret', confirm: 'same-secret' })).toHaveProperty('next')
    expect(validatePassword({ current: 'old-secret', next: 'new-secret-1', confirm: 'new-secret-1' })).toEqual({})
  })
  it('readHashTab：?tab= 合法取之，否则回退', () => {
    window.location.hash = '#/account?tab=ai'
    expect(readHashTab(['profile', 'security', 'ai'] as const, 'profile')).toBe('ai')
    window.location.hash = '#/account?tab=bogus'
    expect(readHashTab(['profile', 'security', 'ai'] as const, 'profile')).toBe('profile')
    window.location.hash = '#/account'
    expect(readHashTab(['profile', 'security', 'ai'] as const, 'profile')).toBe('profile')
  })
})

describe('#/account 二级导航', () => {
  it('1440：左栏 200（w-side-min）三项、aria-current；切到安全 → 改密表单；375 → Segmented + 单列表单 + axe', async () => {
    await mount(<AccountPage />)
    const nav = q('[data-testid="subnav-desktop"]')!
    expect(nav.className).toContain('w-side-min')
    expect(qa('[data-testid^="account-tab-"]', nav).map((a) => a.textContent?.trim())).toEqual(['资料', '安全', 'AI 接入'])
    expect(q('[data-testid="account-tab-profile"]')?.getAttribute('aria-current')).toBe('page')
    expect(q('[data-testid="profile-form"]')?.className).toContain('max-w-form')
    await goTab('#/account?tab=security')
    expect(q('[data-testid="account-tab-security"]')?.getAttribute('aria-current')).toBe('page')
    expect(q('[data-testid="password-form"]')).not.toBeNull()
    expect(q('[data-testid="profile-form"]')).toBeNull()
    expect(await serious(host)).toEqual([])

    await act(async () => root?.unmount())
    root = null
    desktop = false
    await mount(<AccountPage />)
    expect(q('[data-testid="subnav-desktop"]')).toBeNull()
    expect(q('[data-testid="subnav-mobile"] [role="radiogroup"]')).not.toBeNull()
    expect(q('[data-testid="account-card"]')?.className).toContain('grid')
    expect(await serious(host)).toEqual([])
  })

  it('W8 375：Tab 行是 ScrollRow（不裁切）而非 44 大块；机构管理 md；头衔 chip sm + 头像色 32 + touch-hit；保存 md；区块 gap-section-m', async () => {
    desktop = false
    useStudio.setState({ user: { ...me, is_superuser: true } })
    await mount(<AccountPage />)
    const nav = q('[data-testid="subnav-mobile"]')!
    expect(nav.getAttribute('data-slot')).toBe('scroll-row')
    expect(nav.className).toContain('overflow-x-auto')
    expect(nav.tabIndex).toBe(0)
    const seg = q('[data-testid="subnav-mobile"] [role="radiogroup"]')!
    expect(seg.className).toContain('h-md-control')
    expect(seg.className).not.toContain('h-touch')
    expect(q('[data-testid="account-admin-link"]')?.className).toContain('h-md-control')
    expect(q('[data-testid="account-card"]')?.className).toContain('gap-section-m')
    expect(q('[data-testid="profile-form"]')?.className).toContain('gap-section-m')
    const titles = q('[data-testid="profile-titles"]')!
    expect(titles.className).toContain('gap-group-m')
    expect(qa('label', titles).every((l) => l.className.includes('touch-hit'))).toBe(true)
    expect(qa('label > span:last-child', titles).every((s) => s.className.includes('h-sm-control'))).toBe(true)
    const colors = q('[data-testid="profile-colors"]')!
    expect(colors.className).toContain('gap-group-m')
    const dots = qa('label', colors).slice(1)
    expect(dots.length).toBeGreaterThan(0)
    expect(dots.every((l) => l.className.includes('size-sm-control') && l.className.includes('touch-hit'))).toBe(true)
    const save = q('[data-testid="profile-save"]')!
    expect(save.className).toContain('h-md-control')
    expect(save.className).not.toContain('h-lg-control')
    expect(await serious(host)).toEqual([])
  })

  it('W8 1440：桌面不变——SubNav 左栏、机构管理 md、头像色 size-md-control、无 touch-hit', async () => {
    useStudio.setState({ user: { ...me, is_superuser: true } })
    await mount(<AccountPage />)
    expect(q('[data-testid="subnav-mobile"]')).toBeNull()
    expect(q('[data-testid="account-admin-link"]')?.className).toContain('h-md-control')
    expect(q('[data-testid="account-card"]')?.className).toContain('gap-10')
    const dots = qa('label', q('[data-testid="profile-colors"]')!).slice(1)
    expect(dots.every((l) => l.className.includes('size-md-control') && !l.className.includes('touch-hit'))).toBe(true)
  })
})

// @vitest-environment jsdom
import axe from 'axe-core'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { User } from '@/lib/types'
import { useStudio } from '@/store'
import { NotificationBell } from '../NotificationBell'

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

const me: User = { id: 'u1', email: 'a@b.c', display_name: '研究者', is_superuser: false }

beforeEach(() => {
  window.location.hash = '#/'
  useStudio.setState({ authStatus: 'anon', user: null })
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

describe('NotificationBell', () => {
  it('anon 与 off 模式不渲染铃铛', async () => {
    let el = await mount(<NotificationBell />)
    expect(el.textContent).toBe('')
    await act(async () => root?.unmount())
    host.remove()

    useStudio.setState({ authStatus: 'off', user: null })
    el = await mount(<NotificationBell />)
    expect(el.textContent).toBe('')
  })

  it('authed：显示未读角标、展开列表、点击单条已读跳转、支持全部已读且无障碍合规', async () => {
    useStudio.setState({ authStatus: 'authed', user: me })
    const items = [
      {
        id: 'n1',
        kind: 'mention',
        title: '导师 在《实验论文》中提到了你',
        body: 'main.tex',
        href: '#/p/demo?c=c1',
        project_id: 'demo',
        read_at: null,
        created_at: Math.floor(Date.now() / 1000) - 60,
      },
      {
        id: 'n2',
        kind: 'invite',
        title: '已加入论文项目：实验论文',
        body: '导师 将你设为「编辑者」',
        href: '#/p/demo',
        project_id: 'demo',
        read_at: '2026-11-25T00:00:00Z',
        created_at: Math.floor(Date.now() / 1000) - 3600,
      },
    ]

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.startsWith('/api/notifications?')) {
        return new Response(JSON.stringify({ items, unread_count: 1 }), { status: 200 })
      }
      if (url === '/api/notifications/n1/read' && init?.method === 'POST') {
        return new Response(JSON.stringify({ ok: true, unread_count: 0 }), { status: 200 })
      }
      if (url === '/api/notifications/read-all' && init?.method === 'POST') {
        return new Response(JSON.stringify({ ok: true, updated: 1, unread_count: 0 }), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    const el = await mount(<NotificationBell />)
    await vi.waitFor(() => {
      expect(el.querySelector('[data-testid="notification-badge"]')?.textContent).toBe('1')
    })

    const bell = el.querySelector<HTMLButtonElement>('[data-testid="notification-bell"]')!
    await act(async () => bell.click())
    expect(el.querySelector('[data-testid="notification-popover"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="notification-item-n1"]')?.textContent).toContain('提到了你')
    expect(await violations(el)).toEqual([])

    await act(async () => el.querySelector<HTMLButtonElement>('[data-testid="notification-item-n1"]')!.click())
    expect(window.location.hash).toBe('#/p/demo?c=c1')
    expect(el.querySelector('[data-testid="notification-badge"]')).toBeNull()
  })

  it('支持全部已读清空未读角标', async () => {
    useStudio.setState({ authStatus: 'authed', user: me })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.startsWith('/api/notifications?')) {
        return new Response(
          JSON.stringify({
            items: [
              { id: 'n1', kind: 'comment', title: '新批注', body: '建议补充图 2', href: '#/p/demo', project_id: 'demo', read_at: null, created_at: 1700000000 },
            ],
            unread_count: 1,
          }),
          { status: 200 },
        )
      }
      if (url === '/api/notifications/read-all') {
        return new Response(JSON.stringify({ ok: true, updated: 1, unread_count: 0 }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    })

    const el = await mount(<NotificationBell />)
    await vi.waitFor(() => expect(el.querySelector('[data-testid="notification-badge"]')?.textContent).toBe('1'))
    await act(async () => el.querySelector<HTMLButtonElement>('[data-testid="notification-bell"]')!.click())
    await act(async () => el.querySelector<HTMLButtonElement>('[data-testid="notifications-read-all"]')!.click())
    expect(el.querySelector('[data-testid="notification-badge"]')).toBeNull()
  })
})

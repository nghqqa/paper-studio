// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { UserAiPanel } from '../UserAiPanel'
import { useStudio } from '@/store'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLElement | null = null
let root: Root | null = null

beforeAll(() => {
  Element.prototype.scrollIntoView ??= () => {}
  useStudio.setState({ authStatus: 'authed' })
})

function render(el: ReactElement) {
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  act(() => root!.render(el))
}

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  vi.restoreAllMocks()
})

const MASKED = {
  base_url: 'https://u.example/v1',
  model_interactive: 'm1',
  model_heavy: '',
  model_fallback: '',
  has_api_key: true,
  api_key_hint: '•••a-99',
}

function setVal(sel: string, v: string) {
  const el = document.querySelector(sel) as HTMLInputElement
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, v)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

function mockFetch(provider: unknown) {
  const f = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url)
    if (u.includes('/api/ai/my-provider') && (!init?.method || init.method === 'GET')) {
      return new Response(JSON.stringify({ provider, org_fallback: null, effective: provider ? 'user' : 'none' }), { status: 200 })
    }
    return new Response(JSON.stringify({ ok: true, provider: MASKED }), { status: 200 })
  })
  vi.stubGlobal('fetch', f)
  return f
}

describe('UserAiPanel', () => {
  it('未配置：生效=未配置，缺 Key 提交被前端拦截（不发 PUT）', async () => {
    const f = mockFetch(null)
    render(<UserAiPanel />)
    await act(async () => { await Promise.resolve() })
    expect(document.querySelector('[data-testid="user-ai-effective"]')!.textContent).toContain('未配置')
    await act(async () => {
      setVal('[data-testid="user-ai-base-url"]', 'https://u.example/v1')
      setVal('[data-testid="user-ai-model"]', 'm1')
      ;(document.querySelector('[data-testid="user-ai-save"]') as HTMLButtonElement).click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(document.querySelector('[data-testid="user-ai-error"]')!.textContent).toContain('API Key')
    expect(f.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === 'PUT')).toBe(false)
  })

  it('已配置回显 masked；保存走 PUT 且提交含 Key（服务端只写不读）', async () => {
    const f = mockFetch(MASKED)
    render(<UserAiPanel />)
    await act(async () => { await Promise.resolve() })
    expect(document.querySelector('[data-testid="user-ai-effective"]')!.textContent).toContain('你的接入')
    expect(document.querySelector('[data-testid="user-ai-key"]')!.getAttribute('placeholder')).toContain('留空')
    await act(async () => {
      setVal('[data-testid="user-ai-base-url"]', 'https://u2.example/v1')
      setVal('[data-testid="user-ai-model"]', 'm2')
      setVal('[data-testid="user-ai-key"]', 'sk-new-key')
      ;(document.querySelector('[data-testid="user-ai-save"]') as HTMLButtonElement).click()
      await Promise.resolve()
      await Promise.resolve()
    })
    const put = f.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'PUT')
    expect(put).toBeTruthy()
    const body = JSON.parse(String(put![1]!.body))
    expect(body.api_key).toBe('sk-new-key')
    expect(body.base_url).toBe('https://u2.example/v1')
  })
})

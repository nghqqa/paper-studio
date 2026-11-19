// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { SetupPasswordForm } from '../SetupPasswordForm'

let root: Root
let host: HTMLDivElement
beforeAll(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks() })
async function type(id: string, text: string) {
  await act(async () => {
    const input = document.getElementById(id) as HTMLInputElement
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
it('自行设置密码，成功后清除地址中的令牌；错误时允许重试', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ detail: { message: '链接已过期' } }), { status: 400 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })))
  window.location.hash = '#/login?setup=test-capability'
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root.render(<SetupPasswordForm token="test-capability" />))
  await type('setup-password', 'My-personal-password!'); await type('setup-confirm', 'mismatch')
  await act(async () => document.querySelector('form')!.requestSubmit())
  expect(fetch).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain('两次输入的密码不一致')
  await type('setup-confirm', 'My-personal-password!')
  await act(async () => document.querySelector('form')!.requestSubmit())
  expect(document.body.textContent).toContain('链接已过期')
  await act(async () => document.querySelector('form')!.requestSubmit())
  expect(document.body.textContent).toContain('密码已设置')
  expect(window.location.hash).toBe('#/login')
})

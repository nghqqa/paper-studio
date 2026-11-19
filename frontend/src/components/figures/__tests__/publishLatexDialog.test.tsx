// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { figuresApi, type ProjectFigure } from '@/lib/api/projectFigures'
import { PublishLatexDialog } from '../PublishLatexDialog'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

const figure = (name: string): ProjectFigure => ({
  id: 'fig-9-abc123', name, kind: 'diagram', version: 1, created_at: 1, bytes: 10,
})

let root: Root
let host: HTMLDivElement

beforeAll(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true })
beforeEach(() => {
  vi.spyOn(figuresApi, 'publishLatex').mockResolvedValue({ ok: true, path: 'figures/overview.png', stem: 'overview', snippet: '\begin{figure}' })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

const q = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!
async function mount(figure: ProjectFigure) {
  await act(async () => root.render(<PublishLatexDialog pid="p1" figure={figure} onClose={() => { }} onPublished={() => { }} />))
}
async function click(testid: string) {
  await act(async () => q(`[data-testid="${testid}"]`).click())
}

it('defaults stem from a latin figure name', async () => {
  await mount(figure('Method overview'))
  expect(q<HTMLInputElement>('[data-testid="publish-latex-stem"]').value).toBe('Method-overview')
})

it('falls back to fid for pure-Chinese figure names', async () => {
  await mount(figure('方法总览图'))
  expect(q<HTMLInputElement>('[data-testid="publish-latex-stem"]').value).toBe('fig-9-abc123')
})

it('publishes with edited stem and reports failure', async () => {
  await mount(figure('overview'))
  await act(async () => {
    const el = q<HTMLInputElement>('[data-testid="publish-latex-stem"]')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, 'my-fig')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await click('publish-latex-confirm')
  expect(figuresApi.publishLatex).toHaveBeenCalledWith('p1', 'fig-9-abc123', { stem: 'my-fig', overwrite: false })
  expect(q('[data-testid="publish-latex-snippet"]').textContent).toContain('\begin{figure}')
  // 展示服务端返回的真实落盘路径（服务端清洗后的 path），不回显未清洗的输入 stem。
  expect(document.body.textContent).toContain('figures/overview.png')
})

it('shows error when publish fails', async () => {
  await mount(figure('overview'))
  vi.mocked(figuresApi.publishLatex).mockRejectedValueOnce(new Error('已存在同名文件'))
  await click('publish-latex-confirm')
  expect(q('[role="alert"]').textContent).toContain('已存在同名文件')
})

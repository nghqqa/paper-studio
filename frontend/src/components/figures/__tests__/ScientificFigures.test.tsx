// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { figuresApi, type ProjectFigure } from '@/lib/api/projectFigures'
import type { ProjectDetail, ProjectSummary } from '@/lib/types'
import { useStudio } from '@/store'
import { ScientificFigures } from '../ScientificFigures'

const initial = useStudio.getInitialState()
const projects: ProjectSummary[] = [
  { id: 'word-a', title: 'Word A', mtime: 1, source_format: 'docx', my_role: 'owner' },
  { id: 'latex-b', title: 'LaTeX B', mtime: 1, source_format: 'latex', my_role: 'editor' },
  { id: 'view-c', title: '只读 C', mtime: 1, source_format: 'docx', my_role: 'viewer' },
  { id: 'review-d', title: '审阅 D', mtime: 1, my_role: 'reviewer' },
  { id: 'unknown-e', title: '角色未知 E', mtime: 1 },
  { id: 'archived', title: '已归档', mtime: 1, my_role: 'owner', list_state: 'archived' },
  { id: 'trash', title: '回收站', mtime: 1, my_role: 'owner', list_state: 'trashed' },
]
const figure = (id: string, name = id): ProjectFigure => ({
  id, name, type: 'line', title: '', x_label: '', y_label: '',
  categories: ['A'], series: [{ name: 'Score', values: [1] }], created_at: 1, bytes: 20,
})
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
let root: Root
let host: HTMLDivElement
let fetchMock: ReturnType<typeof vi.fn>

beforeAll(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true })
beforeEach(() => {
  useStudio.setState(initial, true)
  useStudio.setState({
    authStatus: 'authed', projects: structuredClone(projects),
    user: { id: 'author', email: 'author@example.com', display_name: '作者', is_superuser: false },
    // Global current project is deliberately unrelated to the selected project.
    project: { id: 'global-project', role: 'viewer' } as ProjectDetail,
  })
  vi.spyOn(figuresApi, 'list').mockResolvedValue({ figures: [] })
  vi.spyOn(figuresApi, 'create').mockResolvedValue({ figure: figure('created') })
  vi.spyOn(figuresApi, 'remove').mockResolvedValue({ ok: true })
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data_url: 'data:image/png;base64,cHJldmlldw==' }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  }))
  vi.stubGlobal('fetch', fetchMock)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const q = <T extends HTMLElement = HTMLElement>(selector: string) => host.querySelector<T>(selector)!
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === text)!
async function mount(pid?: string) { await act(async () => root.render(<ScientificFigures pid={pid} />)) }
async function choose(pid: string) {
  await act(async () => {
    const select = q<HTMLSelectElement>('#figures-project')
    select.value = pid
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
async function click(node: HTMLElement) { await act(async () => node.click()) }
async function input(selector: string, value: string) {
  await act(async () => {
    const element = q<HTMLInputElement | HTMLTextAreaElement>(selector)
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function preview() {
  await click(q('[data-testid="figures-new"]'))
  await click(button('预览'))
}

it('respects incoming project, follows prop changes, and shows Word insertion guidance', async () => {
  await mount('word-a')
  expect(q<HTMLSelectElement>('#figures-project').value).toBe('word-a')
  expect(figuresApi.list).toHaveBeenCalledWith('word-a')
  expect(host.textContent).toContain('插件 → LaTeX公式 → 科研图表')
  await mount('latex-b')
  expect(q<HTMLSelectElement>('#figures-project').value).toBe('latex-b')
  expect(figuresApi.list).toHaveBeenLastCalledWith('latex-b')
  expect(host.textContent).not.toContain('插件 → LaTeX公式 → 科研图表')
})

it('requires a project and excludes archived, trashed and unknown incoming projects', async () => {
  await mount()
  expect(figuresApi.list).not.toHaveBeenCalled()
  expect(host.querySelector('[data-testid="figures-new"]')).toBeNull()
  expect([...q<HTMLSelectElement>('#figures-project').options].map((option) => option.value)).not.toContain('archived')
  expect([...q<HTMLSelectElement>('#figures-project').options].map((option) => option.value)).not.toContain('trash')
  await mount('archived')
  expect(figuresApi.list).not.toHaveBeenCalled()
  expect(host.textContent).toContain('该项目不在可用列表中')
})

it('uses the selected project editor role instead of an unrelated global owner/viewer role', async () => {
  await mount('latex-b')
  expect(q('[data-testid="figures-new"]')).toBeTruthy()
  await act(async () => useStudio.setState({ project: { id: 'global-project', role: 'owner' } as ProjectDetail }))
  for (const pid of ['view-c', 'review-d', 'unknown-e']) {
    await choose(pid)
    expect(host.querySelector('[data-testid="figures-new"]')).toBeNull()
    expect(host.querySelector('[title="删除"]')).toBeNull()
  }
})

it('allows selected-project writes for agent, administrator and auth-off, but not unknown authentication', async () => {
  await act(async () => useStudio.setState({ projects: [{ ...projects[0], my_role: 'agent' }] }))
  await mount('word-a')
  expect(q('[data-testid="figures-new"]')).toBeTruthy()
  await act(async () => useStudio.setState({ projects: structuredClone(projects), user: { ...useStudio.getState().user!, is_superuser: true } }))
  await choose('view-c')
  expect(q('[data-testid="figures-new"]')).toBeTruthy()
  await act(async () => useStudio.setState({ authStatus: 'off', user: null }))
  await choose('unknown-e')
  expect(q('[data-testid="figures-new"]')).toBeTruthy()
  await act(async () => useStudio.setState({ authStatus: 'unknown' }))
  expect(host.querySelector('[data-testid="figures-new"]')).toBeNull()
})

it('discards late list responses after switching projects', async () => {
  const old = deferred<{ figures: ProjectFigure[] }>()
  vi.mocked(figuresApi.list).mockImplementation((pid) => pid === 'word-a' ? old.promise : Promise.resolve({ figures: [figure('b', 'B图表')] }))
  await mount('word-a')
  expect(host.textContent).toContain('正在加载图表')
  await choose('latex-b')
  expect(host.textContent).toContain('B图表')
  await act(async () => old.resolve({ figures: [figure('a', 'A图表')] }))
  expect(host.textContent).not.toContain('A图表')
  expect(q<HTMLImageElement>('[data-testid="figure-card"] img').getAttribute('src')).toContain('/latex-b/b/png')
})

it('does not present failed loading as an empty library and permits retry outside the form', async () => {
  vi.mocked(figuresApi.list).mockRejectedValueOnce(new Error('服务暂不可用')).mockResolvedValueOnce({ figures: [figure('retry', '恢复图表')] })
  await mount('word-a')
  expect(q('[role="alert"]').textContent).toContain('服务暂不可用')
  expect(host.querySelector('[data-testid="figures-empty"]')).toBeNull()
  expect(host.querySelector('[data-testid="figures-new"]')).toBeNull()
  await click(button('重试加载'))
  expect(host.querySelector('[role="alert"]')).toBeNull()
  expect(host.textContent).toContain('恢复图表')
})

it('resets the form and preview on project switches and cannot save the old project draft into the new project', async () => {
  await mount('word-a')
  await preview()
  await input('#fig-name', 'A草稿')
  await choose('latex-b')
  expect(host.querySelector('[data-testid="figures-form"]')).toBeNull()
  await click(q('[data-testid="figures-new"]'))
  expect(q<HTMLInputElement>('#fig-name').value).toBe('')
  expect(button('保存').disabled).toBe(true)
  expect(host.querySelector('img[alt="预览"]')).toBeNull()
  expect(figuresApi.create).not.toHaveBeenCalled()
})

it('keeps an in-flight save bound to its original project and ignores its response in the new project', async () => {
  const old = deferred<{ figure: ProjectFigure }>()
  vi.mocked(figuresApi.create).mockReturnValue(old.promise)
  vi.mocked(figuresApi.list).mockImplementation((pid) => Promise.resolve({ figures: pid === 'latex-b' ? [figure('b', 'B图表')] : [] }))
  await mount('word-a')
  await preview()
  await click(button('保存'))
  expect(figuresApi.create).toHaveBeenCalledWith('word-a', expect.any(Object))
  await choose('latex-b')
  await act(async () => old.resolve({ figure: figure('a-created', 'A新图表') }))
  expect(host.textContent).toContain('B图表')
  expect(host.textContent).not.toContain('A新图表')
  expect(host.textContent).not.toContain('图表已保存到当前项目')
  expect(figuresApi.create).toHaveBeenCalledTimes(1)
})

it('invalidates the preview when inputs change, including during a pending render', async () => {
  const rendered = deferred<Response>()
  fetchMock.mockReturnValueOnce(rendered.promise)
  await mount('word-a')
  await click(q('[data-testid="figures-new"]'))
  await click(button('预览'))
  await input('#fig-title', '更新标题')
  await act(async () => rendered.resolve(new Response(JSON.stringify({ data_url: 'data:image/png;base64,b2xk' }), { status: 200 })))
  expect(host.querySelector('img[alt="预览"]')).toBeNull()
  expect(button('保存').disabled).toBe(true)
  await click(button('预览'))
  expect(button('保存').disabled).toBe(false)
  await input('#fig-data', '{"categories":["新值"],"series":[{"name":"精度","values":[1]}]}')
  expect(button('保存').disabled).toBe(true)
})

it('shows save and deletion failures without dropping figures or hiding errors inside the form', async () => {
  vi.mocked(figuresApi.list).mockResolvedValue({ figures: [figure('existing', '原图')] })
  vi.mocked(figuresApi.remove).mockRejectedValue(new Error('删除失败'))
  await mount('word-a')
  await click(q('[aria-label="删除 原图"]'))
  expect(q('[role="alert"]').textContent).toContain('删除失败')
  expect(host.textContent).toContain('原图')
  vi.mocked(figuresApi.create).mockRejectedValue(new Error('保存失败'))
  await preview()
  await click(button('保存'))
  expect(q('[role="alert"]').textContent).toContain('保存失败')
  expect(host.querySelector('[data-testid="figures-form"]')).not.toBeNull()
})

it('ignores deletion failures from a project that has already been left', async () => {
  const removed = deferred<{ ok: boolean }>()
  vi.mocked(figuresApi.list).mockImplementation((pid) => Promise.resolve({ figures: [figure(pid, pid === 'word-a' ? 'A图表' : 'B图表')] }))
  vi.mocked(figuresApi.remove).mockReturnValue(removed.promise)
  await mount('word-a')
  await click(q('[aria-label="删除 A图表"]'))
  await choose('latex-b')
  await act(async () => removed.reject(new Error('旧项目删除失败')))
  expect(host.querySelector('[role="alert"]')).toBeNull()
  expect(host.textContent).toContain('B图表')
})

it('shows copy failure for read-only users without exposing write actions', async () => {
  vi.mocked(figuresApi.list).mockResolvedValue({ figures: [figure('readable', '可读图表')] })
  vi.mocked(navigator.clipboard.writeText).mockRejectedValue(new Error('denied'))
  await mount('view-c')
  await click(q('[aria-label="复制 可读图表 的 LaTeX 引用"]'))
  expect(q('[role="alert"]').textContent).toContain('无法复制')
  expect(host.querySelector('[title="删除"]')).toBeNull()
  expect(host.querySelector('[data-testid="figures-new"]')).toBeNull()
})

it('supports CSV/TSV paste conversion to chart JSON and exposes 300/600 DPI & PDF/SVG export links', async () => {
  vi.mocked(figuresApi.list).mockResolvedValue({ figures: [figure('f1', '消融实验')] })
  await mount('latex-b')
  expect(q<HTMLAnchorElement>('[data-testid="figure-export-300"]').getAttribute('href')).toContain('/export?format=png&dpi=300')
  expect(q<HTMLAnchorElement>('[data-testid="figure-export-600"]').getAttribute('href')).toContain('/export?format=png&dpi=600')
  expect(q<HTMLAnchorElement>('[data-testid="figure-export-pdf"]').getAttribute('href')).toContain('/export?format=pdf&dpi=300')
  expect(q<HTMLAnchorElement>('[data-testid="figure-export-svg"]').getAttribute('href')).toContain('/export?format=svg&dpi=300')

  await click(q('[data-testid="figures-new"]'))
  await click(q('[data-testid="fig-csv-toggle"]'))
  await input('[data-testid="fig-csv-input"]', 'Method\tAcc\nBaseline\t80.5%\nOurs\t91.2%')
  await click(q('[data-testid="fig-csv-apply"]'))
  const jsonVal = JSON.parse(q<HTMLTextAreaElement>('#fig-data').value)
  expect(jsonVal.categories).toEqual(['Baseline', 'Ours'])
  expect(jsonVal.series).toEqual([{ name: 'Acc', values: [80.5, 91.2] }])
})

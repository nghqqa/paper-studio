// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api/net'
import { latexApi, type LatexPreflightGet, type LatexPreflightReport } from '@/lib/api/latex'
import { LatexPreflight } from '../LatexPreflight'

vi.mock('@/lib/api/latex', () => ({
  latexApi: { runPreflight: vi.fn(), getPreflight: vi.fn() },
}))

let root: Root | null = null
let host: HTMLElement

beforeAll(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true })
beforeEach(() => { vi.resetAllMocks() })
afterEach(async () => { await act(async () => root?.unmount()); root = null })

function mount(props: { pid?: string; canEdit?: boolean } = {}) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(<LatexPreflight pid={props.pid ?? 'p'} canEdit={props.canEdit ?? true} />))
  return host
}

function report(overrides: Partial<LatexPreflightReport> = {}): LatexPreflightReport {
  return {
    schema: 'paper-studio/latex-preflight@1',
    project_id: 'p',
    ruleset_id: 'latex-general',
    ruleset_version: '1',
    generated_at: '2026-11-16T12:00:00Z',
    digest: { 'main.tex': 'a'.repeat(64), 'refs.bib': 'c'.repeat(64) },
    digest_sha: 'd'.repeat(64),
    items: [
      { rule_id: 'latex-todo-residue', status: 'pass', evidence: '非注释行未发现残留', source: '通用投稿规范' },
      { rule_id: 'latex-undefined-refs', status: 'warn', evidence: '存在未定义引用键：nosuch（main.tex:4）', source: '通用投稿规范' },
      { rule_id: 'latex-open-issues', status: 'unknown', evidence: '无法检查', source: '通用投稿规范' },
      { rule_id: 'blind-author-block', status: 'warn', evidence: '命中作者块标记', source: '双盲规范' },
    ],
    ...overrides,
  }
}

function getBody(overrides: Partial<LatexPreflightGet> = {}): LatexPreflightGet {
  return { report: report(), expired: false, current: { digest_sha: 'd'.repeat(64) }, ...overrides }
}

async function flush(times = 3) {
  for (let i = 0; i < times; i++) await act(async () => { await Promise.resolve() })
}

describe('LaTeX 投稿检查面板', () => {
  it('404 → 显示尚未运行', async () => {
    vi.mocked(latexApi.getPreflight).mockRejectedValue(
      new ApiError(404, '尚未运行投稿前检查', { kind: 'not_found', message: '尚未运行投稿前检查', line: null, detail: null }))
    const h = mount()
    await flush()
    expect(latexApi.getPreflight).toHaveBeenCalledWith('p', 'latex-general')
    expect(h.querySelector('[data-testid="latex-preflight-notrun"]')).toBeTruthy()
    expect(h.querySelector('[data-testid="latex-preflight-items"]')).toBeNull()
  })

  it('报告渲染徽章/证据/依据与元信息', async () => {
    vi.mocked(latexApi.getPreflight).mockResolvedValue(getBody())
    const h = mount()
    await flush()
    expect(h.querySelectorAll('[data-testid="latex-preflight-items"] > li').length).toBe(4)
    expect(h.textContent).toContain('通过')
    expect(h.textContent).toContain('告警')
    expect(h.textContent).toContain('无法判断')
    expect(h.textContent).toContain('latex-general/1')
    expect(h.textContent).toContain('指纹')
    expect(h.querySelector('[data-testid="latex-preflight-expired"]')).toBeNull()
  })

  it('运行检查 → POST 并按响应 expired 如实设置', async () => {
    vi.mocked(latexApi.getPreflight).mockResolvedValue(getBody())
    vi.mocked(latexApi.runPreflight).mockResolvedValue({
      report: report({ digest_sha: 'e'.repeat(64) }),
      expired: true,
      superseded: false,
      current: { digest_sha: 'e'.repeat(64) },
    })
    const h = mount()
    await flush()
    const btn = h.querySelector<HTMLButtonElement>('[data-testid="latex-preflight-run"]')!
    await act(async () => btn.click())
    await flush()
    expect(latexApi.runPreflight).toHaveBeenCalledWith('p', { ruleset: 'latex-general' })
    expect(h.querySelector('[data-testid="latex-preflight-expired"]')).toBeTruthy()
  })

  it('规则集切换 → GET 携带对应 ruleset；双盲运行携带 double-blind', async () => {
    vi.mocked(latexApi.getPreflight).mockRejectedValue(
      new ApiError(404, '尚未运行投稿前检查', { kind: 'not_found', message: '尚未运行投稿前检查', line: null, detail: null }))
    vi.mocked(latexApi.runPreflight).mockResolvedValue({
      report: report({ ruleset_id: 'double-blind' }),
      expired: false, superseded: false,
      current: { digest_sha: 'd'.repeat(64) },
    })
    const h = mount()
    await flush()
    const sel = h.querySelector<HTMLSelectElement>('[data-testid="latex-preflight-ruleset"]')!
    expect(sel.options.length).toBe(2)
    expect(sel.options[0].textContent).toContain('通用学术检查')
    expect(sel.options[1].textContent).toContain('双盲')
    await act(async () => {
      sel.value = 'double-blind'
      sel.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flush()
    expect(latexApi.getPreflight).toHaveBeenCalledWith('p', 'double-blind')
    const btn = h.querySelector<HTMLButtonElement>('[data-testid="latex-preflight-run"]')!
    await act(async () => btn.click())
    await flush()
    expect(latexApi.runPreflight).toHaveBeenCalledWith('p', { ruleset: 'double-blind' })
    expect(h.textContent).toContain('double-blind/1')
  })

  it('viewer（canEdit=false）→ 运行按钮禁用', async () => {
    const h = mount({ canEdit: false })
    await flush(2)
    const btn = h.querySelector<HTMLButtonElement>('[data-testid="latex-preflight-run"]')!
    expect(btn.disabled).toBe(true)
    expect(h.querySelector('[data-testid="latex-preflight-saving"]')).toBeNull()
  })
})

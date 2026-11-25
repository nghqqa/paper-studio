// @vitest-environment jsdom
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api/net'
import { latexApi, type WordExportManifest } from '@/lib/api/latex'
import { useStudio } from '@/store'
import { LatexWorkbench } from '../LatexWorkbench'

/**
 * 统一 Word 导出入口的 UI 合约：
 * 默认使用标准学术单栏（academic）；可切换中文信息学报双栏（jcip）；
 * 成功态显示完成+下载链接；blocked 态显示原因且无 docx 链接；错误态显示报错。
 */
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
      read: vi.fn().mockResolvedValue({ path: 'main.tex', content: '', sha: 's1', size: 0 }),
      build: vi.fn().mockResolvedValue({
        build_id: 'b-err',
        pid: 'p1',
        engine: 'xelatex',
        main: 'main.tex',
        status: 'error',
        exit_code: 1,
        duration_ms: 100,
        started_at: '2026-11-24T00:00:00Z',
        error: 'compile error',
        diagnostics: [{ file: './chapters/intro.tex', line: 5, message: 'Undefined control sequence' }],
        pdf_url: null,
        log_url: '',
      }),
      builds: vi.fn().mockResolvedValue({ builds: [], latest_ok_build_id: null }),
      exportWord: vi.fn(),
      wordExports: vi.fn().mockResolvedValue({ exports: [] }),
      wordArtifactUrl: (pid: string, eid: string, name: string) =>
        `/api/projects/${pid}/latex/word-exports/${eid}/artifacts/${name}`,
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
      title: '导出测试工程',
      role: null,
      settings: { source_format: 'latex', latex: { main: 'main.tex', engine: 'pdflatex' } },
    } as typeof s.project,
    authStatus: 'off',
  }))
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

const okManifest: WordExportManifest = {
  export_id: 'w1',
  pid: 'p1',
  main: 'main.tex',
  profile: 'academic',
  profile_display: '标准学术单栏',
  lang: 'zh',
  eq_layout: 'tab',
  digest: { 'main.tex': 'x' },
  status: 'pass',
  degrades: [],
  tool: { pandoc: 'pandoc 3.6.4', runtime: 'local', exit_code: 0, duration_ms: 420 },
  artifacts: { 'paper.docx': 'paper.docx', 'manifest.json': 'manifest.json' },
}

describe('LatexWorkbench 统一 Word 导出入口', () => {
  it('默认标准单栏导出成功：显示完成与 paper.docx 下载链接', async () => {
    vi.mocked(latexApi.exportWord).mockResolvedValue(okManifest)
    const host = await mount(<LatexWorkbench pid="p1" />)
    const btn = host.querySelector<HTMLElement>('[data-testid="latex-export-word"]')!
    await act(async () => btn.click())
    await act(async () => new Promise((r) => setTimeout(r, 0)))
    expect(latexApi.exportWord).toHaveBeenCalledWith('p1', { profile: 'academic' })
    const panel = host.querySelector('[data-testid="latex-word-result"]')
    expect(panel?.textContent).toContain('标准学术单栏')
    expect(panel?.textContent).toContain('完成')
    const docxLink = host.querySelector<HTMLAnchorElement>('[data-testid="latex-word-download"]')
    expect(docxLink?.getAttribute('href')).toBe('/api/projects/p1/latex/word-exports/w1/artifacts/paper.docx')
  })

  it('可切换中文信息学报双栏版式导出', async () => {
    vi.mocked(latexApi.exportWord).mockResolvedValue({
      ...okManifest,
      profile: 'jcip',
      profile_display: '中文信息学报（双栏）',
    })
    const host = await mount(<LatexWorkbench pid="p1" />)
    const sel = host.querySelector<HTMLSelectElement>('[data-testid="latex-word-profile"]')!
    await act(async () => {
      sel.value = 'jcip'
      sel.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const btn = host.querySelector<HTMLElement>('[data-testid="latex-export-word"]')!
    await act(async () => btn.click())
    await act(async () => new Promise((r) => setTimeout(r, 0)))
    expect(latexApi.exportWord).toHaveBeenCalledWith('p1', { profile: 'jcip' })
    expect(host.querySelector('[data-testid="latex-word-result"]')?.textContent).toContain('中文信息学报')
  })

  it('blocked：显示阻断状态与原因，无 docx 链接', async () => {
    vi.mocked(latexApi.exportWord).mockResolvedValue({
      ...okManifest,
      status: 'blocked',
      degrades: ['pandoc 退出码 1'],
      artifacts: { 'manifest.json': 'manifest.json' },
    })
    const host = await mount(<LatexWorkbench pid="p1" />)
    const btn = host.querySelector<HTMLElement>('[data-testid="latex-export-word"]')!
    await act(async () => btn.click())
    await act(async () => new Promise((r) => setTimeout(r, 0)))
    const panel = host.querySelector('[data-testid="latex-word-result"]')!
    expect(panel.textContent).toContain('已阻断')
    expect(panel.textContent).toContain('pandoc 退出码 1')
    expect(host.querySelector('[data-testid="latex-word-download"]')).toBeNull()
  })

  it('请求失败：显示错误提示，不伪造成功', async () => {
    vi.mocked(latexApi.exportWord).mockRejectedValue(
      new ApiError(503, '镜像内未找到 pandoc', { kind: 'content', message: '镜像内未找到 pandoc', line: null, detail: null }),
    )
    const host = await mount(<LatexWorkbench pid="p1" />)
    const btn = host.querySelector<HTMLElement>('[data-testid="latex-export-word"]')!
    await act(async () => btn.click())
    await act(async () => new Promise((r) => setTimeout(r, 0)))
    const err = host.querySelector('[data-testid="latex-word-error"]')
    expect(err?.textContent).toContain('未找到 pandoc')
    expect(host.querySelector('[data-testid="latex-word-result"]')).toBeNull()
  })

  it('学位论文（thesis）导出提示正确显示按章编号版式，且支持跨文件编译诊断点击跳转', async () => {
    vi.mocked(latexApi.files).mockResolvedValue({
      files: [
        { path: 'main.tex', size: 10, editable: true },
        { path: 'chapters/intro.tex', size: 12, editable: true },
      ],
    })
    vi.mocked(latexApi.builds).mockResolvedValue({
      builds: [{
        build_id: 'b-err',
        status: 'error',
        engine: 'xelatex',
        main: 'main.tex',
        created_at: 1700000000,
        duration_ms: 100,
        error: 'compile error',
        diagnostics: [{ file: './chapters/intro.tex', line: 5, message: 'Undefined control sequence' }],
      }],
      latest_ok_build_id: null,
    } as never)
    vi.mocked(latexApi.exportWord).mockResolvedValue({
      ...okManifest,
      profile: 'thesis',
      profile_display: '学位论文（按章编号）',
    })
    const host = await mount(<LatexWorkbench pid="p1" />)
    await act(async () => new Promise((r) => setTimeout(r, 0)))

    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="latex-build"]')!.click())
    await act(async () => new Promise((r) => setTimeout(r, 0)))

    // 跨文件诊断按钮不再禁用，点击触发打开报错文件
    const diagBtn = host.querySelector<HTMLButtonElement>('[data-testid="latex-diagnostics"] button')!
    expect(diagBtn).not.toBeNull()
    expect(diagBtn.disabled).toBe(false)
    await act(async () => diagBtn.click())
    await act(async () => new Promise((r) => setTimeout(r, 0)))
    expect(latexApi.read).toHaveBeenCalledWith('p1', 'chapters/intro.tex')

    // thesis 导出文案检查
    const sel = host.querySelector<HTMLSelectElement>('[data-testid="latex-word-profile"]')!
    await act(async () => {
      sel.value = 'thesis'
      sel.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => host.querySelector<HTMLElement>('[data-testid="latex-export-word"]')!.click())
    await act(async () => new Promise((r) => setTimeout(r, 0)))
    expect(host.querySelector('[data-testid="latex-word-scope"]')?.textContent).toContain('学位论文（按章编号）')
  })
})

// @vitest-environment jsdom
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api/net'
import { latexApi, type DocxExportManifest } from '@/lib/api/latex'
import { useStudio } from '@/store'
import { LatexWorkbench } from '../LatexWorkbench'

/**
 * DOCX 实验性导出入口（jcip profile）的 UI 合约：
 * 成功态显示完成+实验性声明+docx/report 下载链接；blocked 态显示原因且无 docx 链接；
 * 部署未开启（404）显示不可用说明，不伪造成功。
 * CodeMirror/预览依赖真实布局，这里只断言导出面板自身（jsdom 下编辑器挂载失败不影响断言面板）。
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
      builds: vi.fn().mockResolvedValue({ builds: [], latest_ok_build_id: null }),
      exportDocx: vi.fn(),
      docxExports: vi.fn().mockResolvedValue({ exports: [] }),
      docxArtifactUrl: (pid: string, eid: string, name: string) =>
        `/api/projects/${pid}/latex/docx-exports/${eid}/artifacts/${name}`,
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

const okManifest: DocxExportManifest = {
  export_id: 'e1',
  pid: 'p1',
  venue: 'jcip',
  venue_display: '中文信息学报',
  main: 'main.tex',
  digest: { 'main.tex': 'x' },
  status: 'pass',
  export_status: 'EXPERIMENTAL — 实验性导出；未经 Microsoft Word 人工逐项版式检查完成',
  degrades: [],
  artifacts: { 'paper.docx': 'paper.docx', 'report.json': 'report.json', 'manifest.json': 'manifest.json' },
}

describe('LatexWorkbench DOCX 实验导出入口', () => {
  it('导出成功：完成状态 + 实验性声明 + docx/report 下载链接', async () => {
    vi.mocked(latexApi.exportDocx).mockResolvedValue(okManifest)
    const host = await mount(<LatexWorkbench pid="p1" />)
    const btn = host.querySelector<HTMLElement>('[data-testid="latex-export-docx"]')!
    await act(async () => btn.click())
    await act(async () => new Promise((r) => setTimeout(r, 0)))
    expect(latexApi.exportDocx).toHaveBeenCalledWith('p1')
    const panel = host.querySelector('[data-testid="latex-export-result"]')
    expect(panel?.textContent).toContain('完成')
    expect(panel?.textContent).toContain('EXPERIMENTAL')
    const docxLink = host.querySelector<HTMLAnchorElement>('[data-testid="latex-export-paper.docx"]')
    expect(docxLink?.getAttribute('href')).toBe('/api/projects/p1/latex/docx-exports/e1/artifacts/paper.docx')
    expect(host.querySelector('[data-testid="latex-export-report.json"]')).toBeTruthy()
  })

  it('blocked：显示阻断状态与原因，无 docx 链接', async () => {
    vi.mocked(latexApi.exportDocx).mockResolvedValue({
      ...okManifest,
      status: 'blocked',
      degrades: ['编号校验失败（阻断）: 未解析引用「eq:ghost」（eqref）'],
      artifacts: { 'report.json': 'report.json', 'manifest.json': 'manifest.json' },
    })
    const host = await mount(<LatexWorkbench pid="p1" />)
    const btn = host.querySelector<HTMLElement>('[data-testid="latex-export-docx"]')!
    await act(async () => btn.click())
    await act(async () => new Promise((r) => setTimeout(r, 0)))
    const panel = host.querySelector('[data-testid="latex-export-result"]')!
    expect(panel.textContent).toContain('已阻断')
    expect(panel.textContent).toContain('未解析引用「eq:ghost」')
    expect(host.querySelector('[data-testid="latex-export-paper.docx"]')).toBeNull()
    expect(host.querySelector('[data-testid="latex-export-report.json"]')).toBeTruthy()
  })

  it('部署未开启（404）：显示不可用说明，不伪造成功', async () => {
    vi.mocked(latexApi.exportDocx).mockRejectedValue(
      new ApiError(404, 'DOCX 导出未开启', { kind: 'not_found', message: 'DOCX 导出未开启', line: null, detail: null }),
    )
    const host = await mount(<LatexWorkbench pid="p1" />)
    const btn = host.querySelector<HTMLElement>('[data-testid="latex-export-docx"]')!
    await act(async () => btn.click())
    await act(async () => new Promise((r) => setTimeout(r, 0)))
    const note = host.querySelector('[data-testid="latex-export-unavailable"]')
    expect(note?.textContent).toContain('未在本部署开启')
    expect(host.querySelector('[data-testid="latex-export-result"]')).toBeNull()
  })
})

// @vitest-environment jsdom
/**
 * 导入对话框 UI 合约：上传成功→文件/候选/引擎/标题表单；拒绝原因逐条展示。
 * 服务端两段式 API 见 tests/test_latex_import.py；浏览器端到端走真实部署。
 */
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ImportDialog } from '../ImportDialog'
import { latexApi } from '@/lib/api/latex'

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
      importUpload: vi.fn(),
      importCreate: vi.fn().mockResolvedValue({ id: 'imported-paper', title: '导入验证', source_format: 'latex', latex: { main: 'main.tex', engine: 'xelatex' } }),
    },
  }
})

let root: Root | null = null
let host: HTMLElement

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  vi.clearAllMocks()
  host = document.createElement('div')
  document.body.appendChild(host)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  host?.remove()
})

async function mount(el: ReactElement) {
  root = createRoot(host)
  await act(async () => root!.render(el))
  return host
}

const fileOf = () => new File([new Uint8Array([1])], 'proj.zip', { type: 'application/zip' })

function setFiles(input: HTMLInputElement, file: File) {
  // jsdom 不允许直接赋 input.files：用 DataTransfer 真实包装（jsdom 内建 DataTransfer 支持有限，回退 Object.define）
  try {
    const dt = new DataTransfer()
    dt.items.add(file)
    input.files = dt.files
  } catch {
    Object.defineProperty(input, 'files', { value: [file] as unknown as FileList, configurable: true })
  }
}

function changeInput(input: HTMLInputElement) {
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

const staged = {
  token: 'tok1',
  filename: 'proj.zip',
  files: [
    { path: 'main.tex', size: 120, editable: true },
    { path: 'sections/part.tex', size: 40, editable: true },
    { path: 'figs/fig1.png', size: 900, editable: false },
    { path: 'refs.bib', size: 60, editable: true },
  ],
  main_candidates: ['main.tex'],
  excluded: [],
  skipped: ['.DS_Store'],
  sha256: 'ab'.repeat(16),
}

describe('ImportDialog（LaTeX ZIP 工程导入）', () => {
  it('上传成功：展示文件清单/候选主文件/跳过项，创建调用两段式 API 并回调 pid', async () => {
    vi.mocked(latexApi.importUpload).mockResolvedValue(staged)
    const onCreated = vi.fn()
    const h = await mount(<ImportDialog open onOpenChange={() => {}} onCreated={onCreated} />)
    const input = h.querySelector('[data-testid="import-file"]') as HTMLInputElement
    await act(async () => {
      setFiles(input, fileOf())
      changeInput(input)
    })
    await act(async () => {
      h.querySelector('[data-testid="import-upload"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(latexApi.importUpload).toHaveBeenCalledOnce()
    const filesBox = h.querySelector('[data-testid="import-files"]')
    expect(filesBox?.textContent).toContain('figs/fig1.png')
    expect(h.textContent).toContain('已跳过系统垃圾文件')
    const mainSel = h.querySelector('[data-testid="import-main"]') as HTMLSelectElement
    expect(mainSel.value).toBe('main.tex')
    await act(async () => {
      h.querySelector('[data-testid="import-create"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(latexApi.importCreate).toHaveBeenCalledWith('tok1', 'main.tex', 'xelatex', '')
    expect(onCreated).toHaveBeenCalledWith('imported-paper')
  })

  it('上传拒绝：原因逐条展示，不进入创建步骤', async () => {
    vi.mocked(latexApi.importUpload).mockRejectedValue(new Error('拒绝路径穿越条目：../evil.tex'))
    const h = await mount(<ImportDialog open onOpenChange={() => {}} onCreated={() => {}} />)
    const input = h.querySelector('[data-testid="import-file"]') as HTMLInputElement
    await act(async () => {
      setFiles(input, fileOf())
      changeInput(input)
    })
    await act(async () => {
      h.querySelector('[data-testid="import-upload"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const err = h.querySelector('[data-testid="import-err"]')
    expect(err?.textContent).toContain('拒绝路径穿越条目')
    expect(h.querySelector('[data-testid="import-main"]')).toBeNull()
  })
})

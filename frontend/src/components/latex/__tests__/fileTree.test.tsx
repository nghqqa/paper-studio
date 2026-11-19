// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { LatexFileTree } from '../LatexFileTree'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLElement
let root: Root | null = null

beforeAll(() => {
  Element.prototype.scrollIntoView ??= () => {}
})

const FILES = [
  { path: 'docs/figures.md', size: 10, editable: true },
  { path: 'figs/cas-grabs.pdf', size: 10, editable: false },
  { path: 'figs/cas-munnar-2024.jpg', size: 10, editable: false },
  { path: 'Makefile', size: 10, editable: false },
  { path: 'main.tex', size: 10, editable: true },
  { path: 'refs.bib', size: 10, editable: true },
]

function render(el: ReactElement) {
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  act(() => root!.render(el))
}

const onOpen = vi.fn()

function tree() {
  return <LatexFileTree files={FILES} active="main.tex" dirty={false} onOpen={onOpen} />
}

afterEach(() => {
  if (root) { act(() => root!.unmount()); root = null }
  host?.remove()
})

describe('LatexFileTree', () => {
  it('文件夹与文件分组渲染，tex 可点、pdf 只读禁用', () => {
    render(tree())
    expect(document.querySelector('[data-testid="latex-dir-docs"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="latex-dir-figs"]')).not.toBeNull()
    const main = document.querySelector('[data-testid="latex-file-main.tex"]') as HTMLButtonElement
    expect(main).not.toBeNull()
    expect(main.disabled).toBe(false)
    const pdf = document.querySelector('[data-testid="latex-file-figs/cas-grabs.pdf"]') as HTMLButtonElement
    expect(pdf.disabled).toBe(true)
  })

  it('点击文件回调 onOpen（带相对路径）', () => {
    render(tree())
    const main = document.querySelector('[data-testid="latex-file-main.tex"]') as HTMLButtonElement
    act(() => main.click())
    expect(onOpen).toHaveBeenCalledWith('main.tex')
  })

  it('点击文件夹折叠其子文件', () => {
    render(tree())
    const dir = document.querySelector('[data-testid="latex-dir-docs"]') as HTMLButtonElement
    act(() => dir.click())
    act(() => { void dir })
    expect(document.querySelector('[data-testid="latex-file-docs/figures.md"]')).toBeNull()
    act(() => dir.click())
    act(() => { void dir })
    expect(document.querySelector('[data-testid="latex-file-docs/figures.md"]')).not.toBeNull()
  })

  it('图片/PDF 只读文件可点 → onPreview；未传 onPreview 时维持禁用', () => {
    const onPreview = vi.fn()
    render(<LatexFileTree files={FILES} active="main.tex" dirty={false} onOpen={onOpen} onPreview={onPreview} />)
    const pdf = document.querySelector('[data-testid="latex-file-figs/cas-grabs.pdf"]') as HTMLButtonElement
    expect(pdf.disabled).toBe(false)
    act(() => pdf.click())
    expect(onPreview).toHaveBeenCalledWith('figs/cas-grabs.pdf')
    const img = document.querySelector('[data-testid="latex-file-figs/cas-munnar-2024.jpg"]') as HTMLButtonElement
    act(() => img.click())
    expect(onPreview).toHaveBeenCalledWith('figs/cas-munnar-2024.jpg')
    const mk = document.querySelector('[data-testid="latex-file-Makefile"]') as HTMLButtonElement
    expect(mk.disabled).toBe(true)
  })

  it('未传 onPreview：只读文件保持禁用（旧行为）', () => {
    render(tree())
    const pdf = document.querySelector('[data-testid="latex-file-figs/cas-grabs.pdf"]') as HTMLButtonElement
    expect(pdf.disabled).toBe(true)
  })
})

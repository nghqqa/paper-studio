// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { figuresApi, type ProjectFigure } from '@/lib/api/projectFigures'
import { DiagramEditor } from '../DiagramEditor'

/* jsdom 无 canvas：excalidraw 全家桶整体桩掉，验证编辑器对象契约（场景恢复 / 版本并发保存 / Mermaid 覆盖确认 / 409 呈现）。 */
const updateScene = vi.fn()
const addFiles = vi.fn()
let sceneEls: unknown[] = [{ id: 'e1', type: 'rectangle' }]
const mockApi = {
  updateScene, addFiles,
  getSceneElements: () => sceneEls as never,
  getSceneElementsIncludingDeleted: () => sceneEls as never,
  getAppState: () => ({}) as never,
  getFiles: () => ({}) as never,
}
vi.mock('@excalidraw/excalidraw', () => ({
  Excalidraw: (p: { excalidrawAPI?: (a: unknown) => void }) => {
    p.excalidrawAPI?.(mockApi)
    return null
  },
  serializeAsJSON: vi.fn(() => '{"type":"excalidraw","version":2,"elements":[]}'),
  exportToBlob: vi.fn(async () => new Blob(['png-bytes'], { type: 'image/png' })),
  restore: vi.fn(async () => ({ elements: [{ id: 'e-restored' }], appState: {}, files: {} })),
  convertToExcalidrawElements: (els: unknown[]) => els,
}))
vi.mock('@excalidraw/excalidraw/index.css', () => ({}))
vi.mock('@excalidraw/mermaid-to-excalidraw', () => ({
  parseMermaidToExcalidraw: vi.fn(async () => ({ elements: [{ id: 'm1', type: 'rectangle' }], files: {} })),
}))

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

const diagramFigure = (version = 2): ProjectFigure => ({
  id: 'fig-100-abc123', name: '架构图', kind: 'diagram', version,
  created_at: 1, bytes: 10, updated_at: 2,
})

let root: Root
let host: HTMLDivElement

beforeAll(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true })
beforeEach(() => {
  updateScene.mockClear(); addFiles.mockClear()
  sceneEls = [{ id: 'e1', type: 'rectangle' }]
  vi.spyOn(figuresApi, 'getScene').mockResolvedValue({ id: 'x', name: '架构图', version: 2, scene: '{"type":"excalidraw","elements":[]}' })
  vi.spyOn(figuresApi, 'updateDiagram').mockResolvedValue({ figure: diagramFigure(3) })
  vi.spyOn(figuresApi, 'createDiagram').mockResolvedValue({ figure: diagramFigure(1) })
  vi.spyOn(window, 'confirm').mockReturnValue(true)
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
async function mount(figure: ProjectFigure | null) {
  await act(async () => root.render(<DiagramEditor pid="p1" figure={figure} onClose={() => { }} onSaved={() => { }} />))
}
async function clickSave() {
  await act(async () => q('[data-testid="diagram-editor-save"]').click())
}
async function inputName(value: string) {
  await act(async () => {
    const el = q<HTMLInputElement>('input[data-testid="diagram-editor-name"]')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function openMermaidAndInput(code: string) {
  await act(async () => q('[data-testid="diagram-editor-mermaid"]').click())
  await act(async () => {
    const el = q<HTMLTextAreaElement>('textarea[data-testid="diagram-editor-mermaid-code"]')
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, code)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('creates a new diagram with edited name via createDiagram', async () => {
  await mount(null)
  await inputName('总览图')
  await clickSave()
  expect(figuresApi.createDiagram).toHaveBeenCalledWith('p1', {
    name: '总览图', scene: '{"type":"excalidraw","version":2,"elements":[]}',
    png_data_url: 'data:image/png;base64,cG5nLWJ5dGVz',
  })
})

it('restores scene via getScene and saves update with the loaded expected_version', async () => {
  await mount(diagramFigure(2))
  await act(async () => { await Promise.resolve() })
  expect(figuresApi.getScene).toHaveBeenCalledWith('p1', 'fig-100-abc123')
  expect(updateScene).toHaveBeenCalled()
  await clickSave()
  expect(figuresApi.updateDiagram).toHaveBeenCalledWith('p1', 'fig-100-abc123',
    expect.objectContaining({ expected_version: 2 }))
})

it('surfaces version conflicts without closing the editor', async () => {
  const onSaved = vi.fn()
  await act(async () => root.render(<DiagramEditor pid="p1" figure={diagramFigure(1)} onClose={() => { }} onSaved={onSaved} />))
  await act(async () => { await Promise.resolve() })
  vi.mocked(figuresApi.updateDiagram).mockRejectedValueOnce(new Error('该方法图已被他人更新，请重新打开编辑器后再保存'))
  await clickSave()
  expect(q('[role="alert"]').textContent).toContain('已被他人更新')
  expect(onSaved).not.toHaveBeenCalled()
})

it('requires explicit confirm before mermaid overwrites a non-empty canvas', async () => {
  await mount(diagramFigure(1))
  await act(async () => { await Promise.resolve() })
  await openMermaidAndInput('graph TD; A-->B')
  const before = updateScene.mock.calls.length
  await act(async () => q('[data-testid="diagram-editor-mermaid-apply"]').click())
  expect(window.confirm).toHaveBeenCalledWith('应用 Mermaid 将覆盖当前画布布局与内容，确认继续？')
  expect(updateScene.mock.calls.length).toBe(before + 1)
})

it('applies mermaid without confirm on an empty canvas', async () => {
  sceneEls = []
  await mount(null)
  await openMermaidAndInput('graph TD; A-->B')
  await act(async () => q('[data-testid="diagram-editor-mermaid-apply"]').click())
  expect(window.confirm).not.toHaveBeenCalled() // 空画布不确认
  expect(updateScene).toHaveBeenCalled()
})

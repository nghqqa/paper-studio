import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, useState, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { CrossFileSearch } from '../CrossFileSearch'
import type { ProjectContentIndex, SearchHit } from '../editorSearch'

// @vitest-environment jsdom

let host: HTMLDivElement | null = null
let root: Root | null = null

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  Element.prototype.scrollIntoView ??= () => {}
  // cmdk 依赖 ResizeObserver（jsdom 无）
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  ;(globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver ??= RO
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

function makeIndex(overrides: Partial<ProjectContentIndex> = {}) {
  const index = {
    ready: true,
    isPartial: false,
    ensure: vi.fn(async () => {}),
    searchAll: vi.fn((_q: string): SearchHit[] => []),
    ...overrides,
  }
  return index as unknown as ProjectContentIndex & {
    ready: boolean
    isPartial: boolean
    ensure: ReturnType<typeof vi.fn>
    searchAll: ReturnType<typeof vi.fn>
  }
}

function Harness({ index, onPick }: { index: ProjectContentIndex; onPick: (p: string, l: number) => void }) {
  const [signal, setSignal] = useState(0)
  return (
    <div>
      <button type="button" data-testid="open-btn" onClick={() => setSignal((t) => t + 1)}>open</button>
      <CrossFileSearch index={index} openSignal={signal} onPick={onPick} />
    </div>
  )
}

async function setInput(value: string) {
  const input = document.querySelector('[data-testid="crossfile-input"]') as HTMLInputElement
  expect(input).not.toBeNull()
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 200)) // 过防抖（120ms）
  })
}

describe('CrossFileSearch（跨文件搜索弹层）', () => {
  it('openSignal 递增打开弹层；索引未就绪先 ensure；空查询显示引导', async () => {
    let resolveEnsure!: () => void
    const index = makeIndex({
      ready: false,
      ensure: vi.fn(() => new Promise<void>((r) => { resolveEnsure = r })),
    })
    const onPick = vi.fn()
    render(<Harness index={index} onPick={onPick} />)
    expect(document.querySelector('[data-testid="crossfile-input"]')).toBeNull()
    await act(async () => {
      ;(document.querySelector('[data-testid="open-btn"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })
    expect(index.ensure).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-testid="crossfile-loading"]')).not.toBeNull()
    await act(async () => {
      resolveEnsure()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(document.querySelector('[data-testid="crossfile-loading"]')).toBeNull()
    expect(document.querySelector('[data-testid="crossfile-hint"]')).not.toBeNull()
  })

  it('输入关键词 → 防抖后按文件分组展示命中；点击回传 path+line', async () => {
    const hits: SearchHit[] = [
      { path: 'main.tex', line: 12, col: 3, text: 'the needle line' },
      { path: 'main.tex', line: 30, col: 1, text: 'another needle' },
      { path: 'sections/app.tex', line: 4, col: 8, text: 'needle in appendix' },
    ]
    const index = makeIndex({ searchAll: vi.fn(() => hits) })
    const onPick = vi.fn()
    render(<Harness index={index} onPick={onPick} />)
    await act(async () => {
      ;(document.querySelector('[data-testid="open-btn"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })
    await setInput('needle')
    expect(index.searchAll).toHaveBeenCalledWith('needle')
    // 按文件分组：main.tex 2 条 + sections/app.tex 1 条
    const items = document.querySelectorAll('[data-testid^="crossfile-hit-"]')
    expect(items).toHaveLength(3)
    // 点击第一条 → onPick('main.tex', 12)，弹层关闭
    await act(async () => {
      ;(document.querySelector('[data-testid="crossfile-hit-12"]') as HTMLElement).click()
      await Promise.resolve()
    })
    expect(onPick).toHaveBeenCalledWith('main.tex', 12)
  })

  it('partial 索引在底部如实提示；无结果显示空态', async () => {
    const index = makeIndex({ isPartial: true, searchAll: vi.fn(() => []) })
    render(<Harness index={index} onPick={vi.fn()} />)
    await act(async () => {
      ;(document.querySelector('[data-testid="open-btn"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })
    await setInput('nothing-matches')
    expect(document.querySelector('[data-testid="crossfile-empty"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="crossfile-footer"]')!.textContent).toContain('大文件已跳过')
  })
})

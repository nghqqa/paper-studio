import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SymbolPanel } from '../SymbolPanel'

// @vitest-environment jsdom

let host: HTMLDivElement | null = null
let root: Root | null = null

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
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

function setInputValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('SymbolPanel（符号面板）', () => {
  it('渲染全部分组与数学符号的 KaTeX 真字形预览；结构组显示等宽字面量', () => {
    const onInsert = vi.fn()
    render(<SymbolPanel onInsert={onInsert} />)
    const panel = document.querySelector('[data-testid="latex-symbols-panel"]')!
    for (const label of ['希腊字母', '运算与关系', '箭头', '逻辑与集合', '定界符', '重音与装饰', '结构与引用']) {
      expect(panel.textContent).toContain(label)
    }
    // 数学组：katex 渲染 .katex 结构；结构组：等宽字面量
    expect(document.querySelectorAll('[data-testid^="latex-symbol-"]').length).toBeGreaterThan(100)
    const alpha = document.querySelector('[data-testid="latex-symbol-alpha"]')!
    expect(alpha.querySelector('.katex')).not.toBeNull()
    const ref = document.querySelector('[data-testid="latex-symbol-ref"]')!
    expect(ref.querySelector('svg')).toBeNull()
    expect(ref.textContent).toContain('\\ref{}')
    // 计数 > 100
    const count = Number((document.querySelector('[data-testid="latex-symbols-count"]')!.textContent || '').match(/\d+/)?.[0])
    expect(count).toBeGreaterThan(100)
  })

  it('过滤：输入 sqrt 只剩匹配项；点击回传命令字面量', async () => {
    const onInsert = vi.fn()
    render(<SymbolPanel onInsert={onInsert} />)
    await act(async () => {
      setInputValue(document.querySelector('[data-testid="latex-symbols-filter"]') as HTMLInputElement, 'sqrt')
      await Promise.resolve()
    })
    const buttons = [...document.querySelectorAll('[data-testid^="latex-symbol-"]')]
    expect(buttons).toHaveLength(1)
    await act(async () => {
      ;(buttons[0] as HTMLButtonElement).click()
      await Promise.resolve()
    })
    expect(onInsert).toHaveBeenCalledWith('\\sqrt{}')
  })

  it('无匹配显示空态；Esc 触发 onClose', async () => {
    const onClose = vi.fn()
    render(<SymbolPanel onInsert={vi.fn()} onClose={onClose} />)
    const input = document.querySelector('[data-testid="latex-symbols-filter"]') as HTMLInputElement
    await act(async () => {
      setInputValue(input, 'zzzz-not-a-symbol')
      await Promise.resolve()
    })
    expect(document.querySelector('[data-testid="latex-symbols-empty"]')).not.toBeNull()
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await Promise.resolve()
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

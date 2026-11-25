// @vitest-environment jsdom
import axe from 'axe-core'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { TableGeneratorDialog } from '../TableGeneratorDialog'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

let host: HTMLDivElement | null = null
let root: Root | null = null

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = null
})

describe('TableGeneratorDialog（三线表生成器）', () => {
  it('默认加载示例、支持切换列指标方向并点击插入光标处，且无障碍合规', async () => {
    const onInsert = vi.fn()
    const onOpenChange = vi.fn()
    host = document.body.appendChild(document.createElement('div'))
    root = createRoot(host)
    await act(async () => {
      root!.render(<TableGeneratorDialog open onOpenChange={onOpenChange} onInsert={onInsert} />)
    })

    const codePre = document.querySelector('[data-testid="table-gen-code"]')!
    expect(codePre.textContent).toContain('\\toprule')
    expect(codePre.textContent).toContain('\\textbf{91.4 ± 0.2}')
    expect(codePre.textContent).toContain('\\textbf{24.8}')

    const res = await axe.run(document.body, {
      resultTypes: ['violations'],
      rules: { 'color-contrast': { enabled: false }, 'scrollable-region-focusable': { enabled: false }, region: { enabled: false } },
    })
    expect(res.violations).toEqual([])

    // 切换第 4 列方向（min → none），最优加粗应取消
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="table-gen-col-mode-3"]')!.click()
    })
    expect(codePre.textContent).not.toContain('\\textbf{24.8}')

    // 点击插入到光标处
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="table-gen-insert"]')!.click()
    })
    expect(onInsert).toHaveBeenCalledTimes(1)
    expect(onInsert.mock.calls[0]?.[0]).toContain('\\begin{table}[htbp]')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

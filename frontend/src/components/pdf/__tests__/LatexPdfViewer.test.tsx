// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const docInstances: Array<{
  file: unknown
  numPages: number
  onLoadSuccess?: (doc: unknown) => void
  onLoadError?: () => void
  onItemClick?: (args: { pageNumber?: number }) => void
}> = []

const pageRenderCallbacks = new Map<string, { onRenderSuccess?: () => void; onLoadSuccess?: (p: unknown) => void }>()

const sampleTexts: Record<number, { items: Array<{ str: string; transform: number[] }> }> = {
  1: { items: [{ str: 'Transformer Attention Mechanism', transform: [1, 0, 0, 1, 50, 700] }] },
  2: { items: [{ str: 'Experiment Attention Results', transform: [1, 0, 0, 1, 50, 500] }] },
  3: { items: [{ str: 'Conclusion', transform: [1, 0, 0, 1, 50, 300] }] },
}

vi.mock('react-pdf', () => ({
  pdfjs: { GlobalWorkerOptions: {} },
  Document: ({
    file,
    children,
    onLoadSuccess,
    onLoadError,
    onItemClick,
  }: {
    file: unknown
    children?: ReactNode
    onLoadSuccess?: (doc: unknown) => void
    onLoadError?: () => void
    onItemClick?: (args: { pageNumber?: number }) => void
  }) => {
    const inst = { file, numPages: 3, onLoadSuccess, onLoadError, onItemClick }
    docInstances.push(inst)
    return (
      <div
        data-testid="mock-doc"
        onClick={(e) => {
          const btn = (e.target as HTMLElement).closest('[data-item-page]')
          if (btn) {
            const p = Number(btn.getAttribute('data-item-page'))
            onItemClick?.({ pageNumber: p })
          }
        }}
      >
        {children}
      </div>
    )
  },
  Page: ({
    pageNumber,
    width,
    onLoadSuccess,
    onRenderSuccess,
    customTextRenderer,
  }: {
    pageNumber: number
    width?: number
    onLoadSuccess?: (page: unknown) => void
    onRenderSuccess?: () => void
    customTextRenderer?: (args: { str: string; pageNumber: number; itemIndex: number }) => string
  }) => {
    pageRenderCallbacks.set(`${pageNumber}`, { onLoadSuccess, onRenderSuccess })
    const txt = sampleTexts[pageNumber]?.items[0]?.str ?? ''
    const rendered = customTextRenderer
      ? customTextRenderer({ str: txt, pageNumber, itemIndex: 0 })
      : txt
    return (
      <div data-testid={`mock-page-${pageNumber}`} data-width={width}>
        {customTextRenderer ? (
          <span dangerouslySetInnerHTML={{ __html: rendered }} />
        ) : (
          <span>{txt}</span>
        )}
      </div>
    )
  },
}))

vi.mock('react-pdf/dist/Page/TextLayer.css', () => ({}))
vi.mock('react-pdf/dist/Page/AnnotationLayer.css', () => ({}))

import LatexPdfViewer from '../LatexPdfViewer'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

let root: Root | null = null
let host: HTMLElement | null = null

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  docInstances.length = 0
  pageRenderCallbacks.clear()
  vi.restoreAllMocks()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })))
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = null
  host?.remove()
  host = null
  vi.useRealTimers()
})

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function makeFakeDoc() {
  return {
    numPages: 3,
    getPage: vi.fn(async (n: number) => ({
      getViewport: () => ({ width: 600, height: 800 }),
      getTextContent: async () => sampleTexts[n] ?? { items: [] },
    })),
    getOutline: vi.fn(async () => [{ title: '1. Introduction', dest: [{ num: 1 }], items: [] }]),
    getDestination: vi.fn(async () => [{ num: 1 }]),
    getPageIndex: vi.fn(async () => 1),
  }
}

async function mountViewer(el: React.ReactElement) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(el)
  })
  await flushMicrotasks()
  return host
}

async function resolveLatestDoc(doc = makeFakeDoc()) {
  const latest = docInstances[docInstances.length - 1]
  await act(async () => {
    latest.onLoadSuccess?.(doc)
  })
  await flushMicrotasks()
  return doc
}

describe('LatexPdfViewer', () => {
  it('双缓冲热更新：新 PDF 在隐藏槽加载完毕前保持旧槽可见，画完后切前台', async () => {
    const h = await mountViewer(<LatexPdfViewer url="/api/projects/p1/latex/builds/b1/artifacts/pdf" />)
    await resolveLatestDoc()

    expect(h.querySelector('[data-testid="latex-pdf-active"]')).not.toBeNull()
    expect(h.querySelector('[data-testid="latex-pdf-staging"]')).toBeNull()
    expect(h.querySelector('[data-testid="latex-pdf-total-pages"]')?.textContent).toContain('3')

    // 触发重编译新 URL：应保留 active 并在 staging 并行渲染
    await act(async () => {
      root!.render(<LatexPdfViewer url="/api/projects/p1/latex/builds/b2/artifacts/pdf" building />)
    })
    await flushMicrotasks()

    expect(h.querySelector('[data-testid="latex-pdf-rebuilding"]')).not.toBeNull()
    expect(h.querySelector('[data-testid="latex-pdf-active"]')).not.toBeNull()
    expect(h.querySelector('[data-testid="latex-pdf-staging"]')).not.toBeNull()

    await resolveLatestDoc()
    // 模拟可见页全部渲染完成，触发交换
    await act(async () => {
      for (const cb of pageRenderCallbacks.values()) cb.onRenderSuccess?.()
    })
    await flushMicrotasks()
    expect(h.querySelector('[data-testid="latex-pdf-staging"]')).toBeNull()
    expect(h.querySelector('[data-testid="latex-pdf-active"]')).not.toBeNull()
  })

  it('SyncTeX 正向跳转按 nonce 精确滚动并绘制高亮条（支持同页重复定位）', async () => {
    const h = await mountViewer(<LatexPdfViewer url="/api/projects/p1/latex/builds/b1/artifacts/pdf" />)
    await resolveLatestDoc()

    const scroller = h.querySelector('[data-testid="latex-pdf-scroll"]') as HTMLDivElement
    const scrollSpy = vi.fn()
    scroller.scrollTo = scrollSpy

    await act(async () => {
      root!.render(
        <LatexPdfViewer
          url="/api/projects/p1/latex/builds/b1/artifacts/pdf"
          jumpTarget={{ page: 2, xPt: 120, yPt: 200, nonce: 101 }}
        />,
      )
    })
    await flushMicrotasks()

    const hl1 = h.querySelector('[data-page="2"] [data-testid="latex-pdf-synctex-highlight"]') as HTMLElement | null
    expect(hl1).not.toBeNull()
    expect(hl1?.style.top).toBe('25%')
    expect(scrollSpy).toHaveBeenCalledTimes(1)

    // 同页不同 y 坐标的新 nonce 仍必须再次触发滚动与高亮更新
    await act(async () => {
      root!.render(
        <LatexPdfViewer
          url="/api/projects/p1/latex/builds/b1/artifacts/pdf"
          jumpTarget={{ page: 2, xPt: 150, yPt: 600, nonce: 102 }}
        />,
      )
    })
    await flushMicrotasks()
    const hl2 = h.querySelector('[data-page="2"] [data-testid="latex-pdf-synctex-highlight"]') as HTMLElement | null
    expect(hl2?.style.top).toBe('75%')
    expect(scrollSpy).toHaveBeenCalledTimes(2)
  })

  it('SyncTeX 反向跳转仅响应双击 / Ctrl+Click（顶左原点 yPt），且有文本选区时不误触发', async () => {
    const onInverseSync = vi.fn()
    const h = await mountViewer(
      <LatexPdfViewer url="/api/projects/p1/latex/builds/b1/artifacts/pdf" onInverseSync={onInverseSync} />,
    )
    await resolveLatestDoc()

    const page1 = h.querySelector('[data-page="1"]') as HTMLDivElement
    page1.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 600, height: 800, right: 600, bottom: 800, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect

    vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => '' } as Selection)

    // 普通单击不跳转（避免干扰文本选区）
    await act(async () => {
      page1.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 150, clientY: 160 }))
    })
    expect(onInverseSync).not.toHaveBeenCalled()

    // 双击触发反向跳转，yPt 按顶左原点计算（160 / 800 * 800 = 160，而非翻转值 640）
    await act(async () => {
      page1.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 150, clientY: 160 }))
    })
    expect(onInverseSync).toHaveBeenCalledTimes(1)
    expect(onInverseSync).toHaveBeenLastCalledWith({ page: 1, xPt: 150, yPt: 160 })

    // Ctrl + Click 触发反向跳转
    await act(async () => {
      page1.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true, clientX: 300, clientY: 600 }))
    })
    expect(onInverseSync).toHaveBeenCalledTimes(2)
    expect(onInverseSync).toHaveBeenLastCalledWith({ page: 1, xPt: 300, yPt: 600 })

    // 存在文字选区时双击禁止跳转
    vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => 'selected words' } as Selection)
    await act(async () => {
      page1.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 120, clientY: 120 }))
    })
    expect(onInverseSync).toHaveBeenCalledTimes(2)
  })

  it('支持缩放切换、页码跳转与 PDF 全文查找高亮', async () => {
    const h = await mountViewer(<LatexPdfViewer url="/api/projects/p1/latex/builds/b1/artifacts/pdf" />)
    await resolveLatestDoc()

    // 切换缩放到 150%
    const sel = h.querySelector('[data-testid="latex-pdf-zoom-select"]') as HTMLSelectElement
    await act(async () => {
      sel.value = '1.5'
      sel.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(h.querySelector('[data-testid="latex-pdf-viewer"]')?.getAttribute('data-zoom-fit')).toBe('custom')

    // 开关全文查找并输入查询词
    const toggle = h.querySelector('[data-testid="latex-pdf-find-toggle"]') as HTMLButtonElement
    await act(async () => {
      toggle.click()
    })
    const input = h.querySelector('[data-testid="latex-pdf-find-input"]') as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'Attention')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flushMicrotasks()

    expect(h.querySelector('[data-testid="latex-pdf-find-count"]')?.textContent).toBe('1 / 2')
    const nextBtn = h.querySelector('[data-testid="latex-pdf-find-next"]') as HTMLButtonElement
    await act(async () => {
      nextBtn.click()
    })
    expect(h.querySelector('[data-testid="latex-pdf-find-count"]')?.textContent).toBe('2 / 2')

    // 打开书签大纲并点击条目跳页
    const outlineBtn = h.querySelector('[data-testid="latex-pdf-outline-toggle"]') as HTMLButtonElement
    expect(outlineBtn).not.toBeNull()
    await act(async () => {
      outlineBtn.click()
    })
    const outlineBox = h.querySelector('[data-testid="latex-pdf-outline"]')
    expect(outlineBox?.textContent).toContain('1. Introduction')
  })

  it('首次 fetch 失败自动重试一次，第二次仍失败则展示可点击重试按钮', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async () => new Response('missing', { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)

    const h = await mountViewer(<LatexPdfViewer url="/api/projects/p1/latex/builds/bad/artifacts/pdf" />)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(850)
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(h.querySelector('[data-testid="latex-pdf-error"]')).not.toBeNull()
    expect(h.querySelector('[data-testid="latex-pdf-retry"]')).not.toBeNull()
  })
})

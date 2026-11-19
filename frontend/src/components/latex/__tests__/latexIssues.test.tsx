import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { LatexIssues } from '../LatexIssues'
import type { LatexDiagnostic } from '@/lib/api/latex'

// @vitest-environment jsdom

let host: HTMLDivElement | null = null
let root: Root | null = null

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  Element.prototype.scrollIntoView ??= () => {}
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
  vi.unstubAllGlobals()
})

const DIAGS: LatexDiagnostic[] = [
  { file: './main.tex', line: 12, message: 'Undefined control sequence' },
]

describe('LatexIssues 修复提案入口', () => {
  it('编译错误行 hover 出现「生成修复提案」按钮，点击回传该条诊断', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ issues: [] }), { status: 200 })))
    const proposeFix = vi.fn()
    render(
      <LatexIssues pid="p1" activeFile="main.tex" diagList={DIAGS} onJump={() => {}} proposeFix={proposeFix} />,
    )
    await act(async () => { await Promise.resolve() })
    const btn = document.querySelector('[data-testid="latex-issue-proposefix-0"]') as HTMLButtonElement
    expect(btn).not.toBeNull()
    await act(async () => {
      btn.click()
      await Promise.resolve()
    })
    expect(proposeFix).toHaveBeenCalledTimes(1)
    expect(proposeFix).toHaveBeenCalledWith(DIAGS[0])
  })

  it('不传 proposeFix 时不渲染入口（Word/只读等场景零打扰）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ issues: [] }), { status: 200 })))
    render(<LatexIssues pid="p1" activeFile="main.tex" diagList={DIAGS} onJump={() => {}} />)
    await act(async () => { await Promise.resolve() })
    expect(document.querySelector('[data-testid="latex-issue-proposefix-0"]')).toBeNull()
  })
})

describe('LatexIssues 错误展示与 AI 空内容防护', () => {
  it('新增框收起时 AI 审阅抛错：全局 role=alert 显示错误文本，可手动关闭', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ issues: [] }), { status: 200 })))
    const aiReview = vi.fn(async (): Promise<number> => { throw new Error('模型调用超限') })
    render(<LatexIssues pid="p1" activeFile="main.tex" diagList={[]} onJump={() => {}} aiReview={aiReview} />)
    await act(async () => { await Promise.resolve() })

    // 新增框处于收起态（未点过 compose-toggle），错误横幅为全局渲染
    expect(document.querySelector('[data-testid="latex-issue-composer"]')).toBeNull()
    const aiBtn = document.querySelector('[data-testid="latex-issue-ai"]') as HTMLButtonElement
    expect(aiBtn.disabled).toBe(false)
    await act(async () => {
      aiBtn.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    const alert = document.querySelector('[role="alert"]') as HTMLElement
    expect(alert).not.toBeNull()
    expect(alert.textContent).toContain('模型调用超限')
    // 错误与新增框开合解耦：错误显示期间 composer 仍为收起态
    expect(document.querySelector('[data-testid="latex-issue-composer"]')).toBeNull()

    // 点击关闭按钮清除旧错误
    const dismiss = document.querySelector('[data-testid="latex-issues-error-dismiss"]') as HTMLButtonElement
    expect(dismiss).not.toBeNull()
    await act(async () => {
      dismiss.click()
      await Promise.resolve()
    })
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(aiReview).toHaveBeenCalledTimes(1)
  })

  it('初始 /issues 失败：不卡「加载中…」，显示错误态与重试，重试成功后恢复列表', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Issues 服务不可用') }))
    render(<LatexIssues pid="p1" activeFile="main.tex" diagList={[]} onJump={() => {}} />)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    // 不再永远停在「加载中…」
    expect(document.body.textContent).not.toContain('加载中…')
    expect(document.querySelector('[data-testid="latex-issues-load-failed"]')).not.toBeNull()
    const alert = document.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('Issues 服务不可用')

    // 重试成功 → 恢复正常列表（空工程显示空态）
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ issues: [] }), { status: 200 })))
    const retry = document.querySelector('[data-testid="latex-issues-retry"]') as HTMLButtonElement
    expect(retry).not.toBeNull()
    await act(async () => {
      retry.click()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(document.querySelector('[data-testid="latex-issues-load-failed"]')).toBeNull()
    expect(document.body.textContent).toContain('暂无 Issue')
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })

  it('传入 activeFileEmpty（内容为空/纯空白）时 AI 审阅按钮禁用且不调用 aiReview', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ issues: [] }), { status: 200 })))
    const aiReview = vi.fn(async (): Promise<number> => 0)
    render(
      <LatexIssues
        pid="p1" activeFile="main.tex" diagList={[]} onJump={() => {}}
        aiReview={aiReview} activeFileEmpty
      />,
    )
    await act(async () => { await Promise.resolve() })

    const aiBtn = document.querySelector('[data-testid="latex-issue-ai"]') as HTMLButtonElement
    expect(aiBtn.disabled).toBe(true)
    expect(aiBtn.getAttribute('title')).toContain('当前文件内容为空，无法进行 AI 审阅')
    await act(async () => {
      aiBtn.click()
      await Promise.resolve()
    })
    expect(aiReview).not.toHaveBeenCalled()
  })

  it('向后兼容：未传 activeFileEmpty 时按钮行为与旧版一致（activeFile 存在即可点）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ issues: [] }), { status: 200 })))
    const aiReview = vi.fn(async (): Promise<number> => 0)
    render(<LatexIssues pid="p1" activeFile="main.tex" diagList={[]} onJump={() => {}} aiReview={aiReview} />)
    await act(async () => { await Promise.resolve() })

    const aiBtn = document.querySelector('[data-testid="latex-issue-ai"]') as HTMLButtonElement
    expect(aiBtn.disabled).toBe(false)
  })
})

// LatexHistory 组件测试：版本列表/差异加载/恢复回调/只读禁用（jsdom，API 全 mock）。
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { LatexHistory } from '../LatexHistory'
import { latexApi, type LatexVersion } from '@/lib/api/latex'

// @vitest-environment jsdom

vi.mock('@/lib/api/latex', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/api/latex')>()
  return { ...mod, latexApi: { ...mod.latexApi, history: vi.fn(), historyDiff: vi.fn(), restoreVersion: vi.fn() } }
})

const VERSIONS: LatexVersion[] = [
  { sha: 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111', at: 1761500000, message: 'build', author: 'studio', added: 3, deleted: 1, files: 2 },
  { sha: 'bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222', at: 1761400000, message: 'save main.tex', author: 'a@x.cn', added: 10, deleted: 0, files: 1 },
]

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

function q<T extends Element>(sel: string): T {
  const el = host!.querySelector(sel)
  if (!el) throw new Error(`missing ${sel}`)
  return el as T
}

describe('LatexHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(latexApi.history).mockResolvedValue(VERSIONS)
    vi.mocked(latexApi.historyDiff).mockResolvedValue({ a: 'a', b: 'work', diff: '+new line\n-old line' })
  })

  it('渲染版本列表（人话标签 + 行数统计），暂无版本时给空态', async () => {
    render(<LatexHistory pid="p1" canEdit onRestore={() => Promise.resolve('ok')} />)
    await act(async () => {})
    const items = host!.querySelectorAll('[data-testid="latex-history-list"] [role="option"]')
    expect(items).toHaveLength(2)
    expect(items[0]!.textContent).toContain('编译快照')
    expect(items[1]!.textContent).toContain('保存 · main.tex')
    expect(q('[data-testid="latex-version-lines"]').textContent).toContain('+3')
    vi.mocked(latexApi.history).mockResolvedValue([])
    act(() => q<HTMLButtonElement>('[data-testid="latex-history-refresh"]').click())
    await act(async () => {})
    expect(q('[data-testid="latex-history-empty"]').textContent).toContain('暂无版本')
  })

  it('选中版本拉取与工作区的差异；恢复按钮调 onRestore 并展示结果', async () => {
    const onRestore = vi.fn(() => Promise.resolve('已恢复 2 个文件，删除 1 个多余文件'))
    render(<LatexHistory pid="p1" canEdit onRestore={onRestore} />)
    await act(async () => {})
    act(() => q<HTMLButtonElement>('[data-testid="latex-history-list"] [role="option"]').click())
    await act(async () => {})
    expect(latexApi.historyDiff).toHaveBeenCalledWith('p1', VERSIONS[0]!.sha)
    expect(q('[data-testid="latex-version-diff"]').textContent).toContain('+new line')
    act(() => q<HTMLButtonElement>('[data-testid="latex-history-restore"]').click())
    await act(async () => {})
    expect(onRestore).toHaveBeenCalledWith(VERSIONS[0]!.sha)
    expect(q('[data-testid="latex-history-result"]').textContent).toContain('已恢复 2 个文件')
    // 恢复后自动刷新列表
    expect(latexApi.history).toHaveBeenCalledTimes(2)
  })

  it('onRestore 返回 null（用户取消）→ 不展示结果，仍刷新列表；抛错展示失败', async () => {
    const onRestore = vi.fn<() => Promise<string | null>>()
    onRestore.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('boom'))
    render(<LatexHistory pid="p1" canEdit onRestore={onRestore} />)
    await act(async () => {})
    act(() => q<HTMLButtonElement>('[data-testid="latex-history-list"] [role="option"]').click())
    await act(async () => {})
    act(() => q<HTMLButtonElement>('[data-testid="latex-history-restore"]').click())
    await act(async () => {})
    expect(host!.querySelector('[data-testid="latex-history-result"]')).toBeNull()
    act(() => q<HTMLButtonElement>('[data-testid="latex-history-restore"]').click())
    await act(async () => {})
    expect(q('[data-testid="latex-history-result"]').textContent).toContain('恢复失败')
  })

  it('只读访问禁用恢复按钮；加载失败展示错误', async () => {
    render(<LatexHistory pid="p1" canEdit={false} onRestore={() => Promise.resolve('x')} />)
    await act(async () => {})
    act(() => q<HTMLButtonElement>('[data-testid="latex-history-list"] [role="option"]').click())
    await act(async () => {})
    expect(q<HTMLButtonElement>('[data-testid="latex-history-restore"]').disabled).toBe(true)
    vi.mocked(latexApi.history).mockRejectedValue(new Error('git 不可用'))
    act(() => q<HTMLButtonElement>('[data-testid="latex-history-refresh"]').click())
    await act(async () => {})
    expect(host!.querySelector('[role="alert"]')!.textContent).toContain('git 不可用')
  })
})

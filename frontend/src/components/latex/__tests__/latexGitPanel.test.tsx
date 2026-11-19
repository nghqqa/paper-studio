// LatexGitPanel 组件测试：未配置表单/已配置状态/推送拉取回调/错误展示（jsdom，API 全 mock）。
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { LatexGitPanel } from '../LatexGitPanel'
import { latexApi } from '@/lib/api/latex'

// @vitest-environment jsdom

vi.mock('@/lib/api/latex', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/api/latex')>()
  return {
    ...mod,
    latexApi: {
      ...mod.latexApi,
      gitStatus: vi.fn(),
      gitSetRemote: vi.fn(),
      gitDeleteRemote: vi.fn(),
      gitPush: vi.fn(),
      gitPull: vi.fn(),
    },
  }
})

const REMOTE_INFO = {
  remote: { url: 'https://github.com/u/paper.git', branch: 'main', has_token: true },
  ahead: 2,
  behind: 0,
  head: 'abc1234abc1234abc1234abc1234abc1234abc1234',
}

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

describe('LatexGitPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(latexApi.gitStatus).mockResolvedValue({ remote: null, ahead: null, behind: null, head: null })
  })

  it('未配置：展示 https/PAT 表单；保存调 gitSetRemote 且清空 token 输入', async () => {
    vi.mocked(latexApi.gitSetRemote).mockResolvedValue({
      ok: true, remote: { url: 'https://github.com/u/paper.git', branch: 'main', has_token: true },
    })
    render(<LatexGitPanel pid="p1" canEdit onPulled={() => {}} />)
    await act(async () => {})
    expect(q('[data-testid="latex-git-setup"]')).not.toBeNull()
    const type = (el: HTMLInputElement, v: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await type(q<HTMLInputElement>('[data-testid="latex-git-url"]'), 'https://github.com/u/paper.git')
    await type(q<HTMLInputElement>('[data-testid="latex-git-token"]'), 'ghs_abc')
    act(() => q<HTMLButtonElement>('[data-testid="latex-git-save"]').click())
    await act(async () => {})
    expect(latexApi.gitSetRemote).toHaveBeenCalledWith('p1', 'https://github.com/u/paper.git', 'main', 'ghs_abc')
    // 保存成功 → 切到已管理视图（token 输入框随之消失）
    expect(q('[data-testid="latex-git-managed"]')).not.toBeNull()
    expect(q('[data-testid="latex-git-msg"]')!.textContent).toContain('已保存')
  })

  it('已配置：显示 masked url/领先落后计数；推送成功展示快照语义', async () => {
    vi.mocked(latexApi.gitStatus).mockResolvedValue(REMOTE_INFO)
    vi.mocked(latexApi.gitPush).mockResolvedValue({ ok: true, sha: 'abc1234abc', committed: true })
    render(<LatexGitPanel pid="p1" canEdit onPulled={() => {}} />)
    await act(async () => {})
    expect(q('[data-testid="latex-git-managed"]')).not.toBeNull()
    expect(q('[data-testid="latex-git-counts"]')!.textContent).toContain('领先 2')
    act(() => q<HTMLButtonElement>('[data-testid="latex-git-push"]').click())
    await act(async () => {})
    expect(latexApi.gitPush).toHaveBeenCalledWith('p1', false)
    expect(q('[data-testid="latex-git-msg"]')!.textContent).toContain('自动快照')
  })

  it('拉取更新工作区 → onPulled 回调；分叉拒绝 → confirm 后强制拉取（放弃本地提交）', async () => {
    vi.mocked(latexApi.gitStatus).mockResolvedValue(REMOTE_INFO)
    vi.mocked(latexApi.gitPull)
      .mockResolvedValueOnce({ ok: true, changed: true, ahead: 0, behind: 0 })
      .mockRejectedValueOnce(new Error('本地与远端各有修改（本地多 1 个提交、远端多 2 个）——自动合并已拒绝。'))
      .mockResolvedValueOnce({ ok: true, changed: true, ahead: 0, behind: 0, forced: true })
    const onPulled = vi.fn()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<LatexGitPanel pid="p1" canEdit onPulled={onPulled} />)
    await act(async () => {})
    act(() => q<HTMLButtonElement>('[data-testid="latex-git-pull"]').click())
    await act(async () => {})
    expect(onPulled).toHaveBeenCalledTimes(1)
    // 分叉：确认后以 force 重拉
    act(() => q<HTMLButtonElement>('[data-testid="latex-git-pull"]').click())
    await act(async () => {})
    expect(confirmSpy).toHaveBeenCalled()
    expect(latexApi.gitPull).toHaveBeenNthCalledWith(3, 'p1', true)
    expect(onPulled).toHaveBeenCalledTimes(2)
    expect(q('[data-testid="latex-git-msg"]')!.textContent).toContain('已强制拉取')
    // confirm 取消 → 不强拉，仅展示后端 409 文案
    confirmSpy.mockReturnValue(false)
    vi.mocked(latexApi.gitPull).mockRejectedValueOnce(new Error('本地与远端各有修改——自动合并已拒绝。'))
    act(() => q<HTMLButtonElement>('[data-testid="latex-git-pull"]').click())
    await act(async () => {})
    expect(latexApi.gitPull).toHaveBeenCalledTimes(4) // 未再以 force 重试
    expect(q('[data-testid="latex-git-msg"]')!.textContent).toContain('已保留本地版本')
  })

  it('只读访问禁用全部操作；解除关联调 delete', async () => {
    vi.mocked(latexApi.gitStatus).mockResolvedValue(REMOTE_INFO)
    vi.mocked(latexApi.gitDeleteRemote).mockResolvedValue({ ok: true, removed: true })
    render(<LatexGitPanel pid="p1" canEdit={false} onPulled={() => {}} />)
    await act(async () => {})
    expect(q<HTMLButtonElement>('[data-testid="latex-git-push"]').disabled).toBe(true)
    expect(q<HTMLButtonElement>('[data-testid="latex-git-pull"]').disabled).toBe(true)
    expect(q<HTMLButtonElement>('[data-testid="latex-git-remove"]').disabled).toBe(true)
  })
})

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ProposalPanel } from '@/components/paper/ProposalPanel'
import type { PaperProposal } from '@/lib/api/paperProposals'
import type { ApplyOutcome, AnchorLike } from '@/components/paper/proposalApply'

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
})

const BASE: PaperProposal = {
  proposal_id: 'pp_aaaaaaaaaaaa',
  mode: 'latex',
  action: 'polish',
  instruction: null,
  anchor: {
    file: 'main.tex',
    base_sha: '0'.repeat(64),
    offset: null,
    context_before: '前文。',
    context_after: '后文。',
    original_text: '这句需要润色。',
  },
  suggested_text: '这句已经润色。',
  rationale: '更流畅',
  model: 'm1',
  created_by: 'a@x',
  created_at: 1760000000,
  updated_at: 1760000000,
  status: 'pending',
  protection_flags: [],
  error: null,
  applied_at: null,
  applied_text: null,
  applied_by: null,
}

function mockListOnce(proposals: PaperProposal[]) {
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
    const u = String(url)
    if (u.includes('/paper-proposals') && !u.includes('/status')) {
      return new Response(JSON.stringify({ proposals }), { status: 200 })
    }
    return new Response(JSON.stringify({ proposal: proposals[0] }), { status: 200 })
  }))
}

const OK: ApplyOutcome = { ok: true, reason: 'unique' }

function baseProps(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    pid: 'p1',
    canEdit: true,
    activePath: 'main.tex',
    dirty: false,
    saving: false,
    getSelection: () => null,
    applyProposal: vi.fn((_a: AnchorLike, _s: string) => OK),
    revertProposal: vi.fn(() => OK),
    locateProposal: vi.fn(),
    ...overrides,
  } as unknown as React.ComponentProps<typeof ProposalPanel>
}

describe('ProposalPanel', () => {
  it('空列表：显示引导文案', async () => {
    mockListOnce([])
    render(<ProposalPanel {...baseProps()} />)
    await act(async () => { await Promise.resolve() })
    expect(document.querySelector('[data-testid="proposal-list"]')!.textContent).toContain('暂无提案')
  })

  async function expandCard() {
    await act(async () => {
      ;(document.querySelector('button[aria-label="展开差异"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })
  }

  it('待审阅卡：展示 diff、采纳走编辑器事务回调 + 状态上报', async () => {
    mockListOnce([BASE])
    const applyProposal = vi.fn((_a: AnchorLike, _s: string) => OK)
    const fetchMock = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
      const u = String(url)
      if (u.includes('/status')) return new Response(JSON.stringify({ proposal: { ...BASE, status: 'applied' } }), { status: 200 })
      return new Response(JSON.stringify({ proposals: [BASE] }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<ProposalPanel {...baseProps({ applyProposal })} />)
    await act(async () => { await Promise.resolve() })
    const card = document.querySelector('[data-testid="proposal-pp_aaaaaaaaaaaa"]')!
    expect(card.textContent).toContain('这句需要润色。')
    await expandCard()
    const diff = document.querySelector('[data-testid="proposal-diff-pp_aaaaaaaaaaaa"]')!.textContent!
    expect(diff).toContain('这句')
    expect(diff).toContain('已经润色')
    // 采纳
    await act(async () => {
      ;(document.querySelector('[data-testid="proposal-apply-pp_aaaaaaaaaaaa"]') as HTMLButtonElement).click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(applyProposal).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/status'), expect.objectContaining({ method: 'POST' }))
  })

  it('保护标记：未勾选确认时采纳按钮禁用', async () => {
    const flagged = { ...BASE, protection_flags: ['numbers', 'citations'] }
    mockListOnce([flagged])
    render(<ProposalPanel {...baseProps()} />)
    await act(async () => { await Promise.resolve() })
    await expandCard()
    const btn = document.querySelector('[data-testid="proposal-apply-pp_aaaaaaaaaaaa"]') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    await act(async () => {
      ;(document.querySelector('[data-testid="proposal-ack-pp_aaaaaaaaaaaa"]') as HTMLInputElement).click()
      await Promise.resolve()
    })
    expect((document.querySelector('[data-testid="proposal-apply-pp_aaaaaaaaaaaa"]') as HTMLButtonElement).disabled).toBe(false)
  })

  it('采纳失败（原文变化）：不上报 applied，提示重定位', async () => {
    mockListOnce([BASE])
    const applyProposal = vi.fn(() => ({ ok: false, reason: 'not_found' as const }))
    const fetchMock = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
      const u = String(url)
      if (u.includes('/status')) return new Response(JSON.stringify({ proposal: BASE }), { status: 200 })
      return new Response(JSON.stringify({ proposals: [BASE] }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<ProposalPanel {...baseProps({ applyProposal })} />)
    await act(async () => { await Promise.resolve() })
    await expandCard()
    await act(async () => {
      ;(document.querySelector('[data-testid="proposal-apply-pp_aaaaaaaaaaaa"]') as HTMLButtonElement).click()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(applyProposal).toHaveBeenCalledTimes(1)
    // 上报的是 stale，不是 applied
    const statusCall = fetchMock.mock.calls.find((c: unknown[]) => String(c[0]).includes('/status'))
    expect(String(statusCall?.[0])).toContain('/status')
    expect(JSON.parse((statusCall?.[1] as unknown as RequestInit).body as string).status).toBe('stale')
    expect(document.querySelector('[data-testid="proposal-notice"]')!.textContent).toContain('原文已变化')
  })

  it('只读账号：不渲染采纳/拒绝按钮', async () => {
    mockListOnce([BASE])
    render(<ProposalPanel {...baseProps({ canEdit: false })} />)
    await act(async () => { await Promise.resolve() })
    expect(document.querySelector('[data-testid="proposal-apply-pp_aaaaaaaaaaaa"]')).toBeNull()
    expect(document.querySelector('[data-testid="proposal-reject-pp_aaaaaaaaaaaa"]')).toBeNull()
  })

  it('已处理记录里 applied 提案有撤销按钮', async () => {
    mockListOnce([{ ...BASE, status: 'applied', applied_at: 1760000100, applied_text: '这句已经润色。' }])
    render(<ProposalPanel {...baseProps()} />)
    await act(async () => { await Promise.resolve() })
    expect(document.querySelector('[data-testid="proposal-undo-pp_aaaaaaaaaaaa"]')).not.toBeNull()
  })

  // ---- 修复验证闭环（v0.5） ----

  const FIX_PROP: PaperProposal = {
    ...BASE,
    action: 'custom',
    original: undefined,
    error_context: { file: 'main.tex', line: 12, message: 'Undefined control sequence' },
    linked_issue_id: 'issue01',
  } as unknown as PaperProposal

  const VER_OK = {
    at: 1760000200, build_id: 'b-ok-123', build_status: 'ok',
    before: [{ file: 'main.tex', line: 12, message: 'Undefined control sequence' }],
    after: [], resolved: true, issue_resolved: true,
  }

  it('修复类提案采纳后自动重编译验证并提示结果', async () => {
    const applied = { ...FIX_PROP, status: 'applied' as const, applied_at: 1760000100, verifications: [VER_OK] }
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url)
      if (u.includes('/status')) return new Response(JSON.stringify({ proposal: { ...FIX_PROP, status: 'applied' } }), { status: 200 })
      return new Response(JSON.stringify({ proposals: u.includes('/x') ? [applied] : [FIX_PROP] }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const verifyFix = vi.fn(async () => VER_OK)
    render(<ProposalPanel {...baseProps({ verifyFix })} />)
    await act(async () => { await Promise.resolve() })
    await expandCard()
    await act(async () => {
      ;(document.querySelector('[data-testid="proposal-apply-pp_aaaaaaaaaaaa"]') as HTMLButtonElement).click()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    // 采纳后链式调用了验证
    expect(verifyFix).toHaveBeenCalledTimes(1)
    expect(verifyFix).toHaveBeenCalledWith('pp_aaaaaaaaaaaa')
    expect(document.querySelector('[data-testid="proposal-notice"]')!.textContent).toContain('目标编译错误已消失')
  })

  it('已处理记录：修复验证历史可回看 + 再次验证按钮', async () => {
    const applied = { ...FIX_PROP, status: 'applied' as const, applied_at: 1760000100, verifications: [VER_OK] }
    mockListOnce([applied])
    const verifyFix = vi.fn(async () => ({ ...VER_OK, at: 1760000300 }))
    render(<ProposalPanel {...baseProps({ verifyFix })} />)
    await act(async () => { await Promise.resolve() })
    const verifyBox = document.querySelector('[data-testid="proposal-verify-pp_aaaaaaaaaaaa"]')!
    expect(verifyBox.textContent).toContain('错误已消失')
    expect(verifyBox.textContent).toContain('Issue 已解决')
    await act(async () => {
      ;(document.querySelector('[data-testid="proposal-reverify-pp_aaaaaaaaaaaa"]') as HTMLButtonElement).click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(verifyFix).toHaveBeenCalledTimes(1)
  })

  it('非修复类提案采纳不触发自动验证', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url)
      if (u.includes('/status')) return new Response(JSON.stringify({ proposal: { ...BASE, status: 'applied' } }), { status: 200 })
      return new Response(JSON.stringify({ proposals: [BASE] }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const verifyFix = vi.fn(async () => VER_OK)
    render(<ProposalPanel {...baseProps({ verifyFix })} />)
    await act(async () => { await Promise.resolve() })
    await expandCard()
    await act(async () => {
      ;(document.querySelector('[data-testid="proposal-apply-pp_aaaaaaaaaaaa"]') as HTMLButtonElement).click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(verifyFix).not.toHaveBeenCalled()
  })

  it('mode 切换后生成提案携带最新 mode（防 useCallback 闭包陈旧）', async () => {
    const sel = { text: '需要润色的句子。', doc: '前文。需要润色的句子。后文。', from: 3, to: 11 }
    const getSelection = () => sel
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ proposal: { ...BASE, mode: 'word' } }), { status: 200 })
      }
      return new Response(JSON.stringify({ proposals: [] }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<ProposalPanel {...baseProps({ mode: 'latex', getSelection })} />)
    await act(async () => { await Promise.resolve() })
    // 同一挂载实例仅切换 mode -> word（pid / activePath / getSelection 引用均不变）
    act(() => root!.render(<ProposalPanel {...baseProps({ mode: 'word', getSelection })} />))
    await act(async () => {
      ;(document.querySelector('[data-testid="assistant-card-polish"]') as HTMLButtonElement).click()
      await Promise.resolve()
      await Promise.resolve()
    })
    const genCall = fetchMock.mock.calls.find((c: unknown[]) => (c[1] as RequestInit | undefined)?.method === 'POST')
    expect(genCall).toBeDefined()
    const payload = JSON.parse(String((genCall![1] as RequestInit).body))
    expect(payload.mode).toBe('word')
  })
})

// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api/net'
import { wordApi, type WordPreflightGet, type WordPreflightReport } from '@/lib/api/word'
import { WordPreflightPanel } from '../WordPreflightPanel'

vi.mock('@/lib/api/word', () => ({
  wordApi: { runPreflight: vi.fn(), getPreflight: vi.fn() },
}))

let root: Root | null = null
let host: HTMLElement

beforeAll(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true })
beforeEach(() => { vi.resetAllMocks() })
afterEach(async () => { await act(async () => root?.unmount()); root = null })

function mount(props: { pid?: string; canEdit?: boolean; saving?: boolean; stateSha?: string | null } = {}) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(
    <WordPreflightPanel
      pid={props.pid ?? 'p'}
      canEdit={props.canEdit ?? true}
      saving={props.saving ?? false}
      stateSha={props.stateSha ?? null}
    />))
  return host
}

const SHA1 = 'a'.repeat(64)
const SHA2 = 'b'.repeat(64)

function report(overrides: Partial<WordPreflightReport> = {}): WordPreflightReport {
  return {
    schema: 'paper-studio/word-preflight@1',
    project_id: 'p',
    version: 3,
    sha256: SHA1,
    ruleset_id: 'jcip-preflight',
    ruleset_version: '1',
    generated_at: '2026-10-30T12:00:00Z',
    items: [
      { rule_id: 'jcip-abstract-cn', status: 'pass', evidence: '找到摘要段', source: 'jcip 模板' },
      { rule_id: 'jcip-abstract-en', status: 'warn', evidence: '未找到英文摘要（Abstract）段落', source: 'jcip 模板' },
      { rule_id: 'jcip-citation-integrity', status: 'unknown', evidence: '未配置屏蔽词', source: 'jcip 模板' },
    ],
    ...overrides,
  }
}

function getBody(overrides: Partial<WordPreflightGet> = {}): WordPreflightGet {
  return { report: report(), expired: false, current: { version: 3, sha256: SHA1 }, ...overrides }
}

async function flush(times = 3) {
  for (let i = 0; i < times; i++) await act(async () => { await Promise.resolve() })
}

describe('Word 投稿前检查面板', () => {
  it('404 → 显示尚未运行，不显示报告', async () => {
    vi.mocked(wordApi.getPreflight).mockRejectedValue(
      new ApiError(404, '尚未运行投稿前检查', { kind: 'not_found', message: '尚未运行投稿前检查', line: null, detail: null }))
    const h = mount()
    await flush()
    expect(wordApi.getPreflight).toHaveBeenCalledWith('p', 'jcip-preflight')
    expect(h.querySelector('[data-testid="word-preflight-notrun"]')).toBeTruthy()
    expect(h.querySelector('[data-testid="word-preflight-items"]')).toBeNull()
  })

  it('报告渲染状态徽章/证据/依据；未过期时无横幅', async () => {
    vi.mocked(wordApi.getPreflight).mockResolvedValue(getBody())
    const h = mount()
    await flush()
    const items = h.querySelectorAll('[data-testid="word-preflight-items"] > li')
    expect(items.length).toBe(3)
    expect(h.textContent).toContain('通过')
    expect(h.textContent).toContain('告警')
    expect(h.textContent).toContain('无法判断')
    expect(h.textContent).toContain('jcip-preflight/1')
    expect(h.querySelector('[data-testid="word-preflight-expired"]')).toBeNull()
  })

  it('规则集下拉渲染三个选项；切换后 GET 携带对应 ruleset', async () => {
    vi.mocked(wordApi.getPreflight).mockRejectedValue(
      new ApiError(404, '尚未运行投稿前检查', { kind: 'not_found', message: '尚未运行投稿前检查', line: null, detail: null }))
    const h = mount()
    await flush()
    const sel = h.querySelector<HTMLSelectElement>('[data-testid="word-preflight-ruleset"]')!
    expect(sel).toBeTruthy()
    expect(sel.options.length).toBe(3)
    expect(sel.options[0].textContent).toContain('中文信息学报')
    expect(sel.options[1].textContent).toContain('通用中文论文')
    expect(sel.options[2].textContent).toContain('双盲')
    await act(async () => {
      sel.value = 'cn-general'
      sel.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flush()
    expect(wordApi.getPreflight).toHaveBeenCalledWith('p', 'cn-general')
    await act(async () => {
      sel.value = 'double-blind'
      sel.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flush()
    expect(wordApi.getPreflight).toHaveBeenCalledWith('p', 'double-blind')
  })

  it('expired=true → 醒目提示旧快照报告', async () => {
    vi.mocked(wordApi.getPreflight).mockResolvedValue(getBody({ expired: true }))
    const h = mount()
    await flush()
    expect(h.querySelector('[data-testid="word-preflight-expired"]')).toBeTruthy()
  })

  it('运行检查 → POST 携带当前 ruleset，并按响应 expired 如实设置', async () => {
    vi.mocked(wordApi.getPreflight).mockResolvedValue(getBody())
    vi.mocked(wordApi.runPreflight).mockResolvedValue({
      report: report({ version: 4, sha256: SHA2 }),
      expired: true,  // 后端写报告时核对发现快照已推进——如实过期
      superseded: false,
      current: { version: 4, sha256: SHA2 },
    })
    const h = mount()
    await flush()
    const btn = h.querySelector<HTMLButtonElement>('[data-testid="word-preflight-run"]')!
    await act(async () => btn.click())
    await flush()
    expect(wordApi.runPreflight).toHaveBeenCalledWith('p', { ruleset: 'jcip-preflight' })
    expect(h.querySelector('[data-testid="word-preflight-expired"]')).toBeTruthy()
    expect(h.textContent).toContain('v4')
  })

  it('切到双盲规则集后运行 → POST 携带 double-blind', async () => {
    vi.mocked(wordApi.getPreflight).mockRejectedValue(
      new ApiError(404, '尚未运行投稿前检查', { kind: 'not_found', message: '尚未运行投稿前检查', line: null, detail: null }))
    vi.mocked(wordApi.runPreflight).mockResolvedValue({
      report: report({ ruleset_id: 'double-blind' }),
      expired: false, superseded: false,
      current: { version: 3, sha256: SHA1 },
    })
    const h = mount()
    await flush()
    const sel = h.querySelector<HTMLSelectElement>('[data-testid="word-preflight-ruleset"]')!
    await act(async () => {
      sel.value = 'double-blind'
      sel.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flush()
    const btn = h.querySelector<HTMLButtonElement>('[data-testid="word-preflight-run"]')!
    await act(async () => btn.click())
    await flush()
    expect(wordApi.runPreflight).toHaveBeenCalledWith('p', { ruleset: 'double-blind' })
    expect(h.textContent).toContain('double-blind/1')
  })

  it('stateSha 变化（保存完成）→ 立即标记过期并重新拉取', async () => {
    vi.mocked(wordApi.getPreflight).mockResolvedValueOnce(getBody())
    vi.mocked(wordApi.getPreflight).mockResolvedValue(getBody({ expired: true }))  // 保存后服务端同样判定过期
    const h = mount({ stateSha: SHA1 })
    await flush()
    expect(h.querySelector('[data-testid="word-preflight-expired"]')).toBeNull()
    await act(async () => root!.render(
      <WordPreflightPanel pid="p" canEdit saving={false} stateSha={SHA2} />))
    await flush(4)
    expect(h.querySelector('[data-testid="word-preflight-expired"]')).toBeTruthy()
    expect(vi.mocked(wordApi.getPreflight).mock.calls.length).toBeGreaterThanOrEqual(2)  // 自动刷新过
  })

  it('迟到的 GET 响应不覆盖新 POST 的报告（乱序防护）', async () => {
    let resolveGet!: (v: WordPreflightGet) => void
    vi.mocked(wordApi.getPreflight).mockImplementationOnce(
      () => new Promise<WordPreflightGet>((res) => { resolveGet = res }))
    vi.mocked(wordApi.runPreflight).mockResolvedValue({
      report: report({ version: 4, sha256: SHA2 }),
      expired: false, superseded: false,
      current: { version: 4, sha256: SHA2 },
    })
    const h = mount()
    await flush(2)  // 首个 GET 挂起（未 resolve）
    const btn = h.querySelector<HTMLButtonElement>('[data-testid="word-preflight-run"]')!
    await act(async () => btn.click())
    await flush()
    expect(h.querySelector('[data-testid="word-preflight-expired"]')).toBeNull()
    // 迟到的初始 GET 此刻才 resolve（携带旧数据）——必须被忽略
    await act(async () => resolveGet(getBody({ expired: true })))
    await flush()
    expect(h.querySelector('[data-testid="word-preflight-expired"]')).toBeNull()
    expect(h.textContent).toContain('v4')
  })

  it('保存中：按钮禁用并提示先完成保存', async () => {
    const h = mount({ saving: true })
    await flush(2)
    const btn = h.querySelector<HTMLButtonElement>('[data-testid="word-preflight-run"]')!
    expect(btn.disabled).toBe(true)
    expect(h.querySelector('[data-testid="word-preflight-saving"]')).toBeTruthy()
  })
})

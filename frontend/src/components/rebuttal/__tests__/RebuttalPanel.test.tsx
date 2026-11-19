// @vitest-environment jsdom
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api/net'
import { rebuttalApi, type RebuttalItem, type RebuttalState } from '@/lib/api/rebuttal'
import type { Settings } from '@/lib/types'
import { downloadFile } from '@/lib/download'
import { wordApi } from '@/lib/api/word'
import { useStudio } from '@/store'
import { RebuttalPanel } from '../RebuttalPanel'

/**
 * RebuttalPanel UI 合约（P1-1）：拆条导入（replace/append）、AI 未开启禁用+提示（不假装可用）、
 * AI 草稿展示与「采纳 → 手动保存」链路、状态切换落盘、关联当前光标/跳转、
 * 导出成功与业务错误（409）清晰展示不静默吞错。
 */

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

vi.mock('@/lib/api/rebuttal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/rebuttal')>()
  return {
    ...actual,
    rebuttalApi: {
      ...actual.rebuttalApi,
      load: vi.fn(),
      parse: vi.fn(),
      parseFile: vi.fn(),
      updateItem: vi.fn(),
      draft: vi.fn(),
    },
  }
})

vi.mock('@/lib/download', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/download')>()
  return { ...actual, downloadFile: vi.fn().mockResolvedValue('response-letter.md') }
})

const item = (over: Partial<RebuttalItem> = {}): RebuttalItem => ({
  id: 'rb-1',
  reviewer: 'Reviewer 1',
  category: 'major',
  text: 'The motivation is weak.',
  status: 'todo',
  location: null,
  response: '',
  edits_summary: '',
  ai_draft: null,
  updated_at: null,
  round: 1,
  ...over,
})

const SETTINGS: Settings = { abstract_figure: null, spec_figures: [], sub_except: [], abstract_limit: 300, style: {}, ai_enabled: true }

const stateOf = (items: RebuttalState['items']): RebuttalState => ({
  updated_at: null,
  round: 1,
  items,
  warnings: [],
})

let host: HTMLElement | null = null
let root: Root | null = null

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  Element.prototype.scrollIntoView ??= () => {}
})

const mockState = (st: RebuttalState) => {
  vi.mocked(rebuttalApi.load).mockResolvedValue(st)
}

async function mount(el: ReactElement) {
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  await act(async () => root!.render(el))
  await act(async () => {
    await Promise.resolve()
  })
}

const q = (sel: string) => host?.querySelector(sel)
const btn = (testid: string) => q(`[data-testid="${testid}"]`) as HTMLButtonElement | null
const inputOf = (testid: string) => q(`[data-testid="${testid}"]`) as HTMLInputElement | null

function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  // React 18 受控输入：直接赋值 + input 事件会被 value tracker 去重吞掉，须走原生 value setter
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set
  setter!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

const openItem = async () => {
  await act(async () => {
    btn('rebuttal-item-rb-1')!.click()
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(downloadFile).mockResolvedValue('response-letter.md')
  useStudio.setState({ pid: 'p1', settings: SETTINGS, authStatus: 'off' })
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  host?.remove()
  host = null
  vi.restoreAllMocks()
})

describe('RebuttalPanel', () => {
  it('加载后渲染进度与条目列表，点击条目进入详情', async () => {
    mockState(stateOf([item({ id: 'rb-1', status: 'addressed' }), item({ id: 'rb-2', reviewer: 'Reviewer 2' })]))
    await mount(
      <RebuttalPanel pid="p1" canEdit activeFile="main.tex" cursorLine={3} onJump={() => {}} />,
    )
    expect(q('[data-testid="rebuttal-progress"]')?.textContent).toContain('已修改 1 / 总 2 条')
    expect(btn('rebuttal-item-rb-1')).toBeTruthy()
    await openItem()
    expect(q('[data-testid="rebuttal-detail"]')).toBeTruthy()
    expect(q('[data-testid="rebuttal-response-input"]')).toBeTruthy()
  })

  it('AI 未开启时按钮禁用并明确提示，不假装可用', async () => {
    useStudio.setState({ settings: { ...SETTINGS, ai_enabled: false } })
    mockState(stateOf([item()]))
    await mount(<RebuttalPanel pid="p1" canEdit activeFile={null} cursorLine={null} onJump={() => {}} />)
    await openItem()
    const ai = btn('rebuttal-ai-draft')!
    expect(ai.disabled).toBe(true)
    expect(q('[data-testid="rebuttal-ai-area"]')?.textContent).toContain('AI 未开启')
    expect(btn('rebuttal-adopt-ai')).toBeNull()
  })

  it('AI 起草只写草稿建议，采纳后填入回复框，保存才落盘', async () => {
    mockState(stateOf([item()]))
    const drafted = item({ ai_draft: { response_draft: 'We thank R1.', edits_summary_draft: 'Added Y.', created_at: '2026-11-17T00:00:00Z' } })
    await mount(<RebuttalPanel pid="p1" canEdit activeFile={null} cursorLine={null} onJump={() => {}} />)
    await openItem()
    vi.mocked(rebuttalApi.draft).mockResolvedValueOnce({ item: drafted, warnings: [] })
    await act(async () => {
      btn('rebuttal-ai-draft')!.click()
      await Promise.resolve()
    })
    expect(vi.mocked(rebuttalApi.draft)).toHaveBeenCalledWith('p1', 'rb-1')
    expect(q('[data-testid="rebuttal-ai-preview"]')?.textContent).toContain('We thank R1.')
    await act(async () => {
      btn('rebuttal-adopt-ai')!.click()
      await Promise.resolve()
    })
    const resp = inputOf('rebuttal-response-input') as unknown as HTMLTextAreaElement
    expect(resp.value).toBe('We thank R1.')
    expect(inputOf('rebuttal-edits-input')!.value).toBe('Added Y.')
    vi.mocked(rebuttalApi.updateItem).mockResolvedValueOnce(drafted)
    await act(async () => {
      btn('rebuttal-save')!.click()
      await Promise.resolve()
    })
    expect(vi.mocked(rebuttalApi.updateItem)).toHaveBeenCalledWith('p1', 'rb-1', {
      status: 'todo',
      response: 'We thank R1.',
      edits_summary: 'Added Y.',
      location: {},
    })
  })

  it('状态 pill 点击直接落盘且不清空未保存回复草稿', async () => {
    mockState(stateOf([item()]))
    await mount(<RebuttalPanel pid="p1" canEdit activeFile={null} cursorLine={null} onJump={() => {}} />)
    await openItem()
    const resp = inputOf('rebuttal-response-input') as unknown as HTMLTextAreaElement
    type(resp, '手写未保存草稿')
    vi.mocked(rebuttalApi.updateItem).mockResolvedValueOnce(
      item({ status: 'addressed', updated_at: '2026-11-17T01:00:00Z' }),
    )
    await act(async () => {
      btn('rebuttal-status-addressed')!.click()
      await Promise.resolve()
    })
    expect(vi.mocked(rebuttalApi.updateItem)).toHaveBeenCalledWith('p1', 'rb-1', { status: 'addressed' })
    expect(resp.value).toBe('手写未保存草稿')
  })

  it('关联当前光标位置回填 file/line，已有定位可一键跳转', async () => {
    mockState(stateOf([item()]))
    let jumped: string[] = []
    await mount(
      <RebuttalPanel
        pid="p1"
        canEdit
        activeFile="main.tex"
        cursorLine={7}
        onJump={(f, l) => {
          jumped = [f, String(l)]
        }}
      />,
    )
    await openItem()
    await act(async () => {
      btn('rebuttal-link-cursor')!.click()
      await Promise.resolve()
    })
    expect(inputOf('rebuttal-loc-file')!.value).toBe('main.tex')
    expect(inputOf('rebuttal-loc-line')!.value).toBe('7')
    await act(async () => {
      btn('rebuttal-jump')!.click()
    })
    expect(jumped).toEqual(['main.tex', '7'])
  })

  it('粘贴导入按所选模式调用 parse，warnings 以提示展示', async () => {
    mockState(stateOf([]))
    await mount(<RebuttalPanel pid="p1" canEdit activeFile={null} cursorLine={null} onJump={() => {}} />)
    type(inputOf('rebuttal-import-text') as unknown as HTMLTextAreaElement, 'Reviewer #1\n1. point')
    vi.mocked(rebuttalApi.parse).mockResolvedValueOnce({
      round: 1,
      items: [item()],
      warnings: ['whole text as one item'],
    })
    await act(async () => {
      btn('rebuttal-import-submit')!.click()
      await Promise.resolve()
    })
    expect(vi.mocked(rebuttalApi.parse)).toHaveBeenCalledWith('p1', 'Reviewer #1\n1. point', 'replace')
    expect(q('[data-testid="rebuttal-notice"]')?.textContent).toContain('whole text as one item')
  })

  it('导出成功走 downloadFile，业务失败（409）在横幅清晰展示', async () => {
    mockState(stateOf([item({ status: 'addressed', response: 'done' })]))
    await mount(<RebuttalPanel pid="p1" canEdit activeFile={null} cursorLine={null} onJump={() => {}} />)
    await act(async () => {
      btn('rebuttal-export-md')!.click()
      await Promise.resolve()
    })
    expect(vi.mocked(downloadFile)).toHaveBeenCalledWith(
      '/api/projects/p1/rebuttal/export?format=md',
      'response-letter.md',
    )
    vi.mocked(downloadFile).mockRejectedValueOnce(new ApiError(409, 'nothing to export yet'))
    await act(async () => {
      btn('rebuttal-export-docx')!.click()
      await Promise.resolve()
    })
    expect(q('[data-testid="rebuttal-error"]')?.textContent).toContain('nothing to export yet')
  })
})

describe('B3 多轮归档与 Word 模式锚点', () => {
  it('历史轮切换为只读视图，返回当前轮恢复编辑', async () => {
    vi.spyOn(rebuttalApi, 'rounds').mockResolvedValue({
      rounds: [{ round: 1, items: 1, archived_at: '2026-11-17T00:00:00Z' }],
    })
    vi.spyOn(rebuttalApi, 'round').mockResolvedValue({
      round: 1,
      archived_at: '2026-11-17T00:00:00Z',
      items: [{ ...item({ id: 'rb-9', text: '第一轮的旧意见。', response: '第一轮回复。' }) }],
    })
    mockState(stateOf([item()]))
    await mount(<RebuttalPanel pid="p1" canEdit activeFile={null} cursorLine={null} onJump={() => {}} />)
    await act(async () => {
      btn('rebuttal-round-1')!.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(q('[data-testid="rebuttal-round-readonly"]')).not.toBeNull()
    expect(host!.textContent).toContain('第一轮的旧意见。')
    expect(host!.textContent).toContain('只读')
    await act(async () => {
      btn('rebuttal-round-current')!.click()
      await Promise.resolve()
    })
    expect(q('[data-testid="rebuttal-round-readonly"]')).toBeNull()
    expect(btn('rebuttal-item-rb-1')).not.toBeNull()
  })

  it('Word 模式：不调 /comments，锚点器挂 Word 版本快照', async () => {
    const commentsSpy = vi.fn().mockResolvedValue([])
    vi.doMock('@/lib/api/comments', () => ({ commentsApi: { comments: commentsSpy } }))
    mockState(stateOf([item()]))
    await mount(<RebuttalPanel pid="p1" canEdit activeFile={null} cursorLine={null} onJump={() => {}} mode="word" />)
    await openItem()
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    const picker = q('[data-testid="rebuttal-anchors"]')
    expect(picker).not.toBeNull()
    expect(picker!.textContent).toContain('Word 版本快照')
    expect(picker!.textContent).not.toContain('关联批注')
    expect(commentsSpy).not.toHaveBeenCalled()
    vi.doUnmock('@/lib/api/comments')
  })
})

describe('B3 修补：Word 快照提交完整 sha', () => {
  it('选中 WordVersion 时 snapshot 携带完整 sha（≥12 hex）与正确 vid', async () => {
    const fullSha = 'f'.repeat(64)
    vi.spyOn(wordApi, 'state').mockResolvedValue({
      versions: [{ id: 'v000042-abcdef123456', sha: fullSha, created_at: '2026-11-17T00:00:00Z', source: 'save' }],
    } as never) // 组件只读 versions 字段
    vi.mocked(rebuttalApi.updateItem).mockResolvedValue(item())
    mockState(stateOf([item()]))
    await mount(<RebuttalPanel pid="p1" canEdit activeFile={null} cursorLine={null} onJump={() => {}} mode="word" />)
    await openItem()
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    const select = q('[data-testid="rebuttal-anchor-snapshot"]') as HTMLSelectElement
    expect(select).not.toBeNull()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
      setter.call(select, 'v000042-abcdef123456')
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(vi.mocked(rebuttalApi.updateItem)).toHaveBeenCalledWith('p1', 'rb-1', {
      snapshot: { type: 'word-version', sha: fullSha, vid: 'v000042-abcdef123456' },
    })
    const arg = vi.mocked(rebuttalApi.updateItem).mock.calls.at(-1)![2] as { snapshot?: { sha: string } }
    expect(arg.snapshot?.sha).toMatch(/^[0-9a-f]{12,64}$/)
  })
})

// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { libraryApi } from '@/lib/api/library'
import { bridgeAlive, runRefsTaskAuto } from '@/lib/api/refsPlugin'
import { WordSidePanels } from '../WordSidePanels'

vi.mock('@/lib/api/library', () => ({
  libraryApi: {
    registerCitations: vi.fn(),
    bibliography: vi.fn(),
  },
}))

vi.mock('@/lib/api/refsPlugin', () => ({
  runRefsTaskAuto: vi.fn(),
  bridgeAlive: vi.fn(),
  refreshDocKey: vi.fn(),
}))

// LibraryPanel 桩：透出回调与样式 prop，供点击触发（面板本体行为由其自身测试覆盖）
vi.mock('@/components/latex/LibraryPanel', () => {
  const FIXTURE = [
    { reference_id: 'rid-1', citation_key: 'a2026', title: '甲' },
    { reference_id: 'rid-2', citation_key: 'b2026', title: '乙' },
    { reference_id: 'rid-3', citation_key: 'c2026', title: '丙' },
  ]
  return {
    LibraryPanel: (props: Record<string, unknown>) => (
      <div data-testid="library-panel-stub" data-style={String(props.citationStyle)}>
        <span data-testid="stub-strip-present">{props.onStripBibMarkers ? 'yes' : 'no'}</span>
        <button
          data-testid="stub-insert"
          onClick={() => (props.onInsertCitations as (e: unknown[]) => void)(FIXTURE.slice(0, 2))}
        />
        <button data-testid="stub-update" onClick={() => (props.onUpdateBibliography as () => void)()} />
        <button data-testid="stub-strip" onClick={() => (props.onStripBibMarkers as () => void)()} />
        <button data-testid="stub-style-ieee" onClick={() => (props.onCitationStyleChange as (s: string) => void)('ieee')} />
      </div>
    ),
  }
})

vi.mock('@/components/latex/ProposalPanel', () => ({ ProposalPanel: () => null }))
vi.mock('@/components/word/WordPreflightPanel', () => ({ WordPreflightPanel: () => null }))

let root: Root | null = null
let host: HTMLElement

beforeAll(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true })
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(bridgeAlive).mockResolvedValue(true)
  host = document.createElement('div')
  document.body.appendChild(host)
})
afterEach(async () => { await act(async () => root?.unmount()); root = null; host?.remove() })

function mount() {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(
    <WordSidePanels
      pid="p"
      docKey="doc-key-1"
      canEdit
      saving={false}
      stateSha={null}
      stateVersion={null}
      open="library"
      onClose={() => {}}
    />))
  return host
}

async function flush(times = 4) {
  for (let i = 0; i < times; i++) await act(async () => { await Promise.resolve() })
}

async function click(testId: string) {
  await act(async () => {
    host.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click()
  })
  await flush()
}

const ORDER3 = { order: ['rid-1', 'rid-2', 'rid-3'], changed: false }

describe('WordSidePanels 文献面板（P1-0-A）', () => {
  it('插入引用：默认传 gb-t-7714-2015 样式，上标合并 [1],[2] → [1,2]', async () => {
    vi.mocked(libraryApi.registerCitations).mockResolvedValue({ order: ['rid-1', 'rid-2'], changed: true })
    vi.mocked(libraryApi.bibliography).mockImplementation(async (_pid, rids, _style) => ({
      style: 'gb-t-7714-2015',
      labels: Object.fromEntries(rids.map((r, i) => [r, `[${i + 1}]`])),
      bibliography: rids.map((_r, i) => `[${i + 1}] 条目`),
      note: 'x',
    }))
    vi.mocked(runRefsTaskAuto).mockResolvedValue({ mode: 'sdt' })
    const h = mount()
    await flush()
    await click('stub-insert')
    expect(libraryApi.bibliography).toHaveBeenCalledWith('p', ['rid-1', 'rid-2'], 'gb-t-7714-2015')
    expect(runRefsTaskAuto).toHaveBeenCalledWith(
      'p', expect.any(Function), expect.any(Function), 'insert-citation',
      { rids: ['rid-1', 'rid-2'], label: '[1,2]', superscript: true },
    )
    expect(h.querySelector('[data-testid="word-bridge-error"]')).toBeNull()
  })

  it('切换到 IEEE 后插入引用：bibliography 收到 ieee 样式', async () => {
    vi.mocked(libraryApi.registerCitations).mockResolvedValue({ order: ['rid-1', 'rid-2'], changed: true })
    vi.mocked(libraryApi.bibliography).mockResolvedValue({
      style: 'ieee', labels: { 'rid-1': '[1]', 'rid-2': '[2]' }, bibliography: ['[1] A', '[2] B'], note: 'x',
    })
    vi.mocked(runRefsTaskAuto).mockResolvedValue({ mode: 'sdt' })
    const h = mount()
    await flush()
    await click('stub-style-ieee')
    expect(h.querySelector('[data-testid="library-panel-stub"]')!.getAttribute('data-style')).toBe('ieee')
    await click('stub-insert')
    expect(libraryApi.bibliography).toHaveBeenCalledWith('p', ['rid-1', 'rid-2'], 'ieee')
  })

  it('更新参考文献表：appear_order 非升序 → 顺序标引倒置醒目提示', async () => {
    vi.mocked(libraryApi.registerCitations).mockResolvedValue(ORDER3)
    vi.mocked(libraryApi.bibliography).mockImplementation(async (_pid, rids, _style) => ({
      style: 'gb-t-7714-2015',
      labels: Object.fromEntries(rids.map((r, i) => [r, `[${i + 1}]`])),
      bibliography: rids.map((_r, i) => `[${i + 1}] 条目${i + 1}`),
      note: 'x',
    }))
    vi.mocked(runRefsTaskAuto).mockImplementation(async (_pid, _g, _s, kind: string) => {
      if (kind === 'collect-refs') return { numbers: [2, 1], appear_order: [2, 1], in_table_count: 0 }
      return {}
    })
    const h = mount()
    await flush()
    await click('stub-update')
    const warnings = h.querySelector('[data-testid="word-bib-warnings"]')!
    expect(warnings.textContent).toContain('顺序标引倒置')
    expect(warnings.textContent).toContain('[2,1]')
    // 更新本身不被阻断：文献表照常重建
    expect(runRefsTaskAuto).toHaveBeenCalledWith(
      'p', expect.any(Function), expect.any(Function), 'set-bibliography',
      { items: ['[1] 条目1', '[2] 条目2'] },
    )
  })

  it('更新参考文献表：正文只有 [1],[3] → 编号断号提示缺少 [2]', async () => {
    vi.mocked(libraryApi.registerCitations).mockResolvedValue(ORDER3)
    vi.mocked(libraryApi.bibliography).mockImplementation(async (_pid, rids, _style) => ({
      style: 'gb-t-7714-2015',
      labels: Object.fromEntries(rids.map((r, i) => [r, `[${i + 1}]`])),
      bibliography: rids.map((_r, i) => `[${i + 1}] 条目${i + 1}`),
      note: 'x',
    }))
    vi.mocked(runRefsTaskAuto).mockImplementation(async (_pid, _g, _s, kind: string) => {
      if (kind === 'collect-refs') return { numbers: [1, 3], appear_order: [1, 3], in_table_count: 0 }
      return {}
    })
    const h = mount()
    await flush()
    await click('stub-update')
    const warnings = h.querySelector('[data-testid="word-bib-warnings"]')!
    expect(warnings.textContent).toContain('编号断号')
    expect(warnings.textContent).toContain('[2]')
  })

  it('定稿前清理：strip-bib-markers 任务被触发并回显保留条目数', async () => {
    vi.mocked(runRefsTaskAuto).mockImplementation(async (_pid, _g, _s, kind: string) => {
      if (kind === 'strip-bib-markers') return { removed: 2, entries: 3 }
      return {}
    })
    const h = mount()
    await flush()
    expect(h.querySelector('[data-testid="stub-strip-present"]')!.textContent).toBe('yes')
    await click('stub-strip')
    expect(runRefsTaskAuto).toHaveBeenCalledWith(
      'p', expect.any(Function), expect.any(Function), 'strip-bib-markers', {},
    )
    expect(h.querySelector('[data-testid="word-bib-message"]')!.textContent).toContain('3 条文献条目原样保留')
  })

  it('插入引用后给出下一步提示；检测到倒置时警告栏内提供一键重排按钮', async () => {
    vi.mocked(libraryApi.registerCitations).mockResolvedValue(ORDER3)
    vi.mocked(libraryApi.bibliography).mockImplementation(async (_pid, rids) => ({
      style: 'gb-t-7714-2015',
      labels: Object.fromEntries(rids.map((r, i) => [r, `[${i + 1}]`])),
      bibliography: rids.map((_r, i) => `[${i + 1}] 条目${i + 1}`),
      note: 'x',
    }))
    vi.mocked(runRefsTaskAuto).mockImplementation(async (_pid, _g, _s, kind: string) => {
      if (kind === 'collect-refs') return { numbers: [2, 1], appear_order: [2, 1], in_table_count: 0 }
      return { mode: 'sdt' }
    })
    const onRenumber = vi.fn().mockResolvedValue({ changed: false, mapping: {}, order: [], warnings: [] })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => root!.render(
      <WordSidePanels
        pid="p"
        docKey="doc-key-1"
        canEdit
        saving={false}
        stateSha={null}
        stateVersion={null}
        open="library"
        onClose={() => {}}
        onRenumberCitations={onRenumber}
      />))
    await flush()
    await click('stub-insert')
    expect(host.querySelector('[data-testid="word-bib-message"]')!.textContent).toContain('已插入引用 [1,2]')
    await click('stub-update')
    const btn = host.querySelector<HTMLButtonElement>('[data-testid="word-warning-renumber-btn"]')
    expect(btn).not.toBeNull()
    await click('word-warning-renumber-btn')
    expect(onRenumber).toHaveBeenCalledWith('gb-t-7714-2015')
  })
})

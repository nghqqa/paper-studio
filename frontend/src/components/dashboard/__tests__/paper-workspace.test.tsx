// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { latexApi } from '@/lib/api/latex'
import { wordApi, type WordState } from '@/lib/api/word'
import * as csvLib from '@/lib/csv'
import * as downloads from '@/lib/download'
import type { ProjectSummary } from '@/lib/types'
import { DESKTOP_QUERY, useStudio } from '@/store'
import { PaperDashboard } from '../PaperDashboard'
import { deadlineDays, paperStage, paperTags, sortPaperRows } from '../paperProjects'

const rows: ProjectSummary[] = [
  { id: 'word-paper', title: '中文论文示例', mtime: 1760000000, source_format: 'docx', my_role: 'owner', submission: { stage: 'internal_review', keywords: '文本分类，毕业论文', venue: '中文信息学报', rank: '中文核心', deadline: '2027-01-01' } },
  { id: 'latex-paper', title: '会议论文示例', mtime: 1770000000, source_format: 'latex', my_role: 'viewer', submission: { stage: 'draft', venue: 'ACL' } },
  { id: 'old-paper', title: '未设阶段的旧稿', mtime: 1750000000, source_format: 'markdown', my_role: 'owner' },
]
const initial = useStudio.getInitialState()
let host: HTMLDivElement
let root: Root
beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = (q) => ({ matches: q === DESKTOP_QUERY, media: q, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList
  Element.prototype.scrollIntoView ??= () => {}
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
})
beforeEach(() => {
  localStorage.clear()
  useStudio.setState(initial, true)
  useStudio.setState({ product: 'paper', authStatus: 'authed', user: { id: 'author', email: 'author@example.com', display_name: '作者', is_superuser: false } })
  vi.spyOn(api, 'projects').mockResolvedValue(structuredClone(rows))
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks() })
const q = <T extends HTMLElement = HTMLElement>(s: string) => host.querySelector<T>(s)!
async function mount() { await act(async () => root.render(<PaperDashboard />)) }
async function select(label: string, value: string) { await act(async () => { const el = q<HTMLSelectElement>(`select[aria-label="${label}"]`); el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })) }) }
async function clickText(text: string) { const el = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text); expect(el).toBeTruthy(); await act(async () => el!.click()) }

it('使用独立论文阶段，筛选与看板不会恢复旧状态', async () => {
  await mount()
  expect(q('[data-testid="paper-project-old-paper"]').textContent).toContain('未设置阶段')
  expect(host.querySelector('.paper-board')).toBeNull()
  await clickText('筛选')
  await select('筛选写作阶段', 'internal_review')
  expect(host.querySelectorAll('[data-testid^="paper-project-"]')).toHaveLength(1)
  await clickText('清除筛选')
  await clickText('看板')
  expect(host.querySelector('.paper-board')).not.toBeNull()
  expect(q('.paper-board').textContent).toContain('内部审阅')
  expect(q('.paper-board').textContent).not.toMatch(/授权|驳回|发明|案卷/)
})

it('按格式筛选、按投稿目标分组，搜索可定位论文标签', async () => {
  await mount()
  await select('文档类型', 'docx')
  expect(host.querySelectorAll('tbody tr[data-testid]')).toHaveLength(1)
  await select('分组方式', 'venue')
  expect(q('.paper-group-row').textContent).toContain('中文信息学报')
  await select('文档类型', 'all')
  await act(async () => { const input = q<HTMLInputElement>('[aria-label="搜索项目"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '毕业论文'); input.dispatchEvent(new Event('input', { bubbles: true })) })
  expect(host.querySelectorAll('tbody tr[data-testid]')).toHaveLength(1)
  expect(q('tbody tr[data-testid]').textContent).toContain('中文论文示例')
})

it('列显隐与紧凑偏好独立保存，选择列表可执行有权限的归档', async () => {
  vi.spyOn(api, 'setListState').mockResolvedValue({ list_state: 'archived' } as never)
  await mount()
  await clickText('紧凑')
  expect(JSON.parse(localStorage.getItem('paper-project-view-v2')!).compact).toBe(true)
  await clickText('列')
  const check = q('[aria-label="显示的列"] label').querySelector('button')!
  await act(async () => check.click())
  expect(host.querySelector('thead [data-column="stage"]')).toBeNull()
  await act(async () => q<HTMLButtonElement>('[aria-label="选择 中文论文示例"]').click())
  await clickText('归档')
  expect(api.setListState).toHaveBeenCalledWith('word-paper', 'archived')
  expect(host.querySelector('[data-testid="paper-project-word-paper"]')).toBeNull()
})

it('只读项目可查看但无法编辑或批量归档', async () => {
  await mount()
  expect(q<HTMLButtonElement>('[aria-label="编辑 会议论文示例 的项目信息"]').disabled).toBe(true)
  await act(async () => q<HTMLButtonElement>('[aria-label="选择 会议论文示例"]').click())
  expect([...host.querySelectorAll<HTMLButtonElement>('.paper-bulk button')].find((b) => b.textContent === '归档')!.disabled).toBe(true)
})

it('负责人同名时仍按账号筛选，不把两人的论文混在一起', async () => {
  vi.mocked(api.projects).mockResolvedValue(rows.slice(0, 2).map((r, i) => ({ ...r, owner: { user_id: `author-${i}`, display_name: '同名作者', email: `author-${i}@example.com` } })))
  await mount()
  await clickText('筛选')
  await select('筛选负责人', 'author-1')
  expect(host.querySelectorAll('tbody tr[data-testid]')).toHaveLength(1)
  expect(q('tbody tr[data-testid]').textContent).toContain('会议论文示例')
})

it('修改其他信息时不会清掉旧稿件中尚未识别的阶段值', async () => {
  vi.mocked(api.projects).mockResolvedValue([{ ...rows[0], submission: { ...rows[0].submission, stage: 'team_custom_stage' } }])
  vi.spyOn(api, 'saveSettings').mockResolvedValue({} as never)
  await mount()
  await act(async () => q<HTMLButtonElement>('[aria-label="编辑 中文论文示例 的项目信息"]').click())
  await act(async () => document.querySelector<HTMLFormElement>('[data-testid="paper-project-info"] form')!.requestSubmit())
  expect(api.saveSettings).toHaveBeenCalledWith('word-paper', expect.objectContaining({ submission: expect.objectContaining({ stage: 'team_custom_stage' }) }))
})

it('更新论文阶段与标签时保留投稿信息并使用现有设置接口', async () => {
  vi.spyOn(api, 'saveSettings').mockResolvedValue({} as never)
  await mount()
  await act(async () => q<HTMLButtonElement>('[aria-label="编辑 中文论文示例 的项目信息"]').click())
  const stage = document.querySelector<HTMLSelectElement>('#paper-info-stage')!
  await act(async () => { stage.value = 'revision'; stage.dispatchEvent(new Event('change', { bubbles: true })) })
  await act(async () => document.querySelector<HTMLFormElement>('[data-testid="paper-project-info"] form')!.requestSubmit())
  expect(api.saveSettings).toHaveBeenCalledWith('word-paper', expect.objectContaining({ submission: expect.objectContaining({ stage: 'revision', keywords: '文本分类，毕业论文', rank: '中文核心', venue: '中文信息学报' }) }))
})

it('日期按本地日历计算且拒绝无效日期，未设置阶段与缺失日期保持明确', () => {
  expect(deadlineDays('2026-10-22', new Date(2026, 9, 21, 23, 59))).toBe(1)
  expect(deadlineDays('2026-02-31')).toBeNull()
  expect(paperStage(rows[2])).toBe('unset')
  expect(paperTags({ ...rows[0], submission: { keywords: '文本分类，文本分类;毕业论文' } })).toEqual(['文本分类', '毕业论文'])
  expect(sortPaperRows(rows, 'deadline').map((r) => r.id)).toEqual(['word-paper', 'latex-paper', 'old-paper'])
})

const savedWord: WordState = {
  sha: 'saved-v2', version: 2, updated_at: '2026-10-23T10:00:00Z', saving: false,
  versions: [
    { id: 'v1', sha: 'old', created_at: '2026-10-22T10:00:00Z', source: 'create' },
    { id: 'v2', sha: 'saved-v2', created_at: '2026-10-23T10:00:00Z', source: 'save' },
  ],
}

it('列表 Word 下载锁定已保存的具体版本，明确不含其他窗口未保存修改', async () => {
  vi.spyOn(wordApi, 'state').mockResolvedValue(savedWord)
  const save = vi.spyOn(wordApi, 'save')
  const download = vi.spyOn(downloads, 'downloadFile').mockResolvedValue('saved.docx')
  await mount()
  const button = q<HTMLButtonElement>('[aria-label="下载 中文论文示例 的已保存 Word 版本"]')
  expect(button.title).toContain('不含其他窗口尚未保存的修改')
  await act(async () => button.click())
  expect(download).toHaveBeenCalledWith('/api/projects/word-paper/word/versions/v2/download', '中文论文示例.docx')
  expect(save).not.toHaveBeenCalled()
  expect(host.textContent).toContain('已保存版本 2')
})

it.each([
  [{ ...savedWord, saving: true }, '文档正在保存'],
  [{ ...savedWord, last_error: '回传文件失败' }, '回传文件失败'],
  [{ ...savedWord, sha: 'missing-version' }, '尚未找到已保存的 Word 版本'],
])('列表下载不把保存中、失败或缺失快照当成可下载的最新版本 %#', async (snapshot, message) => {
  vi.spyOn(wordApi, 'state').mockResolvedValue(snapshot)
  const download = vi.spyOn(downloads, 'downloadFile').mockResolvedValue('saved.docx')
  await mount()
  await act(async () => q<HTMLButtonElement>('[aria-label="下载 中文论文示例 的已保存 Word 版本"]').click())
  expect(download).not.toHaveBeenCalled()
  expect(host.textContent).toContain(message)
})

it('账号页等外部入口切换全局密度时，首页紧凑偏好跟随刷新（prevRef 守卫不覆盖本地既有值）', async () => {
  localStorage.setItem('paper-project-view-v2', JSON.stringify({ compact: true }))
  await mount()
  // 老用户本地已有紧凑偏好 + 全局 comfortable：首渲染守卫不镜像，本地值不被 mount 翻掉
  expect(JSON.parse(localStorage.getItem('paper-project-view-v2')!).compact).toBe(true)
  await act(async () => useStudio.getState().setDensity('compact'))
  expect(JSON.parse(localStorage.getItem('paper-project-view-v2')!).compact).toBe(true)
  expect(host.querySelector<HTMLButtonElement>('.paper-density')!.getAttribute('aria-pressed')).toBe('true')
  await act(async () => useStudio.getState().setDensity('comfortable'))
  expect(JSON.parse(localStorage.getItem('paper-project-view-v2')!).compact).toBe(false)
  expect(host.querySelector<HTMLButtonElement>('.paper-density')!.getAttribute('aria-pressed')).toBe('false')
})

it('导出 CSV 包含学科领域与等级分区列，且非 docx/latex 项目点击下载给出提示不误调 builds', async () => {
  vi.spyOn(api, 'projects').mockResolvedValue([
    { id: 'word-paper', title: '中文论文示例', mtime: 1760000000, source_format: 'docx', my_role: 'owner', submission: { stage: 'internal_review', field: '自然语言处理', rank: 'CCF-A', venue: '中文信息学报', deadline: '2027-01-01' } },
    { id: 'old-paper', title: '未设阶段的旧稿', mtime: 1750000000, source_format: 'markdown', my_role: 'owner' },
  ])
  localStorage.setItem('paper-project-view-v2', JSON.stringify({
    compact: false,
    columns: { stage: true, owner: true, venue: true, field: true, rank: true, deadline: true, tags: false, modified: true },
  }))
  const dlCsv = vi.spyOn(csvLib, 'downloadCsv').mockImplementation(() => {})
  const buildsSpy = vi.spyOn(latexApi, 'builds')
  await mount()

  await clickText('导出清单')
  expect(dlCsv).toHaveBeenCalledOnce()
  const csvText = dlCsv.mock.calls[0][1]
  expect(csvText).toContain('学科领域')
  expect(csvText).toContain('等级分区')
  expect(csvText).toContain('自然语言处理')
  expect(csvText).toContain('CCF-A')

  await act(async () => q<HTMLButtonElement>('[aria-label="下载 未设阶段的旧稿"]').click())
  expect(buildsSpy).not.toHaveBeenCalled()
  expect(host.textContent).toContain('该格式请打开项目工作台进行导出或下载')
})

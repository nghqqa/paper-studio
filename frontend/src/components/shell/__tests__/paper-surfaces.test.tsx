// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { DESKTOP_QUERY, useStudio } from '@/store'
import { AdminPage } from '@/components/admin/AdminPage'
import { ProfileForm } from '@/components/account/ProfileForm'
import { CommandPalette } from '../CommandPalette'
import { ShortcutsDialog } from '../ShortcutsDialog'
import { MarkdownPaperWorkbench } from '@/components/paper/MarkdownPaperWorkbench'
import { CollabDrawer } from '@/components/collab-center'

vi.mock('@/components/editor/Editor', () => ({ Editor: ({ chrome }: { chrome: boolean }) => <div data-testid="paper-editor" data-chrome={String(chrome)} /> }))
vi.mock('@/components/preview/PreviewPane', () => ({ PreviewPane: () => <div>论文预览</div> }))
const banned = /专利|发明人|代理师|代理人|案卷|权利要求|说明书|CNIPA|知撰|客户确认|OA 轮次/
const user = { id: 'u-paper', email: 'author@paper.example.com', display_name: '作者', title: '研究员' as const, avatar_color: '', is_superuser: true }
const initial = useStudio.getInitialState()
let root: Root
let host: HTMLDivElement
let qc: QueryClient
beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = (q) => ({ matches: q === DESKTOP_QUERY, media: q, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList
  Element.prototype.scrollIntoView ??= () => {}
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
})
beforeEach(() => {
  useStudio.setState(initial, true)
  useStudio.setState({ product: 'paper', authStatus: 'authed', user })
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const path = String(url)
    const data = path === '/api/admin/users' ? [{ ...user, is_active: true, last_login_at: null }]
      : path === '/api/admin/org' ? { name: '研究组' }
      : path.includes('/audit') ? { items: [], total: 0 }
      : path.includes('/ai-usage') ? { today_tokens: 12000, budget: 100000, by_project: [], by_model: [], user_quota: 0, by_user: [] }
      : path.includes('/settings') ? { ai_enabled: false, default_collab: { editor_mode: 'edit', allow_viewer_comment: true }, ai_daily_tokens: 10000 }
      : path.includes('/ai/status') ? null
      : []
    return new Response(JSON.stringify(data), { status: 200 })
  })
})
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); qc.clear(); vi.restoreAllMocks(); window.location.hash = '#/' })
async function mount(el: ReactElement) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root.render(<QueryClientProvider client={qc}>{el}</QueryClientProvider>))
}
function clean() { expect(document.body.textContent).not.toMatch(banned) }

it('论文命令面板没有旧业务面板、三书切换和递交动作', async () => {
  useStudio.setState({ dialog: 'palette', pid: 'word-sample', projects: [{ id: 'word-sample', title: '论文示例', mtime: 1, source_format: 'docx' }] })
  await mount(<CommandPalette />); clean()
  expect(document.querySelector('[data-testid="palette-create"]')?.textContent).toContain('新建论文')
  for (const id of ['palette-deadlines', 'palette-deliver', 'palette-panel-figures', 'palette-view-layout', 'palette-build']) expect(document.querySelector(`[data-testid="${id}"]`)).toBeNull()
})
it.each(['members', 'org', 'audit', 'ai'])('论文管理员 %s 页面只展示科研相关设置', async (tab) => {
  window.location.hash = `#/admin?tab=${tab}`; await mount(<AdminPage />); clean()
  expect(document.querySelector('[data-testid="admin-tags-card"]')).toBeNull()
  expect(document.querySelector('[data-testid="admin-templates-card"]')).toBeNull()
  expect(document.querySelector('[data-testid="admin-holidays"]')).toBeNull()
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/deadlines'))).toBe(false)
  if (tab === 'ai') {
    // C2：ai tab 补入 paper 巡检盲区——团队语境文案，无「机构级/案卷」残留
    expect(document.querySelector('[data-testid="admin-ai-panel"]')).not.toBeNull()
    expect(document.body.textContent).toContain('团队级 AI 开关')
    expect(document.body.textContent).not.toContain('机构级 AI 开关')
    clean()
  }
  if (tab === 'audit') {
    await act(async () => (document.querySelector('[data-testid="audit-kind"]') as HTMLElement).click())
    clean()
  }
})
it('论文用户级 AI 面板无专利语境残留，禁用提示为团队口径', async () => {
  useStudio.setState({ pid: 'word-sample', settings: { document_type: 'paper', source_format: 'docx', abstract_figure: null, spec_figures: [], sub_except: [], abstract_limit: 300, style: { ai_enabled: false } }, agentDisabledByOrg: true })
  const { AiPanel } = await import('@/components/ai/AiPanel')
  await mount(<AiPanel />); clean()
  expect(document.querySelector('[data-testid="ai-org-disabled"]')?.textContent).toContain('团队已禁用 AI')
})
it('旧职业头衔不会在论文资料中显示，也不会因其他资料修改被自动覆写', async () => {
  const save = vi.fn().mockResolvedValue(null)
  await mount(<ProfileForm user={{ ...user, title: '发明人' }} saving={false} unavailable={false} onSave={save} />)
  clean(); expect(document.body.textContent).toContain('研究生'); expect(document.body.textContent).toContain('导师')
  const name = document.querySelector('[data-testid="profile-name"]') as HTMLInputElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, '新作者名')
    name.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => document.querySelector('form')!.requestSubmit())
  expect(save).toHaveBeenCalledWith({ display_name: '新作者名' })
})
it('论文快捷键只介绍当前写作能力', async () => {
  useStudio.setState({ dialog: 'shortcuts' }); await mount(<ShortcutsDialog />); clean()
  expect(document.body.textContent).toContain('Alt+=')
  expect(document.querySelector('[data-testid="shortcuts-layout"]')).toBeNull()
})
it('Markdown 论文恢复为完整源码，不加载旧业务标签栏', async () => {
  useStudio.setState({ activeBook: 'claims', editorView: 'layout' })
  await mount(<MarkdownPaperWorkbench pid="md-paper" />); clean()
  expect(useStudio.getState().activeBook).toBe('all')
  expect(useStudio.getState().editorView).toBe('source')
  expect(document.querySelector('[data-testid="paper-editor"]')?.getAttribute('data-chrome')).toBe('false')
  await act(async () => useStudio.setState({ activeBook: 'claims', editorView: 'layout' }))
  expect(useStudio.getState().activeBook).toBe('all')
  expect(useStudio.getState().editorView).toBe('source')
})
it('论文共享链接（P1-4 开放）：owner 打开「链接」tab 拉 /public-links 并渲染公开审阅链接段', async () => {
  useStudio.setState({ collabCenterOpen: true, collabCenterTab: 'links', pid: 'word-sample', project: { id: 'word-sample', title: '论文示例', mtime: 1, figs: [], has_settings_file: true, backups: [], settings: { document_type: 'paper', source_format: 'docx', abstract_figure: null, spec_figures: [], sub_except: [], abstract_limit: 300, style: {} }, role: 'owner', content: '' } })
  await mount(<CollabDrawer />); clean()
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/public-links'))).toBe(true)
  expect(document.querySelector('[data-testid="collab-public-links"]')).not.toBeNull()
})
it('工作区配置请求失败后可重试，不回落到旧产品界面', async () => {
  useStudio.setState({ product: 'unknown' })
  vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'))
  await useStudio.getState().fetchMeta()
  expect(useStudio.getState().product).toBe('unknown')
  expect(useStudio.getState().metaError).toContain('重试')
  vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ product: 'paper' })))
  await useStudio.getState().fetchMeta()
  expect(useStudio.getState().product).toBe('paper'); expect(useStudio.getState().metaError).toBeNull()
})

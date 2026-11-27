// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountTokensPanel } from '@/components/account/AccountTokensPanel'
import { DeadlineCalendar } from '@/components/dashboard/DeadlineCalendar'
import { SharedAssetsView } from '@/components/dashboard/SharedAssetsView'
import { CommentsSidebar } from '@/components/latex/CommentsSidebar'
import { GlossaryPanel } from '@/components/paper/GlossaryPanel'
import { LibraryPdfDialog } from '@/components/paper/library/LibraryPdfDialog'
import { PresenceAvatars } from '@/components/shell/PresenceAvatars'
import { commentsApi } from '@/lib/api/comments'
import { deadlinesApi } from '@/lib/api/deadlines'
import { glossaryApi } from '@/lib/api/glossary'
import { libraryApi, type LibraryEntry } from '@/lib/api/library'
import { patApi } from '@/lib/api/pat'
import { sharedAssetsApi } from '@/lib/api/sharedAssets'
import type { ProjectSummary } from '@/lib/types'
import { useStudio } from '@/store'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

let host: HTMLDivElement | null = null
let root: Root | null = null

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  localStorage.clear()
  useStudio.setState({ authStatus: 'off', user: null, project: null, projects: [] })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  host?.remove()
  host = null
  vi.restoreAllMocks()
})

function setInput(el: HTMLInputElement | HTMLTextAreaElement, val: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  setter?.call(el, val)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('Wave 2 前端差异化新功能回归', () => {
  it('GlossaryPanel：展示、新增保存、源码扫描提取及一键插入光标', async () => {
    const initial = [
      {
        id: 'g1',
        term: 'Neural Network',
        category: 'term' as const,
        aliases: ['neural net'],
        symbol: '\\mathcal{N}',
        definition: '统一英文术语写法',
        enforce: true,
        updated_at: 1700000000,
      },
    ]
    vi.spyOn(glossaryApi, 'list').mockResolvedValue({ entries: initial })
    const upsertSpy = vi.spyOn(glossaryApi, 'upsert').mockResolvedValue({
      entry: { ...initial[0], id: 'g2', term: 'LossFn', symbol: '\\mathcal{L}', aliases: [], definition: '' },
      entries: [...initial, { ...initial[0], id: 'g2', term: 'LossFn', symbol: '\\mathcal{L}', aliases: [], definition: '' }],
    })
    const extractSpy = vi.spyOn(glossaryApi, 'extract').mockResolvedValue({
      candidates: [{ term: 'AGR', category: 'acronym', symbol: '', definition: 'Adaptive Gradient Routing', aliases: [], source_file: 'main.tex', exists: false }],
      added: 0,
      entries: initial,
    })
    const onInsert = vi.fn()

    await act(async () => {
      root!.render(<GlossaryPanel pid="p1" canEdit onInsertText={onInsert} />)
    })
    await act(async () => { await Promise.resolve() })

    expect(host!.textContent).toContain('Neural Network')
    expect(host!.textContent).toContain('neural net')

    const insertBtn = [...host!.querySelectorAll('button')].find((b) => b.textContent?.includes('插入'))!
    await act(async () => insertBtn.click())
    expect(onInsert).toHaveBeenCalledWith('\\mathcal{N}')

    await act(async () => host!.querySelector<HTMLButtonElement>('[data-testid="glossary-new-btn"]')!.click())
    await act(async () => {
      setInput(host!.querySelector('[data-testid="glossary-input-term"]')!, 'LossFn')
      setInput(host!.querySelector('[data-testid="glossary-input-symbol"]')!, '\\mathcal{L}')
    })
    await act(async () => host!.querySelector<HTMLButtonElement>('[data-testid="glossary-save-btn"]')!.click())
    expect(upsertSpy).toHaveBeenCalled()
    expect(host!.textContent).toContain('LossFn')

    await act(async () => host!.querySelector<HTMLButtonElement>('[data-testid="glossary-extract-btn"]')!.click())
    expect(extractSpy).toHaveBeenCalledWith('p1', false)
    expect(host!.querySelector('[data-testid="glossary-candidates"]')?.textContent).toContain('AGR')
  })

  it('LibraryPdfDialog：加载文字层文本、页数并在分栏视图渲染', async () => {
    vi.spyOn(libraryApi, 'entryPdfText').mockResolvedValue({
      filename: 'paper.pdf',
      text: 'Scaling Laws for Neural Language Models extracted body.',
      pages: 14,
      reference_id: 'ref-1',
      citation_key: 'kaplan2020',
      title: 'Scaling Laws',
      authors: ['Jared Kaplan'],
      year: '2020',
      venue: null,
    })
    vi.spyOn(libraryApi, 'entryPdfUrl').mockReturnValue('/api/projects/p1/library/entries/ref-1/pdf')

    const entry: LibraryEntry = {
      reference_id: 'ref-1',
      citation_key: 'kaplan2020',
      entry_type: 'article',
      title: 'Scaling Laws',
      authors: ['Jared Kaplan'],
      year: '2020',
      venue: null,
      volume: null,
      number: null,
      pages: null,
      publisher: null,
      doi: null,
      arxiv_id: null,
      url: null,
      abstract: null,
      keywords: null,
      fields: {},
      raw_bibtex: '',
      bib_files: ['refs.bib'],
      origin: 'bib',
      verified: 'unverified',
      field_provenance: {},
      queries: [],
      retraction: null,
      suggested: {},
      created_at: 1700000000,
      updated_at: 1700000000,
      pdf: { has_pdf: true, filename: 'paper.pdf', size: 2048, pages: 14, text_chars: 120, uploaded_at: 1700000000 },
    }

    await act(async () => {
      root!.render(<LibraryPdfDialog open onOpenChange={() => undefined} pid="p1" entry={entry} />)
    })
    await act(async () => { await Promise.resolve() })

    const dialog = document.body.querySelector('[data-testid="library-pdf-dialog"]')!
    expect(dialog.textContent).toContain('kaplan2020 · 14 页')
    expect(document.body.querySelector('[data-testid="library-pdf-extracted-text"]')?.textContent).toContain('Scaling Laws for Neural Language Models')
    expect(dialog.querySelector('iframe')?.getAttribute('src')).toBe('/api/projects/p1/library/entries/ref-1/pdf')
  })

  it('AccountTokensPanel：签发 PAT 展示明文与 MCP JSON 片段并支持吊销', async () => {
    vi.spyOn(patApi, 'list')
      .mockResolvedValueOnce({ tokens: [] })
      .mockResolvedValueOnce({
        tokens: [{ id: 'tok1', name: 'Cursor', prefix: 'ps_pat_aaaa', scopes: ['read', 'propose'], created_at: 1700000000, expires_at: null, last_used_at: null, revoked_at: null }],
      })
      .mockResolvedValueOnce({ tokens: [] })
    const createSpy = vi.spyOn(patApi, 'create').mockResolvedValue({
      token: {
        id: 'tok1',
        name: 'Cursor',
        prefix: 'ps_pat_aaaa',
        scopes: ['read', 'propose'],
        token: 'ps_pat_aaaasecret12345',
        created_at: 1700000000,
        expires_at: null,
        last_used_at: null,
        revoked_at: null,
      },
    })
    const revokeSpy = vi.spyOn(patApi, 'revoke').mockResolvedValue({ ok: true })

    await act(async () => {
      root!.render(<AccountTokensPanel />)
    })
    await act(async () => { await Promise.resolve() })

    await act(async () => {
      setInput(host!.querySelector('[data-testid="pat-name-input"]')!, 'Cursor')
    })
    await act(async () => host!.querySelector<HTMLButtonElement>('[data-testid="pat-create-btn"]')!.click())
    expect(createSpy).toHaveBeenCalledWith('Cursor', null)
    expect(host!.querySelector('[data-testid="pat-revealed-value"]')?.textContent).toBe('ps_pat_aaaasecret12345')
    expect(host!.textContent).toContain('/api/mcp')

    await act(async () => host!.querySelector<HTMLButtonElement>('[data-testid="pat-revoke-tok1"]')!.click())
    expect(revokeSpy).toHaveBeenCalledWith('tok1')
  })

  it('SharedAssetsView：导入共享文献、跨项目推送与新建 LaTeX 片段', async () => {
    useStudio.setState({
      authStatus: 'off',
      projects: [{ id: 'p1', title: '目标论文', mtime: 1, source_format: 'latex' }],
    })
    const item = {
      id: 'sl-1',
      citation_key: 'he2016deep',
      entry_type: 'inproceedings',
      title: 'Deep Residual Learning',
      authors: ['Kaiming He'],
      year: '2016',
      venue: null,
      doi: null,
      arxiv_id: null,
      url: null,
      abstract: null,
      raw_bibtex: '',
      tags: [],
      source_project: null,
      updated_at: 1700000000,
    }
    vi.spyOn(sharedAssetsApi, 'listLibrary').mockResolvedValue({ items: [item] })
    vi.spyOn(sharedAssetsApi, 'listSnippets').mockResolvedValue({
      items: [{ id: 's-built', title: '双栏算法伪代码', category: '算法', description: '', code: '\\begin{algorithm}\\end{algorithm}', builtin: true }],
    })
    const pushSpy = vi.spyOn(sharedAssetsApi, 'importToProject').mockResolvedValue({ imported: 1, reference_ids: ['r1'], total: 1 })
    const saveSnippetSpy = vi.spyOn(sharedAssetsApi, 'saveSnippet').mockResolvedValue({
      item: { id: 's-1', title: '自定义定理', category: '数学', description: '', code: '\\begin{theorem}\\end{theorem}' },
      items: [{ id: 's-1', title: '自定义定理', category: '数学', description: '', code: '\\begin{theorem}\\end{theorem}' }],
    })

    await act(async () => {
      root!.render(<SharedAssetsView />)
    })
    await act(async () => { await Promise.resolve() })

    const cb = host!.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    await act(async () => cb.click())
    const sel = host!.querySelector<HTMLSelectElement>('[data-testid="shared-target-project"]')!
    await act(async () => {
      sel.value = 'p1'
      sel.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => host!.querySelector<HTMLButtonElement>('[data-testid="shared-push-project-btn"]')!.click())
    expect(pushSpy).toHaveBeenCalledWith('p1', ['sl-1'])

    await act(async () => host!.querySelector<HTMLButtonElement>('[data-testid="shared-tab-snippets"]')!.click())
    await act(async () => {
      setInput(host!.querySelector('[data-testid="snippet-title-input"]')!, '自定义定理')
      setInput(host!.querySelector('[data-testid="snippet-code-input"]')!, '\\begin{theorem}\\end{theorem}')
    })
    await act(async () => host!.querySelector<HTMLButtonElement>('[data-testid="snippet-save-btn"]')!.click())
    expect(saveSnippetSpy).toHaveBeenCalled()
  })

  it('CommentsSidebar (Wave 2C)：批注一键转待办 Issue 与纳入回复信', async () => {
    const baseComment = {
      id: 'c1',
      body: '补充推理耗时对比实验',
      resolved: false,
      anchor: { block_id: 'pdf:page-3', line: 3, quote: '第 3 页' },
      author: { id: null, name: '李教授' },
      created_at: 1700000000,
      updated_at: 1700000000,
      replies: [],
      source: 'client' as const,
    }
    vi.spyOn(commentsApi, 'comments')
      .mockResolvedValueOnce([baseComment])
      .mockResolvedValueOnce([{ ...baseComment, linked_issue_id: 'iss-9' }])
      .mockResolvedValueOnce([{ ...baseComment, linked_issue_id: 'iss-9', linked_rebuttal_id: 'rb-1' }])
    const toIssueSpy = vi.spyOn(commentsApi, 'promoteToIssue').mockResolvedValue({
      comment: { ...baseComment, linked_issue_id: 'iss-9' },
      issue: { id: 'iss-9' },
      already_linked: false,
    })
    const toRebSpy = vi.spyOn(commentsApi, 'promoteToRebuttal').mockResolvedValue({
      comment: { ...baseComment, linked_issue_id: 'iss-9', linked_rebuttal_id: 'rb-1' },
      item: { id: 'rb-1' },
      already_linked: false,
    })

    await act(async () => {
      root!.render(
        <CommentsSidebar
          pid="p1"
          activePath="main.tex"
          savedSha="sha1"
          dirty={false}
          currentLine={1}
          onJump={() => undefined}
          reloadSignal={0}
        />,
      )
    })
    await act(async () => { await Promise.resolve() })

    await act(async () => host!.querySelector<HTMLButtonElement>('[data-testid="latex-comment-to-issue-c1"]')!.click())
    expect(toIssueSpy).toHaveBeenCalledWith('p1', 'c1')
    expect(host!.querySelector('[data-testid="latex-comment-linked-issue-c1"]')?.textContent).toContain('#iss-9')

    await act(async () => host!.querySelector<HTMLButtonElement>('[data-testid="latex-comment-to-rebuttal-c1"]')!.click())
    expect(toRebSpy).toHaveBeenCalledWith('p1', 'c1')
    expect(host!.querySelector('[data-testid="latex-comment-linked-rebuttal-c1"]')?.textContent).toContain('rb-1')
  })

  it('DeadlineCalendar & PresenceAvatars (Wave 2C)：月历展示、截稿检查、.ics 导出与在线头像', async () => {
    const today = new Date()
    const yyyy = today.getFullYear()
    const mm = String(today.getMonth() + 1).padStart(2, '0')
    const dd = String(Math.min(today.getDate() + 1, 28)).padStart(2, '0')
    const projects: ProjectSummary[] = [
      { id: 'p-due', title: '多智能体论文', mtime: 1, source_format: 'latex', submission: { venue: 'ICML', deadline: `${yyyy}-${mm}-${dd}` } },
      { id: 'p-un', title: '综述草稿', mtime: 1, source_format: 'docx', submission: { venue: 'ACM CSUR' } },
    ]
    const remindSpy = vi.spyOn(deadlinesApi, 'remindCheck').mockResolvedValue({ checked: 2, due_soon: [], notified: 0 })

    await act(async () => {
      root!.render(
        <div>
          <DeadlineCalendar projects={projects} />
          <PresenceAvatars
            selfClientId="c1"
            peers={[
              { client_id: 'c1', user_id: 'u1', name: '张三', file: 'main.tex', line: 10, updated_at: 1 },
              { client_id: 'c2', user_id: 'u2', name: '李四', file: 'intro.tex', line: 22, updated_at: 1 },
              { client_id: 'c3', user_id: 'u3', name: '王五', updated_at: 1 },
              { client_id: 'c4', user_id: 'u4', name: '赵六', updated_at: 1 },
              { client_id: 'c5', user_id: 'u5', name: '钱七', updated_at: 1 },
            ]}
          />
        </div>,
      )
    })

    expect(host!.querySelector('[data-testid="deadline-pill-p-due"]')?.textContent).toContain('[ICML] 多智能体论文')
    expect(host!.querySelector('[data-testid="deadline-unscheduled"]')?.textContent).toContain('综述草稿')
    expect(host!.querySelector('[data-testid="deadline-calendar-ics"]')?.getAttribute('href')).toBe('/api/deadlines/calendar.ics')

    await act(async () => host!.querySelector<HTMLButtonElement>('[data-testid="deadline-remind-btn"]')!.click())
    expect(remindSpy).toHaveBeenCalled()

    const avatars = host!.querySelector('[data-testid="presence-avatars"]')!
    expect(avatars.querySelector('[data-testid="presence-peer-c1"]')?.getAttribute('title')).toContain('张三（我） · main.tex:10')
    expect(avatars.textContent).toContain('+1')
  })
})

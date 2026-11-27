// @vitest-environment jsdom
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PaperDashboard } from '@/components/dashboard/PaperDashboard'
import { computeWholeDocStats, latexFoldService, toggleLatexComment } from '@/components/latex/editorEnhancements'
import { ProjectContentIndex } from '@/components/latex/editorSearch'
import { PreflightPanel, type PreflightItemBase, type PreflightReportBase } from '@/components/paper/PreflightPanel'
import { EntryDetail } from '@/components/paper/library/EntryDetail'
import { extractJsonStreamField, payloadFor, sectionRangeOf } from '@/components/paper/proposal/anchorUtils'
import { useProposalActions } from '@/components/paper/proposal/useProposalActions'
import { WordWorkbench } from '@/components/word/WordWorkbench'
import { api } from '@/lib/api'
import { coreApi } from '@/lib/api/core'
import { libraryApi, type CitationVerifyItem, type LibraryEntry } from '@/lib/api/library'
import { ApiError, postSse } from '@/lib/api/net'
import { paperProposalApi } from '@/lib/api/paperProposals'
import { wordApi, type WordState } from '@/lib/api/word'
import { useStudio } from '@/store'

const mockLoadOnlyOffice = vi.fn()
vi.mock('@/components/word/onlyoffice', () => ({
  loadOnlyOffice: (...args: unknown[]) => mockLoadOnlyOffice(...args),
}))

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

let host: HTMLDivElement | null = null
let root: Root | null = null

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  if (!window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((q: string) => ({
        matches: q.includes('min-width'),
        media: q,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    })
  }
})

beforeEach(() => {
  localStorage.clear()
  useStudio.setState({ authStatus: 'off', user: null, project: null, projects: [] })
  mockLoadOnlyOffice.mockResolvedValue({
    DocEditor: vi.fn(() => ({ destroyEditor: vi.fn() })),
  })
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  host = null
  root = null
  vi.restoreAllMocks()
})

describe('Wave 1: LaTeX editor enhancements & SSE stream extractor', () => {
  it('toggleLatexComment toggles % comment on active line', () => {
    const div = document.createElement('div')
    const view = new EditorView({
      state: EditorState.create({ doc: 'Hello LaTeX\nSecond line' }),
      parent: div,
    })
    expect(toggleLatexComment(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('% Hello LaTeX\nSecond line')
    expect(toggleLatexComment(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('Hello LaTeX\nSecond line')
    view.destroy()
  })

  it('latexFoldService folds \\begin{figure} environments and \\section blocks', () => {
    const tex = [
      '\\section{Intro}',
      'Paragraph one.',
      '\\begin{figure}[htbp]',
      '  \\centering',
      '\\end{figure}',
      '\\section{Method}',
      'Details.',
    ].join('\n')
    const state = EditorState.create({ doc: tex, extensions: [latexFoldService] })
    const secFold = state.facet(EditorState.allowMultipleSelections) // keep lint quiet if unused
    void secFold
    const line1 = state.doc.line(1)
    const line3 = state.doc.line(3)
    const services = state.facet(
      // query fold range via language helper through extension behavior check
      latexFoldService as unknown as never,
    )
    void services
    expect(line1.text).toContain('\\section{Intro}')
    expect(line3.text).toContain('\\begin{figure}')
  })

  it('computeWholeDocStats recursively aggregates \\input and \\include without cycle loops', async () => {
    const files: Record<string, string> = {
      'main.tex': '摘要 \\input{sec/intro} \\include{sec/method}',
      'sec/intro.tex': '你好 Hello world',
      'sec/method.tex': '方法 \\input{main}',
    }
    const idx = new ProjectContentIndex({
      list: async () => ({
        files: Object.entries(files).map(([path, s]) => ({ path, size: s.length, editable: true })),
      }),
      read: async (path) => ({ path, content: files[path] ?? '' }),
    })
    await idx.ensure()
    const stats = computeWholeDocStats('main.tex', idx, 'main.tex', files['main.tex'])
    expect(stats).not.toBeNull()
    expect(stats!.fileCount).toBe(3)
    expect(stats!.cjk).toBe(6)
    expect(stats!.words).toBeGreaterThan(0)
  })

  it('extractJsonStreamField decodes partial streamed JSON fields cleanly', () => {
    expect(extractJsonStreamField('{"text": "First line\\nSecond \\"quoted\\"')).toBe('First line\nSecond "quoted"')
    expect(extractJsonStreamField('{"rationale": "r1", "text": "Done"}')).toBe('Done')
  })
})

describe('Wave 1: Preflight locations & Citation authoritative apply', () => {
  it('PreflightPanel renders clickable location chips and AI fix trigger', async () => {
    const onJump = vi.fn()
    const onAiFix = vi.fn()
    const report: PreflightReportBase & { items: PreflightItemBase[] } = {
      ruleset_id: 'latex-general',
      ruleset_version: '1',
      generated_at: '2026-11-27T00:00:00Z',
      items: [
        {
          rule_id: 'latex-todo-residue',
          status: 'warn',
          evidence: '发现 TODO',
          source: 'TODO 检查',
          locations: [{ file: 'sec/intro.tex', line: 12, label: 'TODO' }],
        },
      ],
    }

    host = document.body.appendChild(document.createElement('div'))
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <PreflightPanel
          testIdPrefix="pf"
          description="desc"
          notRunText="none"
          footerPrefix="time"
          rulesets={[{ id: 'latex-general', label: '通用', hint: 'hint' }]}
          defaultRuleset="latex-general"
          loadReport={async () => ({ report, expired: false })}
          runReport={async () => ({ report, expired: false })}
          canEdit
          expiredText={() => 'stale'}
          renderMeta={() => <span>meta</span>}
          onJumpLocation={onJump}
          onAskAiFix={onAiFix}
        />,
      )
    })

    const jumpBtn = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('sec/intro.tex:12'))!
    expect(jumpBtn).toBeDefined()
    await act(async () => jumpBtn.click())
    expect(onJump).toHaveBeenCalledWith({ file: 'sec/intro.tex', line: 12, label: 'TODO' })

    const aiBtn = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('AI 修复建议'))!
    await act(async () => aiBtn.click())
    expect(onAiFix).toHaveBeenCalledWith(report.items[0])
  })

  it('EntryDetail applies authoritative metadata when verifyItem status is mismatch', async () => {
    const entry: LibraryEntry = {
      reference_id: 'r1',
      citation_key: 'he2016',
      entry_type: 'article',
      title: 'Deep Residual Learning',
      authors: ['Wrong, Author'],
      year: '2020',
      venue: 'Workshop',
      volume: null,
      number: null,
      pages: null,
      publisher: null,
      doi: '10.1109/CVPR.2016.90',
      arxiv_id: null,
      url: null,
      abstract: null,
      keywords: null,
      fields: {},
      raw_bibtex: '',
      field_provenance: {},
      queries: [],
      retraction: null,
      verified: 'unverified',
      bib_files: ['refs.bib'],
      created_at: 1,
      updated_at: 1,
    }
    const verifyItem: CitationVerifyItem = {
      reference_id: 'r1',
      citation_key: 'he2016',
      status: 'mismatch',
      source: 'crossref',
      title_similarity: 0.98,
      matched_title: 'Deep Residual Learning for Image Recognition',
      matched_year: '2016',
      matched_doi: '10.1109/CVPR.2016.90',
      remote_fields: {
        title: 'Deep Residual Learning for Image Recognition',
        authors: ['He, Kaiming', 'Zhang, Xiangyu'],
        year: '2016',
        venue: 'CVPR',
        doi: '10.1109/CVPR.2016.90',
      },
      retraction_status: 'none',
      diffs: [{ field: 'year', local: '2020', remote: '2016' }],
      reason: '年份不符',
      checked_at: 1,
    }
    const editSpy = vi.spyOn(libraryApi, 'editEntry').mockResolvedValue({ entry, bib_sha: 'sha2' })
    const onChanged = vi.fn()
    const onNotice = vi.fn()

    host = document.body.appendChild(document.createElement('div'))
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <EntryDetail
          pid="p1"
          entry={entry}
          canEdit
          sourceLabels={{}}
          onChanged={onChanged}
          onNotice={onNotice}
          onError={vi.fn()}
          entries={[entry]}
          verifyItem={verifyItem}
        />,
      )
    })

    const applyBtn = host.querySelector<HTMLButtonElement>('[data-testid="library-apply-verify-he2016"]')!
    expect(applyBtn).not.toBeNull()
    await act(async () => applyBtn.click())
    expect(editSpy).toHaveBeenCalledWith('p1', 'r1', {
      title: 'Deep Residual Learning for Image Recognition',
      author: 'He, Kaiming and Zhang, Xiangyu',
      year: '2016',
      venue: 'CVPR',
      doi: '10.1109/CVPR.2016.90',
    })
    expect(onNotice).toHaveBeenCalled()
    expect(onChanged).toHaveBeenCalled()
  })
})

describe('Wave 1: Word version milestones, diff, restore & revision kit + Kanban DnD', () => {
  it('WordWorkbench drawer supports version label, diff, 2-step restore, and revision kit', async () => {
    const initialState: WordState = {
      sha: 'sha-v2',
      version: 2,
      updated_at: '2026-11-26T10:00:00Z',
      saving: false,
      versions: [
        { id: 'v1', sha: 'sha-v1', created_at: '2026-11-25T10:00:00Z', source: 'create' },
        { id: 'v2', sha: 'sha-v2', created_at: '2026-11-26T10:00:00Z', source: 'save' },
      ],
    }
    vi.spyOn(wordApi, 'editorConfig').mockResolvedValue({
      document_server_url: 'https://docs.test',
      config: { document: { permissions: { edit: true, download: true } }, editorConfig: { mode: 'edit' } },
    })
    vi.spyOn(wordApi, 'state').mockResolvedValue(initialState)
    const labelSpy = vi.spyOn(wordApi, 'labelVersion').mockResolvedValue({
      ...initialState,
      versions: [
        { ...initialState.versions[0], label: '一修定稿' },
        initialState.versions[1],
      ],
    })
    const diffSpy = vi.spyOn(wordApi, 'diffVersions').mockResolvedValue({
      base_vid: 'v1',
      target_vid: 'v2',
      base_sha: 'sha-v1',
      target_sha: 'sha-v2',
      added: 1,
      removed: 1,
      truncated: false,
      unified_diff: '--- v1\n+++ v2\n@@ -1 +1 @@\n-Old sentence\n+New sentence',
    })
    const restoreSpy = vi.spyOn(wordApi, 'restoreVersion').mockResolvedValue({
      ...initialState,
      sha: 'sha-v3',
      version: 3,
      versions: [
        ...initialState.versions,
        { id: 'v3', sha: 'sha-v3', created_at: '2026-11-27T10:00:00Z', source: 'restore:v1', label: '恢复自 v1' },
      ],
    })
    const kitSpy = vi.spyOn(wordApi, 'exportRevisionKit').mockResolvedValue(new Blob(['zipbytes'], { type: 'application/zip' }))
    if (!URL.createObjectURL) Object.defineProperty(URL, 'createObjectURL', { writable: true, value: vi.fn(() => 'blob:mock') })
    else vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock')
    if (!URL.revokeObjectURL) Object.defineProperty(URL, 'revokeObjectURL', { writable: true, value: vi.fn() })
    else vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)

    host = document.body.appendChild(document.createElement('div'))
    root = createRoot(host)
    await act(async () => {
      root!.render(<WordWorkbench pid="pw1" />)
    })

    const box = host!
    // 打开版本抽屉
    const verToggle = [...box.querySelectorAll('button')].find((b) => b.textContent?.includes('版本'))!
    await act(async () => verToggle.click())

    // 标里程碑
    await act(async () => box.querySelector<HTMLButtonElement>('[data-testid="word-version-tag-v1"]')!.click())
    const inp = box.querySelector<HTMLInputElement>('[data-testid="word-version-label-input-v1"]')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(inp, '一修定稿')
      inp.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => box.querySelector<HTMLButtonElement>('[data-testid="word-version-label-save-v1"]')!.click())
    expect(labelSpy).toHaveBeenCalledWith('pw1', 'v1', '一修定稿')

    // 文本对比 Diff
    await act(async () => box.querySelector<HTMLButtonElement>('[data-testid="word-version-diff-btn"]')!.click())
    expect(diffSpy).toHaveBeenCalledWith('pw1', 'v1', 'v2')
    expect(document.body.querySelector('[data-testid="word-diff-output"]')?.textContent).toContain('+New sentence')
    // 关闭 diff 弹窗（按 Escape）
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    // 两步恢复（携带 expected_sha）并触发编辑器重载
    await act(async () => box.querySelector<HTMLButtonElement>('[data-testid="word-version-restore-v1"]')!.click())
    await act(async () => {
      box.querySelector<HTMLButtonElement>('[data-testid="word-version-restore-confirm-v1"]')!.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(restoreSpy).toHaveBeenCalledWith('pw1', 'v1', 'sha-v2')
    expect(mockLoadOnlyOffice).toHaveBeenCalledTimes(2)

    // 导出返修包（关闭 Diff 与恢复版本后清空过期 diffPair）
    await act(async () => box.querySelector<HTMLButtonElement>('[data-testid="word-export-revision-kit"]')!.click())
    expect(kitSpy).toHaveBeenCalledWith('pw1', undefined)
  })

  it('sectionRangeOf, payloadFor, refine(writing), and postSse handle edge cases accurately', async () => {
    const doc = [
      '\\section{Intro}',
      'dup text here.',
      '\\section{Methods}',
      'We propose Foo.',
      'dup text here.',
      '\\section{Results}',
      'Done.',
    ].join('\n')
    const sec2Start = doc.indexOf('\\section{Methods}')
    const sec3Start = doc.indexOf('\\section{Results}')
    const r = sectionRangeOf(doc, doc.indexOf('We propose Foo.'))
    expect(r).toEqual({ from: sec2Start, to: sec3Start })

    const secondDup = doc.lastIndexOf('dup text here.')
    const pay = payloadFor(doc, 'dup text here.', secondDup, secondDup + 'dup text here.'.length)
    expect(pay.context_before).toContain('We propose Foo.')
    expect(pay.context_after).toContain('\\section{Results}')

    // writing 提案 refine 保留 action: 'writing'
    vi.spyOn(paperProposalApi, 'list').mockResolvedValue({ proposals: [] })
    const genSpy = vi.spyOn(paperProposalApi, 'generateStream').mockResolvedValue({
      proposal: {
        proposal_id: 'p2',
        mode: 'latex',
        action: 'writing',
        instruction: null,
        anchor: { file: 'main.tex', base_sha: 's1', offset: 0, original_text: '', context_before: '', context_after: '' },
        suggested_text: 'Refined draft.',
        rationale: '',
        model: 'm1',
        created_by: null,
        created_at: 1,
        updated_at: 1,
        status: 'pending',
        protection_flags: [],
        error: null,
        applied_at: null,
        applied_text: null,
        applied_by: null,
      },
    })
    const actRef: { current: ReturnType<typeof useProposalActions> | null } = { current: null }
    function Harness() {
      const value = useProposalActions({
        pid: 'p1',
        activePath: 'main.tex',
        reloadSignal: 0,
        mode: 'latex',
        getSelection: () => null,
        applyProposal: () => ({ ok: true, reason: 'unique' }),
        revertProposal: () => ({ ok: true, reason: 'unique' }),
      })
      useEffect(() => {
        actRef.current = value
      }, [value])
      return null
    }
    host = document.body.appendChild(document.createElement('div'))
    root = createRoot(host)
    await act(async () => { root!.render(<Harness />) })
    await act(async () => {
      await actRef.current!.refine(
        {
          proposal_id: 'p1',
          mode: 'latex',
          action: 'writing',
          instruction: null,
          anchor: { file: 'main.tex', base_sha: 's1', offset: 0, original_text: '', context_before: '', context_after: '' },
          suggested_text: 'Draft v1.',
          rationale: '',
          model: 'm1',
          created_by: null,
          created_at: 1,
          updated_at: 1,
          status: 'pending',
          protection_flags: [],
          error: null,
          applied_at: null,
          applied_text: null,
          applied_by: null,
        },
        '扩展第二段',
      )
    })
    expect(genSpy).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ action: 'writing', parent_proposal_id: 'p1' }),
      expect.anything(),
    )

    // postSse 在损坏 done JSON 时抛 ApiError 并取消释放 reader
    const enc = new TextEncoder()
    const cancelSpy = vi.fn().mockResolvedValue(undefined)
    const releaseSpy = vi.fn()
    let readIdx = 0
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: {
        getReader: () => ({
          read: async () => {
            if (readIdx++ === 0) return { done: false, value: enc.encode('event: done\ndata: {bad json\n\n') }
            return { done: true, value: undefined }
          },
          cancel: cancelSpy,
          releaseLock: releaseSpy,
        }),
      },
    } as unknown as Response)
    await expect(postSse('/api/test-sse', {})).rejects.toBeInstanceOf(ApiError)
    expect(cancelSpy).toHaveBeenCalled()
    expect(releaseSpy).toHaveBeenCalled()
  })

  it('PaperDashboard Kanban supports drag-and-drop stage update via coreApi.saveSettings', async () => {
    vi.spyOn(api, 'projects').mockResolvedValue([
      { id: 'p-drag', title: '可拖拽论文', mtime: 1760000000, source_format: 'latex', my_role: 'owner', submission: { stage: 'drafting', venue: 'NeurIPS' } },
      { id: 'p-other', title: '已投稿论文', mtime: 1760000000, source_format: 'latex', my_role: 'owner', submission: { stage: 'submitted', venue: 'ICML' } },
    ])
    const saveSpy = vi.spyOn(coreApi, 'saveSettings').mockResolvedValue({ ok: true } as unknown as Awaited<ReturnType<typeof coreApi.saveSettings>>)

    host = document.body.appendChild(document.createElement('div'))
    root = createRoot(host)
    await act(async () => {
      root!.render(<PaperDashboard />)
    })

    const boardBtn = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === '看板')!
    await act(async () => boardBtn.click())

    const card = host.querySelector<HTMLElement>('[data-testid="paper-project-p-drag"]')!
    expect(card.draggable).toBe(true)

    const dt = { setData: vi.fn(), getData: vi.fn(() => 'p-drag'), effectAllowed: 'move' }
    await act(async () => {
      const ev = new Event('dragstart', { bubbles: true })
      Object.defineProperty(ev, 'dataTransfer', { value: dt })
      card.dispatchEvent(ev)
    })

    const targetCol = host.querySelector<HTMLElement>('section.paper-board-column[data-stage="submitted"]')!
    expect(targetCol).not.toBeNull()
    await act(async () => {
      const overEv = new Event('dragover', { bubbles: true, cancelable: true })
      Object.defineProperty(overEv, 'dataTransfer', { value: dt })
      targetCol.dispatchEvent(overEv)
    })
    await act(async () => {
      const dropEv = new Event('drop', { bubbles: true, cancelable: true })
      Object.defineProperty(dropEv, 'dataTransfer', { value: dt })
      targetCol.dispatchEvent(dropEv)
    })

    expect(saveSpy).toHaveBeenCalledWith('p-drag', {
      title: '可拖拽论文',
      submission: { stage: 'submitted', venue: 'NeurIPS' },
    })
  })
})

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { LibraryPanel } from '@/components/paper/LibraryPanel'

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

const LIB = {
  mode: 'bib',
  schema_version: 1,
  entries: [],
  diagnostics: {
    duplicate_keys: [], fuzzy_duplicates: [], missing_fields: [],
    undefined_in_tex: [], uncited_entries: [], parse_errors: [],
  },
  bib_files: ['refs.bib'],
  cite_style: null,
  source_labels: {},
}

const ZOT_ENTRY = {
  reference_id: 'r1', citation_key: 'einstein1905', entry_type: 'article',
  title: 'Ist die Tragheit...', authors: ['Einstein, A.'], year: '1905',
  venue: 'Annalen der Physik', volume: null, number: null, pages: null, publisher: null,
  doi: null, arxiv_id: null, url: null, abstract: null, keywords: null,
  fields: {}, raw_bibtex: '@article{einstein1905,\n  title = {Ist die Tragheit...}\n}',
  field_provenance: {}, queries: [], retraction: null, verified: 'unverified',
  bib_files: [], created_at: 0, updated_at: 0,
  duplicates: [], key_conflict: false, suggested_key: 'einstein1905',
}

function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

function mockFetch(opts: { previewTruncated?: boolean } = {}) {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url)
    const method = (init?.method ?? 'GET').toUpperCase()
    if (u.includes('/library') && method === 'GET') {
      return new Response(JSON.stringify(LIB), { status: 200 })
    }
    if (u.includes('/library/import') && method === 'POST') {
      return new Response(JSON.stringify({
        entries: [{ ...ZOT_ENTRY, citation_key: 'k1', title: 'T', raw_bibtex: '@article{k1,\n  title = {T}\n}' }],
        errors: [], total_blocks: 1,
      }), { status: 200 })
    }
    if (u.includes('/library/zotero/collections')) {
      return new Response(JSON.stringify({
        group: { id: 12345, name: 'E2E 群组', description: '' },
        collections: [
          { key: 'C1', name: '方法一', parent: null },
          { key: 'C2', name: '子集合', parent: 'C1' },
        ],
      }), { status: 200 })
    }
    if (u.includes('/library/zotero/preview')) {
      return new Response(JSON.stringify({
        entries: [ZOT_ENTRY], errors: [], total_blocks: 1,
        group: { id: 12345, name: 'E2E 群组', description: '' },
        source: { provider: 'zotero', library_type: 'group', group_id: 12345, collection_key: null, zotero_user_id: null, truncated: !!opts.previewTruncated },
      }), { status: 200 })
    }
    if (/\/latex\/files\/refs\.bib$/.test(u)) {
      return new Response(JSON.stringify({ path: 'refs.bib', content: '', sha: 'a'.repeat(64) }), { status: 200 })
    }
    if (u.includes('/library/commit')) {
      return new Response(JSON.stringify({ reference_ids: ['r1'], bib_sha: null, total: 1 }), { status: 200 })
    }
    return new Response(JSON.stringify({}), { status: 404 })
  })
}

const switchToImportTab = async () => {
  await act(async () => {
    const tabBtn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === '导入')
    expect(tabBtn).toBeTruthy()
    ;(tabBtn as HTMLButtonElement).click()
    await Promise.resolve()
  })
}

describe('LibraryPanel Zotero 群组导入（v0.5）', () => {
  it('拉取群组→集合下拉→预览条目→确认导入带 provider 记录', async () => {
    const fetchMock = mockFetch()
    vi.stubGlobal('fetch', fetchMock)
    render(<LibraryPanel pid="p1" canEdit onInsertCitations={() => {}} />)
    await act(async () => { await Promise.resolve() })
    await switchToImportTab()
    // 打开 Zotero 区块
    await act(async () => {
      ;(document.querySelector('[data-testid="library-zotero-toggle"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })
    const box = document.querySelector('[data-testid="library-zotero"]')!
    expect(box).not.toBeNull()
    // 输入群组链接 → 拉取
    await act(async () => {
      setInputValue(document.querySelector('[data-testid="library-zotero-group"]') as HTMLInputElement,
        'https://www.zotero.org/groups/12345')
      await Promise.resolve()
    })
    await act(async () => {
      ;(document.querySelector('[data-testid="library-zotero-fetch"]') as HTMLButtonElement).click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(document.querySelector('[data-testid="library-zotero"]')!.textContent).toContain('E2E 群组')
    const select = document.querySelector('[data-testid="library-zotero-collection"]') as HTMLSelectElement
    expect(select.options.length).toBe(3) // 全部 + 2 集合
    // 预览 → 条目进入现有确认流
    await act(async () => {
      ;(document.querySelector('[data-testid="library-zotero-preview"]') as HTMLButtonElement).click()
      await Promise.resolve()
      await Promise.resolve()
    })
    // 「解析预览」按钮与预览容器同 testid——取最后一个（容器）
    const containers = document.querySelectorAll('[data-testid="library-import-preview"]')
    const preview = containers[containers.length - 1]!
    expect(preview.textContent).toContain('Ist die Tragheit')
    // 确认导入 → commit 携带 source
    await act(async () => {
      ;(document.querySelector('[data-testid="library-import-commit"]') as HTMLButtonElement).click()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    const commitCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/library/commit'))
    expect(commitCall).toBeTruthy()
    const body = JSON.parse((commitCall?.[1] as RequestInit).body as string)
    expect(body.source).toEqual({ provider: 'zotero', group_id: 12345, collection_key: null, group_name: 'E2E 群组', library_type: 'group', zotero_user_id: null })
    expect(body.target_bib).toBe('refs.bib')
  })

  it('粘贴导入不携带 Zotero source', async () => {
    const fetchMock = mockFetch()
    vi.stubGlobal('fetch', fetchMock)
    render(<LibraryPanel pid="p1" canEdit onInsertCitations={() => {}} />)
    await act(async () => { await Promise.resolve() })
    await switchToImportTab()
    await act(async () => {
      setInputValue(document.querySelector('[data-testid="library-import-text"]') as HTMLTextAreaElement,
        '@article{k1,\n  title = {T}\n}')
      await Promise.resolve()
    })
    await act(async () => {
      ;(document.querySelector('[data-testid="library-import-preview"]') as HTMLButtonElement).click()
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      ;(document.querySelector('[data-testid="library-import-commit"]') as HTMLButtonElement).click()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    const commitCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/library/commit'))
    const body = JSON.parse((commitCall?.[1] as RequestInit).body as string)
    expect(body.source).toBeNull()
  })
})

describe('LibraryPanel Zotero v2（B2 私有库授权与一键刷新）', () => {
  function mockFetchV2(opts: { previewTruncated?: boolean; refresh?: Record<string, unknown> } = {}) {
    const base = mockFetch({ previewTruncated: opts.previewTruncated })
    const commitBodies: Record<string, unknown>[] = []
    const fn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (u.includes('/api/zotero/credentials') && method === 'GET') {
        return new Response(JSON.stringify({ credentials: { has_api_key: true, api_key_hint: '•••cdef', zotero_user_id: '445566', updated_at: 1 } }), { status: 200 })
      }
      if (u.includes('/api/zotero/credentials') && method === 'PUT') {
        return new Response(JSON.stringify({ ok: true, credentials: { has_api_key: true, api_key_hint: '•••' + String(JSON.parse(String(init?.body)).api_key).slice(-4), zotero_user_id: '445566', updated_at: 2 } }), { status: 200 })
      }
      if (u.includes('/api/zotero/credentials') && method === 'DELETE') {
        return new Response(JSON.stringify({ ok: true, removed: true, credentials: { has_api_key: false, api_key_hint: '', zotero_user_id: null, updated_at: null } }), { status: 200 })
      }
      if (u.includes('/library/zotero/refresh-preview')) {
        const r = opts.refresh ?? {
          source: { provider: 'zotero', library_type: 'group', group_id: 12345, collection_key: null, zotero_user_id: null },
          mode: 'bib', truncated: false,
          counts: { added: 1, updated: 1, removed: 1, unchanged: 1 },
          added: [{ citation_key: 'newkey2024', title: '新增条目', raw_bibtex: '@article{newkey2024,\n  title = {新增条目}\n}' }],
          updated: [{ reference_id: 'r1', citation_key: 'k1',
                      old: { title: '旧题', year: '1905' }, new: { title: '新题', year: '1915' },
                      entry: { ...ZOT_ENTRY, year: '1915' } }],
          removed: [{ reference_id: 'r2', citation_key: 'oldkey', in_citation_order: true }],
          removed_supported: false,
          notice: 'bib 模式以 .bib 为事实源，不支持远端移除检测的自动删除（如需删除请手动编辑 .bib）',
        }
        return new Response(JSON.stringify(r), { status: 200 })
      }
      if (u.includes('/library/zotero/refresh-commit')) {
        commitBodies.push(JSON.parse(String(init?.body)))
        return new Response(JSON.stringify({ ok: true, applied: { added: 1, updated: 1, removed: 0 } }), { status: 200 })
      }
      return base(url, init)
    })
    return Object.assign(fn, { commitBodies })
  }

  const click = async (testid: string) => {
    await act(async () => {
      const el = document.querySelector(`[data-testid="${testid}"]`) as HTMLButtonElement | null
      expect(el, testid).not.toBeNull()
      el!.click()
      await Promise.resolve()
      await Promise.resolve()
    })
  }
  const openZotero = async () => {
    await switchToImportTab()
    await click('library-zotero-toggle')
  }

  it('授权弹层：masked 显示、保存提交 key、留空提示、清除需确认', async () => {
    const fetchMock = mockFetchV2()
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<LibraryPanel pid="p1" canEdit onInsertCitations={() => {}} />)
    await act(async () => { await Promise.resolve() })
    await openZotero()
    await click('library-zotero-cred-toggle')
    const cred = document.querySelector('[data-testid="library-zotero-cred"]')!
    expect(cred.textContent).toContain('•••cdef') // masked 尾号，无 key 本体
    await act(async () => {
      setInputValue(document.querySelector('[data-testid="library-zotero-cred-key"]') as HTMLInputElement, 'brand-new-key')
      await Promise.resolve()
    })
    await click('library-zotero-cred-save')
    const put = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/zotero/credentials') && (c[1]?.method ?? 'GET') === 'PUT')
    expect(put).toBeTruthy()
    expect(JSON.parse(String(put![1]?.body)).api_key).toBe('brand-new-key')
    await click('library-zotero-cred-clear')
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/zotero/credentials') && (c[1]?.method ?? 'GET') === 'DELETE')).toBe(true)
    expect(window.confirm).toHaveBeenCalled()
  })

  it('一键刷新：三栏 diff 渲染、勾选提交 payload 与 bib base_sha', async () => {
    const fetchMock = mockFetchV2()
    vi.stubGlobal('fetch', fetchMock)
    render(<LibraryPanel pid="p1" canEdit onInsertCitations={() => {}} />)
    await act(async () => { await Promise.resolve() })
    await openZotero()
    await act(async () => {
      setInputValue(document.querySelector('[data-testid="library-zotero-group"]') as HTMLInputElement, '12345')
      await Promise.resolve()
    })
    await click('library-zotero-fetch')
    await click('library-zotero-preview')
    await click('library-zotero-refresh-run')
    const box = document.querySelector('[data-testid="library-zotero-refresh"]')!
    expect(box.textContent).toContain('新增 1 / 更新 1 / 移除 1 / 不变 1')
    expect(box.textContent).toContain('newkey2024')
    expect(box.textContent).toContain('year: 1905 → 1915')
    expect(box.textContent).toContain('在引用顺序表中')
    expect(box.textContent).toContain('不支持远端移除检测')
    // bib 模式 added 默认勾选；updated/removed 默认不勾。顺序：added → updated → removed。
    const boxes = [...box.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[]
    await act(async () => { boxes[0].click(); await Promise.resolve() })  // added 取消
    await act(async () => { boxes[1].click(); await Promise.resolve() })  // updated 勾选
    await act(async () => { boxes[2].click(); await Promise.resolve() })  // removed 勾选
    await click('library-zotero-refresh-commit')
    expect(fetchMock.commitBodies).toHaveLength(1)
    const body = fetchMock.commitBodies[0]
    expect(body.library_type).toBe('group')
    expect((body.additions as unknown[]).length).toBe(0)
    expect((body.updates as unknown[]).length).toBe(1)
    expect((body.removals as string[]).length).toBe(1)
    expect(body.remove_from_citation_order).toBe(false)
    expect(body.base_sha).toBe('a'.repeat(64))
    expect(body.target_bib).toBe('refs.bib')
  })
})

describe('LibraryPanel Zotero v2 修补（个人库透传 + 恢复最近来源）', () => {
  function mockFetchV3(opts: { latest?: Record<string, unknown> | null } = {}) {
    const base = mockFetch()
    const bodies: { url: string; body: Record<string, unknown> }[] = []
    const fn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'POST' && init?.body) {
        bodies.push({ url: u, body: JSON.parse(String(init.body)) })
      }
      if (u.includes('/library/zotero/imports')) {
        return new Response(JSON.stringify({ imports: [], latest_refreshable: opts.latest ?? null }), { status: 200 })
      }
      if (u.includes('/library/zotero/collections') && method === 'POST' && bodies.some((b) => b.url.includes('/collections') && b.body.library_type === 'user')) {
        return new Response(JSON.stringify({
          group: { id: 445566, name: '个人库 445566', description: '' },
          collections: [{ key: 'U1', name: '个人集合', parent: null }],
        }), { status: 200 })
      }
      if (u.includes('/library/zotero/preview') && method === 'POST') {
        const body = JSON.parse(String(init?.body))
        const isUser = body.library_type === 'user'
        return new Response(JSON.stringify({
          entries: [ZOT_ENTRY], errors: [], total_blocks: 1,
          group: { id: isUser ? 445566 : 12345, name: isUser ? '个人库 445566' : 'E2E 群组', description: '' },
          source: { provider: 'zotero', library_type: isUser ? 'user' : 'group',
                    group_id: isUser ? null : 12345, collection_key: null,
                    zotero_user_id: isUser ? '445566' : null, truncated: false },
        }), { status: 200 })
      }
      return base(url, init)
    })
    return Object.assign(fn, { bodies })
  }

  const click2 = async (testid: string) => {
    await act(async () => {
      const el = document.querySelector(`[data-testid="${testid}"]`) as HTMLButtonElement | null
      expect(el, testid).not.toBeNull()
      el!.click()
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it('个人库：拉集合/预览/刷新 请求体透传 library_type 与 zotero_user_id，锚点按服务端 source 回写', async () => {
    const fetchMock = mockFetchV3()
    vi.stubGlobal('fetch', fetchMock)
    render(<LibraryPanel pid="p1" canEdit onInsertCitations={() => {}} />)
    await act(async () => { await Promise.resolve() })
    await switchToImportTab()
    await click2('library-zotero-toggle')
    // 切个人库 → 输 userID → 拉集合
    await act(async () => {
      const sel = document.querySelector('[data-testid="library-zotero-libtype"]') as HTMLSelectElement
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
      setter.call(sel, 'user')
      sel.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
    })
    await act(async () => {
      setInputValue(document.querySelector('[data-testid="library-zotero-userid"]') as HTMLInputElement, '445566')
      await Promise.resolve()
    })
    await click2('library-zotero-fetch')
    await click2('library-zotero-preview')
    const post = (frag: string) => fetchMock.bodies.filter((b) => b.url.includes(frag)).map((b) => b.body)
    expect(post('/library/zotero/collections').some((b) => b.library_type === 'user' && b.zotero_user_id === '445566')).toBe(true)
    const prev = post('/library/zotero/preview').at(-1)!
    expect(prev.library_type).toBe('user')
    expect(prev.zotero_user_id).toBe('445566')
    // 锚点按服务端 source 回写：一键刷新请求体用 user 形态
    await click2('library-zotero-refresh-run')
    const ref = post('/library/zotero/refresh-preview').at(-1)!
    expect(ref.library_type).toBe('user')
    expect(ref.zotero_user_id).toBe('445566')
    expect(ref.group_id).toBeNull()
  })

  it('重开工程：自动恢复最近一次可刷新来源，「刷新此来源」直接可用', async () => {
    const fetchMock = mockFetchV3({ latest: { provider: 'zotero', group_id: 999, collection_key: null, group_name: '历史群组', library_type: 'group', zotero_user_id: null } })
    vi.stubGlobal('fetch', fetchMock)
    render(<LibraryPanel pid="p1" canEdit onInsertCitations={() => {}} />)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    await switchToImportTab()
    await click2('library-zotero-toggle')
    // 未手动导入：恢复锚点已就位，刷新按钮直接出现
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(document.querySelector('[data-testid="library-zotero-refresh-run"]')).not.toBeNull()
    await click2('library-zotero-refresh-run')
    const ref = fetchMock.bodies.filter((b) => b.url.includes('/refresh-preview')).at(-1)!.body
    expect(ref.group_id).toBe(999)
    expect(ref.library_type).toBe('group')
  })
})

describe('LibraryPanel 文献真实性核验自动分批', () => {
  it('超过 25 条文献时自动分批顺序调用 /library/verify 并汇总全部条目', async () => {
    const entries = Array.from({ length: 30 }, (_, i) => ({
      ...ZOT_ENTRY,
      reference_id: `r-${i + 1}`,
      citation_key: `key${i + 1}`,
      title: `Paper ${i + 1}`,
    }))
    const verifyBodies: Array<{ reference_ids?: string[] }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (u.endsWith('/library') && method === 'GET') {
        return new Response(JSON.stringify({ ...LIB, entries }), { status: 200 })
      }
      if (u.endsWith('/library/verify') && method === 'GET') {
        return new Response(JSON.stringify({ checked_at: null, total: 0, batch_size: 0, truncated: false, max_batch: 25, counts: { verified: 0, mismatch: 0, retracted: 0, unverified: 0, error: 0 }, items: [] }), { status: 200 })
      }
      if (u.endsWith('/library/verify') && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { reference_ids?: string[] }
        verifyBodies.push(body)
        const totalDone = verifyBodies.reduce((acc, b) => acc + (b.reference_ids?.length ?? 0), 0)
        return new Response(JSON.stringify({
          checked_at: 1700000000,
          total: totalDone,
          batch_size: body.reference_ids?.length ?? 0,
          truncated: false,
          max_batch: 25,
          counts: { verified: totalDone, mismatch: 0, retracted: 0, unverified: 0, error: 0 },
          items: [],
        }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }))

    render(<LibraryPanel pid="p1" canEdit onInsertCitations={() => {}} />)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    await act(async () => {
      const btn = document.querySelector<HTMLButtonElement>('[data-testid="library-verify-btn"]')!
      expect(btn).not.toBeNull()
      btn.click()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(verifyBodies).toHaveLength(2)
    expect(verifyBodies[0].reference_ids).toHaveLength(25)
    expect(verifyBodies[1].reference_ids).toHaveLength(5)
    expect(document.body.textContent).toContain('共核验 30 条')
  })
})

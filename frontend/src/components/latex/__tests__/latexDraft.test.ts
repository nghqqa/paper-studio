// latexDraft 草稿存储的隔离/丢弃/失败测试（任务书 §四）。
import { beforeEach, describe, expect, it } from 'vitest'
import { createDraftStore, draftKey } from '../latexDraft'

/** 内存 Storage：可注入故障 */
function memStorage(opts: { failSet?: boolean } = {}): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => map.delete(k),
    setItem: (k, v) => {
      if (opts.failSet) throw new DOMException('quota', 'QuotaExceededError')
      map.set(k, String(v))
    },
  } as Storage
}

let storage: Storage
let store: ReturnType<typeof createDraftStore>
beforeEach(() => {
  storage = memStorage()
  store = createDraftStore(storage)
})

describe('draftKey 隔离', () => {
  it('不同用户/项目/文件键互不相同', () => {
    const a = draftKey('u:a@x', 'pid1', 'main.tex')
    const b = draftKey('u:b@x', 'pid1', 'main.tex')
    const c = draftKey('u:a@x', 'pid2', 'main.tex')
    const e = draftKey('u:a@x', 'pid1', 'notes.tex')
    expect(new Set([a, b, c, e]).size).toBe(4)
  })
})

describe('存取与内容一致性', () => {
  it('save/load 往返；服务器同内容时 removeDraft 静默清理', () => {
    store.saveDraft('anon', 'p1', 'main.tex', 'draft text', 'sha-0')
    const d = store.loadDraft('anon', 'p1', 'main.tex')
    expect(d?.content).toBe('draft text')
    expect(d?.serverSha).toBe('sha-0')
    expect(d?.v).toBe(1)
    // 服务器已保存相同内容 → remove，不再提示恢复
    store.removeDraft('anon', 'p1', 'main.tex')
    expect(store.loadDraft('anon', 'p1', 'main.tex')).toBeNull()
  })

  it('多文件/多项目草稿不串写', () => {
    store.saveDraft('anon', 'p1', 'main.tex', 'p1-main', null)
    store.saveDraft('anon', 'p1', 'notes.tex', 'p1-notes', null)
    store.saveDraft('u:other', 'p1', 'main.tex', 'other-user', null)
    expect(store.loadDraft('anon', 'p1', 'main.tex')?.content).toBe('p1-main')
    expect(store.loadDraft('anon', 'p1', 'notes.tex')?.content).toBe('p1-notes')
    expect(store.loadDraft('u:other', 'p1', 'main.tex')?.content).toBe('other-user')
    // 移除其一不影响其他
    store.removeDraft('anon', 'p1', 'main.tex')
    expect(store.loadDraft('anon', 'p1', 'notes.tex')?.content).toBe('p1-notes')
    expect(store.loadDraft('u:other', 'p1', 'main.tex')?.content).toBe('other-user')
  })
})

describe('丢弃保护', () => {
  it('markDiscarded 后写入被忽略；markEdited 后恢复写入', () => {
    store.saveDraft('anon', 'p1', 'a.tex', 'old', null)
    store.markDiscarded('anon', 'p1', 'a.tex')
    // 旧异步任务晚到写入：被忽略
    expect(store.saveDraft('anon', 'p1', 'a.tex', 'late write', null)).toBe(false)
    expect(store.loadDraft('anon', 'p1', 'a.tex')).toBeNull()
    // 新的真实编辑：解除丢弃
    store.markEdited('anon', 'p1', 'a.tex')
    expect(store.saveDraft('anon', 'p1', 'a.tex', 'new edit', null)).toBe(true)
    expect(store.loadDraft('anon', 'p1', 'a.tex')?.content).toBe('new edit')
  })

  it('丢弃名单按 key 隔离：不误伤其他文件', () => {
    store.saveDraft('anon', 'p1', 'a.tex', 'a', null)
    store.saveDraft('anon', 'p1', 'b.tex', 'b', null)
    store.markDiscarded('anon', 'p1', 'a.tex')
    expect(store.saveDraft('anon', 'p1', 'b.tex', 'b2', null)).toBe(true)
  })
})

describe('存储失败', () => {
  it('写入抛错 → saveDraft 返回 false 且不抛出', () => {
    const failing = createDraftStore(memStorage({ failSet: true }))
    expect(failing.available()).toBe(false)
    expect(failing.saveDraft('anon', 'p1', 'a.tex', 'x', null)).toBe(false)
    expect(failing.loadDraft('anon', 'p1', 'a.tex')).toBeNull()
  })
  it('storage 为 null（禁用）时同样静默', () => {
    const disabled = createDraftStore(null)
    expect(disabled.available()).toBe(false)
    expect(disabled.saveDraft('anon', 'p1', 'a.tex', 'x', null)).toBe(false)
    expect(disabled.loadDraft('anon', 'p1', 'a.tex')).toBeNull()
  })
  it('损坏的草稿记录按不存在处理', () => {
    storage.setItem(draftKey('anon', 'p1', 'bad.tex'), '{not-json')
    expect(store.loadDraft('anon', 'p1', 'bad.tex')).toBeNull()
  })
})

describe('旧保存响应不删新草稿（controller 契约）', () => {
  it('onSaved 携带 contentAtSend：调用方仅在内容一致时移除草稿', async () => {
    const { SaveBuildController } = await import('../saveBuild')
    let onSavedArgs: Array<[string, string, string]> = []
    const ctrl = new SaveBuildController(
      {
        save: (_path, content, base) => {
          void base
          return Promise.resolve({ sha: `sha-${content}` })
        },
        reload: () => Promise.reject(new Error('n/a')),
        build: () => Promise.reject(new Error('n/a')),
        isConflict: () => false,
        isForbidden: () => false,
        message: (e) => String(e),
        schedule: () => () => {},
        onBuildResult: () => {},
      },
      {
        onSaved: (path, sha, contentAtSend) => onSavedArgs.push([path, sha, contentAtSend]),
      },
    )
    ctrl.open('main.tex', 'server version', 'sha-0')
    // 编辑两次，只有最后一次停顿触发保存
    ctrl.edit('v1')
    ctrl.edit('v2 latest')
    await ctrl.saveNow()
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    // 保存发出的是最后一次内容（E2E 事故回归），contentAtSend 供调用方做「内容一致才删草稿」判定
    expect(onSavedArgs).toEqual([['main.tex', 'sha-v2 latest', 'v2 latest']])
  })
})

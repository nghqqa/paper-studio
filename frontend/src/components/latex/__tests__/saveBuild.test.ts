// saveBuild 调度核心的竞态测试：延迟与返回顺序完全可控（任务书 §四）。
//
// 覆盖：保存中再次编辑 / 保存中切换文件 / 409 冲突 / 保存失败 / 编译中继续编辑 /
// 旧响应与单飞 / 失败后修复 / 停顿自动保存与自动编译开关联动。
// 测试直接驱动 controller（headless），用户可观察行为经 snapshot 与依赖调用参数断言。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SaveBuildController, type BuildResultLike, type SaveBuildDeps } from '../saveBuild'

function makeDeps() {
  const calls: { save: Array<{ path: string; content: string; base: string | null }>; build: string[] } = {
    save: [],
    build: [],
  }
  const idleTasks: Array<{ fn: () => void; cancelled: boolean }> = []
  const deps: SaveBuildDeps = {
    save: vi.fn((path: string, content: string, base: string | null) => {
      calls.save.push({ path, content, base })
      const sha = `sha-${calls.save.length}`
      return Promise.resolve({ sha })
    }),
    reload: vi.fn((path: string) => Promise.resolve({ content: `server ${path}`, sha: 'sha-server' })),
    build: vi.fn((engine: string) => {
      calls.build.push(engine)
      return Promise.resolve({ buildId: `b${calls.build.length}`, status: 'ok' as const, durationMs: 1 })
    }),
    isConflict: (e: unknown) => (e as { conflict?: boolean })?.conflict === true,
    isForbidden: (e: unknown) => (e as { forbidden?: boolean })?.forbidden === true,
    message: (e: unknown) => (e as { message?: string })?.message ?? String(e),
    schedule: (fn: () => void) => {
      const task = { fn, cancelled: false }
      idleTasks.push(task)
      return () => {
        task.cancelled = true
      }
    },
    onBuildResult: vi.fn(),
  }
  return { deps, calls, idleTasks }
}

function flushMicrotasks() {
  // async 链（deps.then → runSave 的 await → chain/pump）有多层 await，多轮宏任务确保跑完
  return new Promise((r) => setTimeout(r, 0)).then(() => new Promise((r) => setTimeout(r, 0))).then(() => new Promise((r) => setTimeout(r, 0)))
}

describe('SaveBuildController', () => {
  let d: ReturnType<typeof makeDeps>
  let ctrl: SaveBuildController
  let snap: ReturnType<SaveBuildController['snapshot']>

  beforeEach(() => {
    d = makeDeps()
    ctrl = new SaveBuildController(d.deps)
    ctrl.subscribe((s) => {
      snap = s
    })
    ctrl.open('main.tex', 'hello', 'sha-0')
  })

  async function editAndSettle(text: string) {
    ctrl.edit(text)
    await flushMicrotasks()
    // 触发停顿任务
    for (const t of d.idleTasks) if (!t.cancelled) t.fn()
    await flushMicrotasks()
  }

  it('停顿后自动保存；自动编译开启时接着编译', async () => {
    await editAndSettle('v1')
    expect(d.calls.save).toEqual([{ path: 'main.tex', content: 'v1', base: 'sha-0' }])
    expect(d.calls.build).toEqual(['pdflatex'])
    expect(snap.dirty).toBe(false)
    expect(snap.notice).toBe('已保存 main.tex')
  })

  it('自动编译关闭：停顿后仍自动保存，但不编译', async () => {
    ctrl.setAutoBuild(false)
    await editAndSettle('v1')
    expect(d.calls.save).toHaveLength(1)
    expect(d.calls.build).toHaveLength(0)
    expect(snap.dirty).toBe(false)
  })

  it('保存飞行中继续编辑：不把新输入标为已保存，并自动补一次保存', async () => {
    const pending: Array<(v: { sha: string }) => void> = []
    d.deps.save = vi.fn((path: string, content: string, base: string | null) => {
      d.calls.save.push({ path, content, base })
      return new Promise<{ sha: string }>((res) => {
        pending.push(res)
      })
    })
    ctrl.edit('v1')
    // 触发停顿：保存发出并挂起
    const firstIdle = d.idleTasks.filter((t) => !t.cancelled)
    for (const t of firstIdle) t.fn()
    await flushMicrotasks()
    expect(d.calls.save).toHaveLength(1)
    // 保存飞行中继续输入
    ctrl.edit('v1 + more typing')
    expect(snap.dirty).toBe(true)
    // 第一个保存返回（服务器已存 v1）
    pending.shift()!({ sha: 'sha-saved-v1' })
    await flushMicrotasks()
    // 新输入必须仍为脏：绝不能标为已保存
    expect(snap.dirty).toBe(true)
    expect(snap.saving).toBe(false)
    // 且重新排了停顿 → 第二次保存带最新内容与最新 base
    const rescheduled = d.idleTasks.filter((t) => !t.cancelled)
    expect(rescheduled.length).toBeGreaterThan(0)
    for (const t of rescheduled) t.fn()
    await flushMicrotasks()
    expect(d.calls.save[1]).toEqual({ path: 'main.tex', content: 'v1 + more typing', base: 'sha-saved-v1' })
    // 第二次保存完成 → 脏清除
    pending.shift()!({ sha: 'sha-saved-v2' })
    await flushMicrotasks()
    expect(snap.dirty).toBe(false)
  })

  it('保存飞行中切换文件：旧响应丢弃，不污染新文件 base', async () => {
    let release!: (v: { sha: string }) => void
    d.deps.save = vi.fn((path: string, content: string, base: string | null) => {
      d.calls.save.push({ path, content, base })
      return new Promise<{ sha: string }>((res) => {
        release = res
      })
    })
    ctrl.edit('A content')
    for (const t of d.idleTasks) if (!t.cancelled) t.fn()
    await flushMicrotasks()
    expect(d.calls.save[0].path).toBe('main.tex')
    // A 保存飞行中切到 B
    ctrl.open('second.tex', 'B original', 'sha-B0')
    await flushMicrotasks()
    // A 的响应此刻才到达：必须整体丢弃
    release({ sha: 'sha-A-saved' })
    await flushMicrotasks()
    expect(snap.path).toBe('second.tex')
    expect(snap.dirty).toBe(false)
    // 保存 B：base 必须是 B 自己的 sha，而非 A 的响应
    await editAndSettle('B edited')
    expect(d.calls.save[1]).toEqual({ path: 'second.tex', content: 'B edited', base: 'sha-B0' })
  })

  it('单飞：保存飞行中再次请求只排队，完成后按需补一次', async () => {
    let release!: (v: { sha: string }) => void
    d.deps.save = vi.fn((path: string, content: string, base: string | null) => {
      d.calls.save.push({ path, content, base })
      return new Promise<{ sha: string }>((res) => {
        release = res
      })
    })
    ctrl.edit('v1')
    for (const t of d.idleTasks) if (!t.cancelled) t.fn()
    await flushMicrotasks()
    expect(snap.saving).toBe(true)
    // 飞行中手动保存 + 又编辑：都只排队
    ctrl.saveNow()
    ctrl.edit('v1 more')
    expect(d.calls.save).toHaveLength(1)
    release({ sha: 'sha-v1' })
    await flushMicrotasks()
    // 队列补存：最新内容、最新 base
    expect(d.calls.save[1]).toEqual({ path: 'main.tex', content: 'v1 more', base: 'sha-v1' })
    expect(d.calls.save).toHaveLength(2)
  })

  it('409 冲突：进入暂停态、保留本地内容、不再自动保存；覆盖服务器可恢复', async () => {
    d.deps.save = vi.fn((path: string, content: string, base: string | null) => {
      d.calls.save.push({ path, content, base })
      if (d.calls.save.length === 1) {
        return Promise.reject({ conflict: true, message: 'stale' })
      }
      return Promise.resolve({ sha: `sha-${d.calls.save.length}` })
    })
    await editAndSettle('local edit')
    expect(snap.conflict).toBe(true)
    expect(snap.dirty).toBe(true)
    expect(ctrl.getContent()).toBe('local edit') // 本地内容保留
    expect(snap.error).toContain('已被其他会话修改')
    // 再编辑：不触发自动保存（冲突暂停），也不无限重试
    const before = d.calls.save.length
    await editAndSettle('local edit v2')
    expect(d.calls.save.length).toBe(before)
    expect(ctrl.getContent()).toBe('local edit v2')
    // 用户选择覆盖服务器：base 置空保存成功，冲突解除
    ctrl.resolveOverwrite()
    await flushMicrotasks()
    expect(snap.conflict).toBe(false)
    expect(d.calls.save.at(-1)).toEqual({ path: 'main.tex', content: 'local edit v2', base: null })
    expect(snap.dirty).toBe(false)
  })

  it('409 冲突：放弃本地 → 加载服务器版本', async () => {
    d.deps.save = vi.fn(() => Promise.reject({ conflict: true, message: 'stale' }))
    await editAndSettle('local')
    expect(snap.conflict).toBe(true)
    const loaded = await ctrl.resolveReload()
    expect(loaded).toEqual({ content: 'server main.tex', sha: 'sha-server' })
    expect(snap.conflict).toBe(false)
    expect(ctrl.getContent()).toBe('server main.tex')
    expect(snap.dirty).toBe(false)
  })

  it('保存失败（网络）：保留 dirty 与错误，不自动重试；下次编辑停顿再试成功', async () => {
    d.deps.save = vi.fn((path: string, content: string, base: string | null) => {
      d.calls.save.push({ path, content, base })
      if (d.calls.save.length === 1) return Promise.reject(new Error('network down'))
      return Promise.resolve({ sha: 'sha-2' })
    })
    await editAndSettle('v1')
    expect(snap.error).toContain('network down')
    expect(snap.dirty).toBe(true)
    expect(snap.conflict).toBe(false)
    // 不自动重试：无新编辑就没有新请求
    const before = d.calls.save.length
    await flushMicrotasks()
    expect(d.calls.save.length).toBe(before)
    // 再次编辑停顿 → 重试成功 → error 清除
    await editAndSettle('v1 fixed')
    expect(snap.error).toBeNull()
    expect(snap.dirty).toBe(false)
  })

  it('保存失败时编译被阻止：不得把未保存内容当成编译输入', async () => {
    d.deps.save = vi.fn(() => Promise.reject(new Error('network down')))
    await editAndSettle('unsaved change')
    expect(snap.dirty).toBe(true)
    const buildsBefore = d.calls.build.length
    ctrl.buildNow()
    await flushMicrotasks()
    // 保存失败 → 不发编译请求
    expect(d.calls.build.length).toBe(buildsBefore)
    expect(snap.error).toBeTruthy()
  })

  it('编译期间继续编辑：保存完成后自动补编译最新版本', async () => {
    const pendingBuilds: Array<(v: { buildId: string; status: 'ok'; durationMs: number }) => void> = []
    d.deps.build = vi.fn(
      (engine: string) =>
        new Promise<{ buildId: string; status: 'ok'; durationMs: number }>((res) => {
          d.calls.build.push(engine)
          pendingBuilds.push(res)
        }),
    )
    await editAndSettle('v1') // 第一次编译启动并挂起
    expect(snap.building).toBe(true)
    // 编译期间继续编辑 → 停顿自动保存（编译不阻塞保存）
    ctrl.edit('v2 during build')
    await flushMicrotasks()
    const idle = d.idleTasks.filter((t) => !t.cancelled)
    for (const t of idle) t.fn()
    await flushMicrotasks()
    expect(d.calls.save.at(-1)?.content).toBe('v2 during build')
    // 编译结束：检测到已保存的新版本 → 自动补编译最新版
    pendingBuilds.shift()!({ buildId: 'b1', status: 'ok', durationMs: 1 })
    await flushMicrotasks()
    expect(d.calls.build.length).toBe(2)
    // 补编译在飞：resolve 后结束
    pendingBuilds.shift()!({ buildId: 'b2', status: 'ok', durationMs: 1 })
    await flushMicrotasks()
    expect(snap.building).toBe(false)
  })

  it('403 权限失效：暂停自动保存、本地内容保留；显式保存重试，成功后恢复', async () => {
    let mode: 'forbidden' | 'ok' = 'forbidden'
    d.deps.save = vi.fn((path: string, content: string, base: string | null) => {
      d.calls.save.push({ path, content, base })
      if (mode === 'forbidden') {
        const err = new Error('forbidden') as Error & { forbidden: boolean }
        err.forbidden = true
        return Promise.reject(err)
      }
      return Promise.resolve({ sha: 'sha-ok' })
    })
    await editAndSettle('v1')
    // 403 → permLost：错误提示、dirty 保留、不再自动重试
    expect(snap.permLost).toBe(true)
    expect(snap.dirty).toBe(true)
    expect(snap.error).toContain('写入权限')
    const before = d.calls.save.length
    await editAndSettle('v1 more')
    expect(d.calls.save.length).toBe(before) // 自动链暂停
    expect(ctrl.getContent()).toBe('v1 more') // 本地内容保留
    // 权限恢复后显式保存 → 成功并解除
    mode = 'ok'
    ctrl.saveNow()
    await flushMicrotasks()
    await flushMicrotasks()
    expect(snap.permLost).toBe(false)
    expect(snap.dirty).toBe(false)
  })

  it('失败后修复：错误清除、恢复自动链', async () => {
    let failNext = true
    d.deps.build = vi.fn((engine: string) => {
      d.calls.build.push(engine)
      if (failNext) {
        failNext = false
        return Promise.reject(new Error('latexmk boom'))
      }
      return Promise.resolve({ buildId: 'b-ok', status: 'ok' as const, durationMs: 1 })
    })
    await editAndSettle('v1')
    expect(snap.error).toContain('latexmk boom')
    // 修复内容 → 停顿 → 保存+编译成功 → 错误清除
    await editAndSettle('v1 fixed')
    expect(snap.error).toBeNull()
    expect(snap.dirty).toBe(false)
  })

  it('取消编译：调用 cancelBuild 依赖；canceled 结果不触发补编译', async () => {
    const cancelCalls: number[] = []
    d.deps.cancelBuild = vi.fn(() => {
      cancelCalls.push(1)
      return Promise.resolve({ ok: true })
    })
    d.deps.build = vi.fn((engine: string) => {
      d.calls.build.push(engine)
      return new Promise<BuildResultLike>((resolve) => {
        // 模拟服务端被取消：稍后以 canceled 结果返回
        setTimeout(() => resolve({ buildId: 'b-c', status: 'canceled' as const, durationMs: 5 }), 0)
      })
    })
    ctrl.buildNow()
    expect(snap.building).toBe(true)
    ctrl.cancelBuild()
    expect(cancelCalls).toHaveLength(1)
    await flushMicrotasks()
    expect(snap.building).toBe(false)
    expect(snap.error).toBeNull()
    expect(d.deps.onBuildResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'canceled' }),
    )
    // 取消后无补编译（buildAfterSave 已被清除）；build 仅启动过这一次
    await flushMicrotasks()
    expect(d.calls.build).toEqual(['pdflatex'])
    // 未在编译时取消是 no-op
    ctrl.cancelBuild()
    expect(cancelCalls).toHaveLength(1)
  })

  it('取消编译：cancelBuild 依赖失败 → 错误上报，building 保持', async () => {
    d.deps.cancelBuild = vi.fn(() => Promise.reject(new Error('cancel boom')))
    let resolveBuild: ((r: BuildResultLike) => void) | undefined
    d.deps.build = vi.fn(
      () =>
        new Promise<BuildResultLike>((resolve) => {
          resolveBuild = resolve
        }),
    )
    ctrl.buildNow()
    ctrl.cancelBuild()
    await flushMicrotasks()
    expect(snap.error).toContain('cancel boom')
    expect(snap.building).toBe(true) // 编译仍在飞行中，等待其自然返回
    resolveBuild?.({ buildId: 'b-x', status: 'ok' as const, durationMs: 1 })
    await flushMicrotasks()
    expect(snap.building).toBe(false)
  })
})

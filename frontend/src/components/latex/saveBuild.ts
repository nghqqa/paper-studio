// -*- coding: utf-8 -*-
/**
 * LaTeX 工作台的保存/编译调度核心（w21 可靠性收尾）。
 *
 * 从 LatexWorkbench 抽出的 headless 控制器：所有竞态处理集中在这一处，
 * deps 注入 API 与定时器，可脱离 DOM/CodeMirror 做确定性测试。
 *
 * 行为契约（与可靠性任务书逐条对应）：
 * - 保存飞行中继续编辑：响应只更新服务器版本标识（sha）；本地内容若已变化，
 *   dirty 保持 true——绝不把新输入标为「已保存」。
 * - 保存飞行中切换文件：旧响应整体丢弃（不污染新文件的 base）。
 * - 单飞：同一时刻最多一个保存请求；飞行中来的保存请求排队一次，完成后补存。
 * - 409：进入 conflict 暂停态——自动保存/编译全部暂停，本地内容保留；
 *   由用户显式选择「覆盖服务器」或「放弃本地、加载服务器版本」。不自动重试。
 * - 其他保存失败：保留 dirty 与错误信息，不自动重试（下次编辑停顿会再试）。
 * - 编译与保存解耦：编译总是针对「已保存」的内容；保存未成功绝不启动编译。
 *   保存完成点是保存→编译的唯一次序锚点（编译期间/之后的编辑都经停顿自动保存，
 *   完成时若自动编译开启且当前没有编译在跑，则补编译一次最新版本）。
 * - 自动保存恒开（停顿 2s）；「自动编译」开关只控制保存后是否接着编译。
 */

export interface BuildResultLike {
  buildId: string
  status: 'ok' | 'error' | 'running' | 'canceled'
  durationMs: number
}

export interface SaveBuildDeps {
  /** PUT 保存；isConflict(e)===true 视为 409 版本冲突 */
  save(path: string, content: string, base: string | null): Promise<{ sha: string }>
  /** 放弃本地、加载服务器版本 */
  reload(path: string): Promise<{ content: string; sha: string }>
  /** 触发一次编译（后端 latest-wins 单构建；busy 冲突经 isConflict 上报） */
  build(engine: string): Promise<BuildResultLike>
  /** 中止进行中的编译（后端终止进程组，build 请求以 canceled 结果返回）；可缺省（旧测试） */
  cancelBuild?(): Promise<unknown>
  /** 409 判定（组件注入 errorKind(e)==='stale'） */
  isConflict(e: unknown): boolean
  /** 403 判定（权限失效/只读访问）：暂停自动保存，本地内容保留，显式保存可重试 */
  isForbidden(e: unknown): boolean
  /** 错误消息提取 */
  message(e: unknown): string
  /** 定时调度（测试注入 fake）；返回取消函数 */
  schedule(fn: () => void, ms: number): () => void
  /** 编译结果回调（组件据此刷新 builds 列表与预览产物） */
  onBuildResult(res: BuildResultLike): void
}

export interface ControllerSnapshot {
  path: string | null
  /** 服务器当前版本标识（base）；创建批注锚点用 */
  savedSha: string | null
  dirty: boolean
  saving: boolean
  building: boolean
  /** 409 冲突暂停态：自动保存/编译全部暂停，等待用户显式恢复 */
  conflict: boolean
  /** 权限失效暂停态（403）：自动保存暂停，本地内容保留，显式保存可重试 */
  permLost: boolean
  /** 本地草稿已恢复、自动保存/编译暂停，等待用户显式保存确认 */
  draftPaused: boolean
  error: string | null
  notice: string | null
  autoBuild: boolean
}

export interface ControllerEvents {
  /** 保存真正落盘。contentAtSend = 该请求发出的内容：调用方据此判断
   *  「服务器内容 == 当前本地内容」（可清本地草稿）还是「飞行中有新输入」（草稿必须保留）。 */
  onSaved?(path: string, sha: string, contentAtSend: string): void
  onBuildStart?(): void
}

const AUTO_SAVE_DEBOUNCE_MS = 2000

export class SaveBuildController {
  private deps: SaveBuildDeps
  private events: ControllerEvents
  private engine: string

  private path: string | null = null
  private content = ''
  private savedSha: string | null = null
  private dirty = false

  private saving = false
  private saveQueued = false
  private building = false
  private conflict = false
  private autoBuild = true
  /** 本地草稿恢复后的暂停态：自动保存/编译暂停，显式保存即确认并解除 */
  private draftPaused = false
  /** 权限失效（403）：自动保存暂停；显式保存可重试（权限恢复后成功即解除） */
  private permLost = false
  /** 保存完成后是否接着编译（手动编译/停顿自动编译在 dirty 时先走保存） */
  private buildAfterSave = false

  private error: string | null = null
  private notice: string | null = null

  private cancelIdle: (() => void) | null = null
  private listeners = new Set<(s: ControllerSnapshot) => void>()

  constructor(deps: SaveBuildDeps, events: ControllerEvents = {}, engine = 'pdflatex') {
    this.deps = deps
    this.events = events
    this.engine = engine
  }

  setEngine(engine: string) {
    this.engine = engine
  }

  setAutoBuild(v: boolean) {
    this.autoBuild = v
    this.emit()
  }

  getAutoBuild() {
    return this.autoBuild
  }

  subscribe(fn: (s: ControllerSnapshot) => void): () => void {
    this.listeners.add(fn)
    fn(this.snapshot())
    return () => this.listeners.delete(fn)
  }

  snapshot(): ControllerSnapshot {
    return {
      path: this.path,
      savedSha: this.savedSha,
      dirty: this.dirty,
      saving: this.saving,
      building: this.building,
      conflict: this.conflict,
      draftPaused: this.draftPaused,
      permLost: this.permLost,
      error: this.error,
      notice: this.notice,
      autoBuild: this.autoBuild,
    }
  }

  private emit() {
    const snap = this.snapshot()
    for (const fn of this.listeners) fn(snap)
  }

  /** 打开文件（组件先经 API 读取服务器版本）。重置全部调度状态。 */
  open(path: string, content: string, sha: string) {
    this.cancelIdle?.()
    this.cancelIdle = null
    this.path = path
    this.content = content
    this.savedSha = sha
    this.dirty = false
    this.conflict = false
    this.error = null
    this.notice = null
    this.buildAfterSave = false
    this.emit()
  }

  /** 编辑器文档变化（每次按键/粘贴）。 */
  edit(content: string) {
    if (!this.path) return
    this.content = content
    this.dirty = true
    if (!this.conflict) this.scheduleIdle()
    this.emit()
  }

  getContent() {
    return this.content
  }

  getPath() {
    return this.path
  }

  isDirty() {
    return this.dirty
  }

  /**
   * 停顿回调：自动保存恒开（与自动编译开关无关）；
   * 自动编译开启时，在保存完成点接着编译。
   */
  private onIdle = () => {
    this.cancelIdle = null
    if (this.conflict || this.permLost || !this.dirty || this.saving) return
    if (this.autoBuild) this.buildAfterSave = true
    void this.runSave()
  }

  private scheduleIdle() {
    if (this.conflict || this.draftPaused || this.permLost) return
    this.cancelIdle?.()
    this.cancelIdle = this.deps.schedule(() => this.onIdle(), AUTO_SAVE_DEBOUNCE_MS)
  }

  /** 手动保存（单飞：飞行中调用只排队）。显式保存视为草稿确认，成功后解除暂停。 */
  saveNow(): void {
    if (this.conflict) return
    this.permLost = false
    if (this.draftPaused) this.draftPaused = false
    if (this.saving) {
      this.saveQueued = true
      return
    }
    void this.runSave()
  }

  /** 手动编译：dirty 先保存（显式编译同样确认草稿），保存完成点再启动编译；保存失败则不编译。 */
  buildNow(): void {
    if (this.conflict || this.building) return
    if (this.draftPaused) this.draftPaused = false
    if (this.dirty) {
      this.buildAfterSave = true
      void this.runSave()
      return
    }
    void this.runBuild()
  }

  /** 中止进行中的编译（服务端终止进程组；build 请求随后以 canceled 结果返回并走 onBuildResult）。 */
  cancelBuild(): void {
    if (!this.building) return
    this.deps.cancelBuild?.().catch((e: unknown) => {
      this.error = `取消失败：${this.deps.message(e)}`
      this.emit()
    })
  }

  private async runSave(forceBase?: string | null): Promise<void> {
    if (this.saving) {
      this.saveQueued = true
      return
    }
    const rel = this.path
    if (!rel) return
    if (!this.dirty && forceBase === undefined) return
    const contentAtSend = this.content
    const base = forceBase !== undefined ? forceBase : this.savedSha
    this.saving = true
    this.error = null
    this.emit()
    try {
      const reply = await this.deps.save(rel, contentAtSend, base)
      this.saving = false
      if (this.path !== rel) {
        // 飞行中切换了文件：响应整体丢弃，不污染新文件状态
        this.emit()
        this.pump()
        return
      }
      this.savedSha = reply.sha
      if (this.content === contentAtSend) {
        // 内容未再变化：真正已保存
        this.dirty = false
        this.notice = `已保存 ${rel}`
      } else {
        // 飞行中又有输入：仍为脏，重新排停顿（绝不把新输入标为已保存）
        this.dirty = true
        this.scheduleIdle()
      }
      this.conflict = false
      this.permLost = false
      this.events.onSaved?.(rel, reply.sha, contentAtSend)
      this.emit()
      this.chainBuildIfDue()
    } catch (e) {
      this.saving = false
      if (this.path !== rel) {
        this.emit()
        this.pump()
        return
      }
      if (this.deps.isConflict(e)) {
        // 冲突暂停态：本地内容保留；自动链全部暂停，等用户显式恢复
        this.conflict = true
        this.buildAfterSave = false
        this.error = '保存冲突：服务器上的文件已被其他会话修改，本地修改已保留。请选择保留方式。'
      } else if (this.deps.isForbidden(e)) {
        // 权限失效（如被降为只读）：本地内容保留、自动保存暂停（含挂起的停顿任务）；用户显式保存可重试
        this.permLost = true
        this.buildAfterSave = false
        this.cancelIdle?.()
        this.cancelIdle = null
        this.error = '保存失败：当前账号已无该文件的写入权限。本地修改已保留，权限恢复后可重试保存。'
      } else {
        this.error = `保存失败：${this.deps.message(e)}`
      }
      this.emit()
    }
    this.pump()
  }

  /** 保存完成点：保存→编译的唯一链接处。 */
  private chainBuildIfDue() {
    if (this.buildAfterSave && this.autoBuild && !this.saving && !this.building && !this.conflict) {
      this.buildAfterSave = false
      void this.runBuild()
    }
  }

  private async runBuild(): Promise<void> {
    if (this.building || this.conflict) return
    this.building = true
    this.error = null
    this.emit()
    this.events.onBuildStart?.()
    try {
      const res = await this.deps.build(this.engine)
      this.building = false
      // 取消后不立即补编译：清掉挂起的「保存后编译」，避免用户刚点取消就被自动重编
      if (res.status === 'canceled') this.buildAfterSave = false
      this.deps.onBuildResult(res)
      this.emit()
    } catch (e) {
      this.building = false
      this.error = `编译失败：${this.deps.message(e)}`
      this.emit()
    }
    // 编译结束时：期间已有保存完成的新版本 → 立即补编译最新版；
    // 保存尚未完成 → 交由保存完成点（chainBuildIfDue）链接
    if (this.buildAfterSave && !this.conflict && !this.dirty && this.autoBuild) {
      this.buildAfterSave = false
      void this.runBuild()
    } else if (this.dirty && !this.conflict) {
      this.scheduleIdle()
    }
  }

  private pump() {
    // 保存队列：飞行中来的保存请求，完成后补一次
    if (!this.saving && this.saveQueued && !this.conflict && this.path) {
      this.saveQueued = false
      void this.runSave()
    }
  }

  /** 409 恢复一：以本地内容覆盖服务器（base 置空跳过版本校验）。 */
  resolveOverwrite() {
    if (!this.conflict || !this.path) return
    this.conflict = false
    this.dirty = true
    this.error = null
    void this.runSave(null)
  }

  /** 409 恢复二：放弃本地修改，加载服务器版本（内容经返回值回到组件）。 */
  async resolveReload(): Promise<{ content: string; sha: string } | null> {
    if (!this.conflict || !this.path) return null
    const rel = this.path
    try {
      const fresh = await this.deps.reload(rel)
      this.notice = '已放弃本地修改，加载服务器版本。'
      this.open(rel, fresh.content, fresh.sha)
      return fresh
    } catch (e) {
      this.error = `加载服务器版本失败：${this.deps.message(e)}`
      this.emit()
      return null
    }
  }

  /**
   * 恢复本地草稿到编辑器：内容与 dirty 置位，但进入 draftPaused——
   * 自动保存/编译暂停，由用户核对后显式保存（=确认并解除暂停）。
   * 恢复不等于允许覆盖服务器：base 仍是当前服务器版本，正常保存若遇并发会走既有 409 机制。
   */
  restoreDraft(content: string) {
    if (!this.path) return
    this.content = content
    this.dirty = true
    this.draftPaused = true
    this.error = null
    this.cancelIdle?.()
    this.cancelIdle = null
    this.emit()
  }

  /** 组件卸载/切换时清理定时器。 */
  dispose() {
    this.cancelIdle?.()
    this.cancelIdle = null
  }
}

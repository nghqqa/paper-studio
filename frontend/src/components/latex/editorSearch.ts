/**
 * 工程内容索引（编辑器三件套的地基）：全工程可编辑文本的内存快照，
 * 供跨文件搜索与 \ref/\label 补全共用。
 *
 * 设计约束：
 * - CM 是整体重建语义（换文件/冲突重载都 destroy 重建 EditorView）——索引必须活在
 *   workbench 层（useRef），不随视图重建丢缓存；
 * - 后端 read 无单文件大小上限 ⇒ 前端按 files 清单的 size 自限（单文件 1MB / 总量 8MB），
 *   超限标记 partial（搜索结果条上提示「大文件已跳过」），绝不静默装作全量；
 * - 失效是显式的（invalidate）：保存完成、文件树增删改、文献导入后由 workbench 调用；
 *   ensure() 并发去重——进行中的加载不会被重复触发。
 * deps 注入（照 saveBuild 模式）：list/read 可打桩，纯逻辑测试不碰网络。
 */

export interface EditorSearchDeps {
  list: () => Promise<{ files: { path: string; size: number; editable: boolean }[] }>
  read: (path: string) => Promise<{ path: string; content: string }>
}

export interface SearchHit {
  path: string
  line: number // 1-based
  col: number // 1-based
  text: string // 该行内容（过长截断）
}

export interface LabelHit {
  name: string
  file: string
  line: number // 1-based
}

export const MAX_FILE_BYTES = 1 * 1024 * 1024
export const MAX_TOTAL_BYTES = 8 * 1024 * 1024
export const MAX_HITS = 200
export const MAX_LINE_CHARS = 240
const READ_CONCURRENCY = 6

export class ProjectContentIndex {
  private contents = new Map<string, string>()
  private order: string[] = []
  private partial = false
  private loading: Promise<void> | null = null
  private deps: EditorSearchDeps

  constructor(deps: EditorSearchDeps) {
    this.deps = deps
  }

  get isPartial(): boolean {
    return this.partial
  }

  get fileCount(): number {
    return this.contents.size
  }

  /** 有缓存且未在进行中的加载 ⇒ true（搜索入口可即开即用）。 */
  get ready(): boolean {
    return this.contents.size > 0 && this.loading === null
  }

  invalidate(): void {
    this.contents.clear()
    this.order = []
    this.partial = false
    this.loading = null
  }

  /** 确保有快照（并发去重）。失败向上抛——调用方决定是否提示重试。 */
  async ensure(): Promise<void> {
    if (this.contents.size > 0) return
    if (this.loading) return this.loading
    this.loading = this.load().finally(() => {
      this.loading = null
    })
    return this.loading
  }

  private async load(): Promise<void> {
    const { files } = await this.deps.list()
    const chosen = files.filter((f) => f.editable && f.size <= MAX_FILE_BYTES)
    this.partial = files.some((f) => f.editable && f.size > MAX_FILE_BYTES)
    let total = 0
    let cursor = 0
    const worker = async () => {
      while (cursor < chosen.length && total < MAX_TOTAL_BYTES) {
        const info = chosen[cursor++]
        // 并发下 total 可能尚未计入其他 worker 的已读量，用 >= 保守拦截（宁可 partial 不超预算）
        if (total + info.size >= MAX_TOTAL_BYTES) {
          this.partial = true
          continue
        }
        try {
          const r = await this.deps.read(info.path)
          this.contents.set(info.path, r.content)
          this.order.push(info.path)
          total += info.size
        } catch {
          // 单文件读取失败不炸整体（可能已被删除）——标记 partial 以示不完整
          this.partial = true
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, chosen.length) }, worker))
  }

  /** 大小写不敏感的全工程逐行搜索（按文件清单顺序稳定输出）。 */
  searchAll(query: string): SearchHit[] {
    const q = query.trim().toLowerCase()
    const hits: SearchHit[] = []
    if (!q) return hits
    for (const path of this.order) {
      const content = this.contents.get(path) ?? ''
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const col = lines[i].toLowerCase().indexOf(q)
        if (col === -1) continue
        const raw = lines[i]
        hits.push({
          path,
          line: i + 1,
          col: col + 1,
          text: raw.length > MAX_LINE_CHARS ? raw.slice(0, MAX_LINE_CHARS) + '…' : raw,
        })
        if (hits.length >= MAX_HITS) return hits
      }
    }
    return hits
  }

  /** 全工程 .tex 的 \label{...} 收集（\ref 补全数据源）。 */
  collectLabels(): LabelHit[] {
    const out: LabelHit[] = []
    const re = /\\label\{([^}]+)\}/g
    for (const path of this.order) {
      if (!path.endsWith('.tex')) continue
      const content = this.contents.get(path) ?? ''
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(content)) !== null) {
        const line = content.slice(0, m.index).split('\n').length
        out.push({ name: m[1].trim(), file: path, line })
        if (out.length >= MAX_HITS * 10) return out
      }
    }
    return out
  }
}

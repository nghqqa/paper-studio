import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import { ArrowDown, ArrowUp, FileDown, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Segmented } from '@/components/ui/segmented'
import { cn } from '@/lib/utils'
import { StructContinuousEditor, type ContinuousInsertApi } from './StructContinuousEditor'
import { StructPreviewPane, type PreviewState } from '@/components/struct/StructPreviewPane'
import {
  structApi,
  type StructArtifactManifest,
  type StructBlock,
  type StructContent,
  type StructGate,
  type StructVersion,
} from '@/lib/api/struct'
import { ApiError } from '@/lib/api/net'
import { useStudio } from '@/store'

/**
 * v0.1 proto：结构化中文论文工作台（实验，PATENT_STUDIO_STRUCT_WRITER=on 才有入口/端点）。
 * 形态：题区表单（单栏）+ 块列表（h1/h2/段/公式/图/表，稳定 ID，文档顺序即编号顺序）。
 * 公式 = LaTeX 数学子集（前端白名单提示 + 后端导出门禁双保险）；引用 = [[eq:id]] 等点选插入；
 * 保存 = 整篇 PUT + base_sha 乐观并发（409 冲突显式处理）；导出 = DOCX（tab/table 双编号版式）→ PDF（sidecar）。
 * 边界：不做自动保存、不做 DOCX 导入、不承诺格式无损（边界声明见 MULTIMODE-ROUTES.md）。
 */

const OBJECT_KINDS = { formula: 'eq', figure: 'fig', table: 'tab' } as const
const KIND_LABEL: Record<string, string> = { h1: '一级标题', h2: '二级标题', p: '正文段', formula: '独立公式', figure: '图', table: '表' }

/** 与后端 structured.py ALLOWED_COMMANDS 同集（KaTeX 渲染 ∩ pandoc→OMML 可靠转换） */
const ALLOWED_COMMANDS = new Set(
  ('frac dfrac sqrt sum prod int lim exp max min log ln sin cos tan top ' +
    'alpha beta gamma delta epsilon varepsilon zeta eta theta iota kappa lambda mu nu xi pi rho sigma tau upsilon phi varphi chi psi omega ' +
    'Gamma Delta Theta Lambda Xi Pi Sigma Phi Psi Omega times cdot div pm mp leq geq neq approx equiv infty partial nabla forall exists in subset cup cap ' +
    'rightarrow leftarrow Rightarrow Leftarrow mapsto to mathbf mathrm mathit boldsymbol text operatorname left right quad qquad begin end').split(' '),
)
const ALLOWED_ENVIRONMENTS = new Set(['pmatrix', 'bmatrix', 'matrix', 'cases', 'aligned'])

function formulaWarn(latex: string): string[] {
  const bad = new Set<string>()
  for (const m of (latex || '').matchAll(/\\([a-zA-Z]+)/g)) {
    if (ALLOWED_COMMANDS.has(m[1])) continue
    bad.add(m[1] === 'label' ? '\\label（编号由系统生成，请勿手写）' : `\\${m[1]}`)
  }
  for (const m of (latex || '').matchAll(/\\(?:begin|end)\{(\w+\*?)\}/g))
    if (!ALLOWED_ENVIRONMENTS.has(m[1])) bad.add(`\\begin{${m[1]}}`)
  return [...bad]
}

function ktHtml(latex: string, display: boolean): string {
  try {
    return katex.renderToString(latex || '', { displayMode: display, throwOnError: true, output: 'html' })
  } catch (e) {
    return `<span class="text-red-600">公式错误：${e instanceof Error ? e.message : String(e)}</span>`
  }
}

function errText(e: unknown): string {
  const anyErr = e as { message?: string; detail?: { message?: string } }
  return anyErr?.detail?.message || anyErr?.message || String(e)
}

function download(url: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = ''
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/** 文档顺序编号（编号事实源 = body 顺序，与后端 gen_latex/numbering.lua 一致） */
function numberingOf(body: StructBlock[]): Record<string, string> {
  const num: Record<string, string> = {}
  let e = 0, f = 0, t = 0
  for (const b of body) {
    if (b.type === 'formula' && b.id) num[`eq:${b.id}`] = `(${++e})`
    else if (b.type === 'figure' && b.id) num[`fig:${b.id}`] = `图${++f}`
    else if (b.type === 'table' && b.id) num[`tab:${b.id}`] = `表${++t}`
  }
  return num
}

const REF_SPLIT = /(\[\[(?:eq|fig|tab):[A-Za-z0-9_-]+\]\]|\$[^$]+\$)/g

/** 段落/题注的行内渲染：[[eq:id]] → 当前编号（失效标红）；$...$ → KaTeX 行内 */
function renderInline(text: string, num: Record<string, string>): ReactNode[] {
  return (text || '').split(REF_SPLIT).map((part, i) => {
    const ref = part.match(/^\[\[(eq|fig|tab):([A-Za-z0-9_-]+)\]\]$/)
    if (ref) {
      const full = `${ref[1]}:${ref[2]}`
      return num[full]
        ? <b key={i} className="text-fg-strong">{num[full]}</b>
        : <b key={i} className="text-red-600">【失效引用 {full}】</b>
    }
    if (part.length > 2 && part.startsWith('$') && part.endsWith('$'))
      return <span key={i} dangerouslySetInnerHTML={{ __html: ktHtml(part.slice(1, -1), false) }} />
    return <span key={i}>{part}</span>
  })
}

const newId = (p: string) => `${p}-${Math.random().toString(36).slice(2, 8)}`

const inputCls =
  'w-full rounded-sm border border-border bg-app px-2 py-1 text-sm text-fg outline-none focus:border-fg-muted'
const labelCls = 'shrink-0 pt-1 text-xs text-fg-muted'

export interface StructDraftState {
  loaded: boolean
  dirty: boolean
  saving: boolean
  conflict: boolean
}

export function StructPaperWorkbench({ pid, onDraftStateChange }: { pid: string; onDraftStateChange?: (state: StructDraftState) => void }) {
  const role = useStudio((s) => s.project?.role) as 'owner' | 'editor' | 'agent' | 'reviewer' | 'viewer' | null | undefined
  const canEdit = role == null || role === 'owner' || role === 'editor' || role === 'agent'
  const projectTitle = useStudio((s) => s.project?.title)
  const toast = useStudio((s) => s.toast)

  const [content, setContent] = useState<StructContent | null>(null)
  const [sha, setSha] = useState('')
  const [versions, setVersions] = useState<StructVersion[]>([])
  const [artifacts, setArtifacts] = useState<StructArtifactManifest[]>([])
  const [loadErr, setLoadErr] = useState('')
  const [saveState, setSaveState] = useState('已加载')
  const [gate, setGate] = useState<StructGate | null>(null)
  const [exportErr, setExportErr] = useState('')
  const [dirty, setDirty] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [pdfBusy, setPdfBusy] = useState(false)
  const [mode, setMode] = useState<'tab' | 'table'>('tab')
  const [preview, setPreview] = useState<PreviewState>({ phase: 'idle' })
  // v0.2 连续编辑：continuous=默认画布视图；cards=v0.1 卡片回退（两视图共用同一草稿 content）
  const [viewMode, setViewMode] = useState<'continuous' | 'cards'>('continuous')
  const [pmEpoch, setPmEpoch] = useState(0) // 服务端内容重载后递增 → 连续编辑器按新内容重挂
  const insertApi = useRef<ContinuousInsertApi | null>(null)
  const contentRef = useRef<StructContent | null>(null)
  contentRef.current = content
  const dirtyRef = useRef(false)
  dirtyRef.current = dirty
  const savingRef = useRef(false)
  savingRef.current = saving
  const savedShaRef = useRef('')
  savedShaRef.current = sha
  const canEditRef = useRef(canEdit)
  canEditRef.current = canEdit
  const pauseTimer = useRef<number | null>(null)
  const saveQueued = useRef(false)
  const previewSeq = useRef(0)
  const autosaveRef = useRef<() => void>(() => {})

  const load = useCallback(async () => {
    setLoaded(false)
    try {
      const j = await structApi.getContent(pid)
      setContent(j.content)
      setSha(j.sha)
      setVersions(j.versions || [])
      setDirty(false)
      setConflict(false)
      setSaveState('已加载')
      setLoadErr('')
      const a = await structApi.artifacts(pid)
      setArtifacts(a.artifacts || [])
      setLoaded(true)
      setPreview({ phase: 'idle' })
      setPmEpoch((e) => e + 1)
      // 打开工作台即预取当前已保存版本的投稿版预览（服务端 sha 缓存命中则零转换）
      if (canEditRef.current) void requestPreview(0)
    } catch (e) {
      setLoadErr(errText(e))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    onDraftStateChange?.({ loaded, dirty, saving, conflict })
  }, [loaded, dirty, saving, conflict, onDraftStateChange])

  useEffect(() => {
    if (!dirty) return
    const h = (e: BeforeUnloadEvent) => { e.preventDefault() }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [dirty])

  useEffect(() => () => {
    if (pauseTimer.current != null) window.clearTimeout(pauseTimer.current)
  }, [])

  /** 停顿自动保存（2.5s，与 saveBuild 控制器同节奏）：每次编辑重置计时 */
  function noteEdit() {
    setDirty(true)
    if (pauseTimer.current != null) window.clearTimeout(pauseTimer.current)
    if (!canEditRef.current) return
    pauseTimer.current = window.setTimeout(() => {
      pauseTimer.current = null
      autosaveRef.current()
    }, 2500)
  }

  const patch = useCallback((i: number, p: Partial<StructBlock>) => {
    setContent((c) => (c ? { ...c, body: c.body.map((b, k) => (k === i ? ({ ...b, ...p } as StructBlock) : b)) } : c))
    noteEdit()
  }, [])

  const patchMeta = useCallback((key: keyof StructContent, v: string) => {
    setContent((c) => (c ? { ...c, [key]: v } : c))
    noteEdit()
  }, [])

  const numbering = useMemo(() => numberingOf(content?.body ?? []), [content])

  /** 预览：与导出同一转换链（服务端按 sha 缓存）；同案任务进行中/生成期内容变化 → 409 → 有限重试 */
  async function requestPreview(attempt: number) {
    if (!canEditRef.current) return
    const seq = ++previewSeq.current
    setPreview((p) => ({ ...p, phase: attempt === 0 && p.phase === 'idle' ? 'idle' : 'running', error: undefined }))
    try {
      const j = await structApi.preview(pid)
      if (seq !== previewSeq.current) return
      setPreview({ phase: 'done', sha: j.sha, vid: j.vid, pdfUrl: j.pdfUrl, durationMs: j.duration_ms, cached: j.status === 'cached', error: undefined })
    } catch (e) {
      if (seq !== previewSeq.current) return
      if (e instanceof ApiError && e.status === 409 && attempt < 2) {
        setPreview((p) => ({ ...p, phase: 'queued' }))
        window.setTimeout(() => { if (seq === previewSeq.current) void requestPreview(attempt + 1) }, 3000)
        return
      }
      setPreview((p) => ({ ...p, phase: 'error', error: errText(e) }))
    }
  }

  /** 保存（单飞+尾部补存，与 saveBuild 控制器同契约）→ 成功即触发预览。保存冲突暂停自动链。 */
  async function saveThenPreview(): Promise<boolean> {
    if (savingRef.current) { saveQueued.current = true; return false }
    if (!contentRef.current) return false
    if (conflict) return false // 冲突暂停态：等用户显式处理，不自动重试
    setSaving(true)
    setSaveState('保存中…')
    let ok = false
    const contentAtSend = contentRef.current
    try {
      const j = await structApi.putContent(pid, contentAtSend, savedShaRef.current || null)
      setSha(j.sha)
      setVersions((v) => (v.at(-1)?.sha === j.version.sha ? v : [...v, j.version]))
      setGate(j.gate.ok ? null : j.gate)
      // 飞行中又有输入则保持 dirty（绝不把新输入标为已保存）——按发送时内容快照对比判断
      if (contentRef.current === contentAtSend) {
        setSaveState(`已保存（${j.version.vid}）`)
        setDirty(false)
      } else {
        setSaveState(`已保存（${j.version.vid}）· 有新修改未保存`)
      }
      setConflict(false)
      // 内容已变化：重拉导出记录让旧产物的「已过期」标记即时生效（否则要等刷新页面）
      void structApi.artifacts(pid).then((a) => setArtifacts(a.artifacts || [])).catch(() => { /* 记录刷新失败不打断保存 */ })
      ok = true
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setConflict(true)
        setSaveState('保存冲突')
      } else {
        setSaveState(`保存失败：${errText(e)}`)
      }
      ok = false
    } finally {
      setSaving(false)
    }
    if (ok) void requestPreview(0)
    if (saveQueued.current) {
      saveQueued.current = false
      if (ok && dirtyRef.current) void saveThenPreview()
    }
    return ok
  }
  autosaveRef.current = () => { void saveThenPreview() }

  async function save(): Promise<boolean> {
    return saveThenPreview()
  }

  // Ctrl/Cmd+S 保存（v0.1.5 起另有停顿自动保存；显式保存立即保存+预览）
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sha, pid])

  async function doExport() {
    if (dirtyRef.current) { toast('有未保存修改：请先保存再导出', 'warning'); return }
    setExporting(true)
    setExportErr('')
    try {
      const j = await structApi.exportDocx(pid, mode)
      const a = await structApi.artifacts(pid)
      setArtifacts(a.artifacts || [])
      download(j.docxUrl)
      toast(`DOCX 已导出（${j.manifest.artifact}）`, 'success')
    } catch (e) {
      setExportErr(errText(e))
    } finally {
      setExporting(false)
    }
  }

  async function doPdf() {
    const latest = artifacts.find((a) => !a.stale) ?? artifacts[0]
    if (!latest) { toast('请先导出 DOCX，再从其转换 PDF', 'warning'); return }
    if (dirtyRef.current) { toast('有未保存修改：请先保存再导出', 'warning'); return }
    setPdfBusy(true)
    setExportErr('')
    try {
      const j = await structApi.exportPdf(pid, latest.artifact)
      download(j.pdfUrl)
      toast('PDF 已从本次 DOCX 转出', 'success')
    } catch (e) {
      setExportErr(errText(e))
    } finally {
      setPdfBusy(false)
    }
  }

  function addBlock(type: StructBlock['type']) {
    setContent((c) => {
      if (!c) return c
      let b: StructBlock
      if (type === 'h1' || type === 'h2' || type === 'p') b = { type, text: '' }
      else if (type === 'formula') b = { type, id: newId('eq'), latex: '' }
      else if (type === 'figure') b = { type, id: newId('fig'), resource: '', caption: '' }
      else b = { type, id: newId('tab'), caption: '', header: ['', ''], rows: [['', ''], ['', '']] }
      return { ...c, body: [...c.body, b] }
    })
    noteEdit()
  }

  function moveBlock(i: number, d: -1 | 1) {
    setContent((c) => {
      if (!c) return c
      const j = i + d
      if (j < 0 || j >= c.body.length) return c
      const body = [...c.body]
      ;[body[i], body[j]] = [body[j], body[i]]
      return { ...c, body }
    })
    noteEdit()
  }

  function delBlock(i: number) {
    const c = contentRef.current
    if (!c) return
    const b = c.body[i]
    const kind = (b as { type: string }).type
    const id = (b as { id?: string }).id
    const full = id ? `${OBJECT_KINDS[kind as keyof typeof OBJECT_KINDS]}:${id}` : null
    if (full && numbering[full]) {
      const referenced = c.body.some((x) => 'text' in x && x.text?.includes(`[[${full}]]`)) ||
        c.body.some((x) => 'caption' in x && x.caption?.includes(`[[${full}]]`)) ||
        c.abstract_zh.includes(`[[${full}]]`)
      if (referenced && !window.confirm(`「${numbering[full]}」正被正文引用，删除后引用将变为失效引用且导出被阻断。确认删除？`)) return
    }
    setContent((cc) => (cc ? { ...cc, body: cc.body.filter((_, k) => k !== i) } : cc))
    noteEdit()
  }

  if (loadErr)
    return (
      <div className="grid min-h-dvh place-items-center bg-app px-4" data-testid="struct-load-error">
        <div className="max-w-md text-center">
          <p className="text-base font-semibold text-fg-strong">结构化论文工作区加载失败</p>
          <p className="mt-2 text-sm text-fg-muted">{loadErr}</p>
          <div className="mt-4 flex justify-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void load()}>重试</Button>
            <a href="#/" className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-hover">返回项目列表</a>
          </div>
        </div>
      </div>
    )
  if (!content)
    return <div className="grid min-h-dvh place-items-center bg-app text-sm text-fg-muted" role="status">加载中…</div>

  const objects = content.body
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => (b.type === 'formula' || b.type === 'figure' || b.type === 'table') && (b as { id?: string }).id)

  return (
    <div className="flex min-h-dvh flex-col bg-app text-fg" data-testid="struct-workbench">
      <header className="sticky top-0 z-panel flex flex-wrap items-center gap-2 border-b border-border bg-panel px-3 py-2" data-testid="struct-topbar">
        <a href="#/" className="shrink-0 text-sm text-fg-muted hover:text-fg">← 项目</a>
        <h1 className="min-w-0 truncate text-sm font-semibold text-fg-strong">{projectTitle || content.title || '结构化中文论文'}</h1>
        <span className="rounded-xs bg-hover px-1.5 py-0.5 text-2xs text-fg-muted">结构化（实验）</span>
        <span aria-live="polite" data-testid="struct-save-state"
          className={cn('text-xs', dirty ? 'text-fg-muted' : saveState.startsWith('保存失败') || saveState === '保存冲突' ? 'text-red-600' : 'text-fg-muted')}>
          {dirty ? '● 未保存' : saveState}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <select value={mode} onChange={(e) => setMode(e.target.value as 'tab' | 'table')} disabled={!canEdit}
            data-testid="struct-eqnum-mode" aria-label="编号版式"
            className="rounded-sm border border-border bg-app px-1.5 py-1 text-xs text-fg">
            <option value="tab">编号版式：制表位</option>
            <option value="table">编号版式：无边框表格</option>
          </select>
          <Button variant="outline" size="sm" onClick={() => void save()} disabled={!canEdit || saving || !dirty} data-testid="struct-save">
            保存新版本
          </Button>
          <Button variant="primary" size="sm" onClick={() => void doExport()} disabled={!canEdit || exporting} data-testid="struct-export-docx">
            <FileDown aria-hidden /> 导出 DOCX
          </Button>
          <Button variant="outline" size="sm" onClick={() => void doPdf()} disabled={!canEdit || pdfBusy} data-testid="struct-export-pdf">
            导出 PDF
          </Button>
        </div>
      </header>

      {conflict && (
        <div className="border-b border-border bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300" data-testid="struct-conflict">
          内容已被他人保存（版本冲突）。当前修改未写入。
          <Button variant="outline" size="xs" className="ml-2" onClick={() => void load()} data-testid="struct-conflict-reload">
            放弃本地修改，载入最新版本
          </Button>
        </div>
      )}
      {(gate || exportErr) && (
        <div className="border-b border-border bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200" data-testid="struct-gate">
          <p className="font-semibold">{exportErr ? '导出被阻断（未产生文件）' : '校验问题（可保存草稿，导出将被阻断）：'}</p>
          <pre className="mt-1 whitespace-pre-wrap font-sans">{exportErr || gate?.errors.map((x) => `· ${x}`).join('\n')}</pre>
        </div>
      )}

      <div className="mx-auto flex w-full max-w-[1500px] flex-col items-start gap-4 p-4 xl:flex-row">
        <div className="flex w-full min-w-0 flex-col gap-4 xl:max-w-[52%]">
        <div className="flex w-full flex-wrap items-center gap-2" data-testid="struct-continuous-bar">
          <Segmented
            options={[{ value: 'continuous', label: '连续' }, { value: 'cards', label: '卡片（回退）' }]}
            value={viewMode}
            onValueChange={(v) => setViewMode(v as 'continuous' | 'cards')}
            aria-label="编辑视图"
            size="sm"
          />
          <span className="text-2xs text-fg-muted">同一草稿，两种视图</span>
        </div>
        {viewMode === 'continuous' ? (
          <>
          <div className="flex flex-wrap items-center gap-2" data-testid="struct-insert">
              <Button variant="outline" size="xs" disabled={!canEdit}
                onClick={() => insertApi.current?.insertFormula()} data-testid="struct-continuous-insert-formula">公式</Button>
              <Button variant="outline" size="xs" disabled={!canEdit}
                onClick={() => insertApi.current?.insertInlineFormula()} data-testid="struct-continuous-insert-inline">行内公式</Button>
              <Button variant="outline" size="xs" disabled={!canEdit}
                onClick={() => insertApi.current?.insertFigure()} data-testid="struct-continuous-insert-figure">图</Button>
              <Button variant="outline" size="xs" disabled={!canEdit}
                onClick={() => insertApi.current?.insertTable()} data-testid="struct-continuous-insert-table">表</Button>
              {objects.slice(0, 6).map(({ b }) => {
                const id = (b as { id: string }).id
                const kind = OBJECT_KINDS[b.type as keyof typeof OBJECT_KINDS]
                return (
                  <Button key={`${kind}:${id}`} variant="outline" size="xs" disabled={!canEdit}
                    title={`插入引用 [[${kind}:${id}]]`}
                    onClick={() => insertApi.current?.insertRef(kind, id)}>
                    {numbering[`${kind}:${id}`]}
                  </Button>
                )
              })}
          </div>
          <div className="rounded-md border border-border bg-panel p-4 relative">
            <StructContinuousEditor
              key={`${pid}-${pmEpoch}`}
              content={content}
              canEdit={canEdit}
              pid={pid}
              numbering={numbering}
              objects={objects.map(({ b }) => {
                const id = (b as { id: string }).id
                const kind = OBJECT_KINDS[b.type as keyof typeof OBJECT_KINDS] as 'eq' | 'fig' | 'tab'
                return { kind, id, label: numbering[`${kind}:${id}`] ?? `${kind}:${id}` }
              })}
              onChange={(c) => { setContent(c); setDirty(true); noteEdit() }}
              onNotice={(t) => toast(t, 'warning')}
              onUploadFigure={async (_objectId, file) => {
                try {
                  const r = await structApi.uploadResource(pid, file)
                  return r.rid
                } catch {
                  return null
                }
              }}
              onInsertReady={(api) => { insertApi.current = api }}
            />
          </div>
          </>
        ) : (
          <>
        <section className="w-full shrink-0 rounded-md border border-border bg-panel p-3" aria-label="题区" data-testid="struct-meta">
          <h2 className="mb-2 text-xs font-semibold text-fg-muted">题区（单栏）</h2>
          <div className="flex flex-col gap-2">
            {([
              ['title', '中文标题'],
              ['title_en', '英文标题'],
              ['authors', '作者'],
              ['affil', '单位'],
              ['keywords', '关键词'],
            ] as const).map(([k, label]) => (
              <div key={k} className="grid grid-cols-[64px_minmax(0,1fr)] gap-2">
                <label htmlFor={`struct-${k}`} className={labelCls}>{label}</label>
                <input id={`struct-${k}`} className={inputCls} value={content[k]} disabled={!canEdit}
                  onChange={(e) => patchMeta(k, e.target.value)} data-testid={`struct-meta-${k}`} />
              </div>
            ))}
            {(['abstract_zh', 'abstract_en'] as const).map((k) => (
              <div key={k} className="grid grid-cols-[64px_minmax(0,1fr)] gap-2">
                <label htmlFor={`struct-${k}`} className={labelCls}>{k === 'abstract_zh' ? '中文摘要' : '英文摘要'}</label>
                <textarea id={`struct-${k}`} className={cn(inputCls, 'min-h-20')} value={content[k]} disabled={!canEdit}
                  onChange={(e) => patchMeta(k, e.target.value)} data-testid={`struct-meta-${k}`} />
              </div>
            ))}
          </div>
          <p className="mt-2 text-2xs leading-relaxed text-fg-muted">
            摘要与正文可用行内公式 $…$；引用写作 [[eq:id]]（在块卡片下方点选插入）。
          </p>
          {content.abstract_zh && (
            <div className="mt-2 rounded-sm bg-app p-2 text-sm leading-relaxed" data-testid="struct-abstract-preview">
              {renderInline(content.abstract_zh, numbering)}
            </div>
          )}
        </section>

        <section className="flex min-w-0 flex-1 flex-col gap-3" aria-label="正文块" data-testid="struct-body">
          {content.body.map((b, i) => (
            <BlockCard key={i} b={b} i={i} pid={pid} num={numbering} objects={objects} canEdit={canEdit}
              patch={patch} move={moveBlock} del={delBlock} />
          ))}
          {canEdit && (
            <div className="flex flex-wrap gap-2 rounded-md border border-dashed border-border p-2" data-testid="struct-add">
              {(['h1', 'h2', 'p', 'formula', 'figure', 'table'] as const).map((t) => (
                <Button key={t} variant="outline" size="xs" onClick={() => addBlock(t)} data-testid={`struct-add-${t}`}>
                  <Plus aria-hidden /> {KIND_LABEL[t]}
                </Button>
              ))}
            </div>
          )}

          <div className="mt-2 flex flex-col gap-2 rounded-md border border-border bg-panel p-3" data-testid="struct-records">
            <details>
              <summary className="cursor-pointer text-xs font-semibold text-fg-muted">导出记录（{artifacts.length}）</summary>
              {artifacts.length === 0 ? (
                <p className="mt-2 text-xs text-fg-muted">暂无导出。导出产物含 manifest：内容 sha / 资源摘要 / 编号版式；内容再改动后旧导出标记「已过期」。</p>
              ) : (
                <ul className="mt-2 flex flex-col gap-1 text-xs">
                  {artifacts.map((a) => (
                    <li key={a.artifact} className="flex flex-wrap items-center gap-2" data-testid="struct-artifact-row">
                      <a href={a.artifact} download className="text-fg underline underline-offset-2">{a.artifact}</a>
                      <span className="text-fg-muted">{a.mode === 'table' ? '无边框表格版式' : '制表位版式'}</span>
                      {a.stale
                        ? <span className="rounded-xs bg-amber-100 px-1 text-amber-800 dark:bg-amber-900 dark:text-amber-200">已过期（内容已变化）</span>
                        : <span className="rounded-xs bg-hover px-1 text-fg-muted">与当前内容一致</span>}
                    </li>
                  ))}
                </ul>
              )}
            </details>
            <details>
              <summary className="cursor-pointer text-xs font-semibold text-fg-muted">版本历史（{versions.length}）</summary>
              <ul className="mt-2 flex flex-col gap-1 text-xs text-fg-muted">
                {[...versions].reverse().map((v) => (
                  <li key={v.vid} className="flex gap-2">
                    <span className="font-mono">{v.vid}</span>
                    <span>{new Date(v.at * 1000).toLocaleString()}</span>
                    <span className="truncate">{v.source}</span>
                  </li>
                ))}
              </ul>
            </details>
            <p className="text-2xs leading-relaxed text-fg-muted">
              边界：编号为静态文本（非 Word 域），导出后再改动编号顺序需重新导出；PDF 由本次 DOCX 经转换服务产出，未配置时可在本地用 Word/WPS 另存为 PDF。
            </p>
          </div>
        </section>
          </>
        )}
        </div>

        <StructPreviewPane
          state={preview}
          currentSha={sha}
          canEdit={canEdit}
          onRetry={() => void requestPreview(0)}
        />
      </div>
    </div>
  )
}

type ObjEntry = { b: StructBlock; i: number }

function RefChips({ objects, num, onInsert }: { objects: ObjEntry[]; num: Record<string, string>; onInsert: (ref: string) => void }) {
  if (objects.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-1" data-testid="struct-refchips">
      <span className="text-2xs text-fg-muted">插入引用：</span>
      {objects.map(({ b }) => {
        const id = (b as { id: string }).id
        const kind = OBJECT_KINDS[b.type as keyof typeof OBJECT_KINDS]
        const full = `${kind}:${id}`
        return (
          <button key={full} type="button"
            className="rounded-xs border border-border px-1 py-0.5 text-2xs text-fg hover:bg-hover"
            title={`在字段末尾插入 [[${full}]]`}
            onClick={() => onInsert(full)}>
            {num[full]}
          </button>
        )
      })}
    </div>
  )
}

function BlockCard({ b, i, pid, num, objects, canEdit, patch, move, del }: {
  b: StructBlock
  i: number
  pid: string
  num: Record<string, string>
  objects: ObjEntry[]
  canEdit: boolean
  patch: (i: number, p: Partial<StructBlock>) => void
  move: (i: number, d: -1 | 1) => void
  del: (i: number) => void
}) {
  const kind = b.type
  const id = (b as { id?: string }).id
  const withText = 'text' in b
  const insertRef = (field: 'text' | 'caption') => (full: string) =>
    patch(i, { [field]: `${((b as { text?: string; caption?: string })[field] ?? '')}[[${full}]]` } as Partial<StructBlock>)

  return (
    <article className="rounded-md border border-border bg-panel p-3" data-testid={`struct-block-${kind}`} data-block-index={i}>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-2xs font-semibold text-fg-muted">
          {KIND_LABEL[kind]}{id ? ` · ${OBJECT_KINDS[kind as keyof typeof OBJECT_KINDS]}:${id}` : ''}
          {num[id ? `${OBJECT_KINDS[kind as keyof typeof OBJECT_KINDS]}:${id}` : ''] ? ` · 当前编号 ${num[id ? `${OBJECT_KINDS[kind as keyof typeof OBJECT_KINDS]}:${id}` : '']}` : ''}
        </span>
        <span className="ml-auto flex gap-1">
          <Button variant="ghost" size="icon-sm" aria-label="上移" disabled={canEdit === false} onClick={() => move(i, -1)} data-testid="struct-move-up"><ArrowUp aria-hidden /></Button>
          <Button variant="ghost" size="icon-sm" aria-label="下移" disabled={canEdit === false} onClick={() => move(i, 1)} data-testid="struct-move-down"><ArrowDown aria-hidden /></Button>
          <Button variant="ghost" size="icon-sm" aria-label="删除块" disabled={canEdit === false} onClick={() => del(i)} data-testid="struct-del"><Trash2 aria-hidden /></Button>
        </span>
      </div>

      {withText && (
        <div className="flex flex-col gap-2">
          <textarea className={cn(inputCls, kind === 'p' ? 'min-h-24' : 'min-h-lg-control font-semibold')} value={b.text} disabled={!canEdit}
            onChange={(e) => patch(i, { text: e.target.value })} data-testid={`struct-text-${kind}`} />
          {kind === 'p' && b.text && (
            <div className="rounded-sm bg-app p-2 text-sm leading-relaxed" data-testid="struct-para-preview">{renderInline(b.text, num)}</div>
          )}
          <RefChips objects={objects} num={num} onInsert={insertRef('text')} />
        </div>
      )}

      {kind === 'formula' && (
        <div className="flex flex-col gap-2">
          <textarea className={cn(inputCls, 'min-h-16 font-mono text-xs')} value={b.latex} disabled={!canEdit} spellCheck={false}
            placeholder="LaTeX 数学子集，如 \frac{\sum_i w_i x_i}{n}"
            onChange={(e) => patch(i, { latex: e.target.value })} data-testid="struct-formula-latex" />
          <div className="overflow-x-auto rounded-sm bg-app p-3 text-center text-base" data-testid="struct-formula-preview"
            dangerouslySetInnerHTML={{ __html: ktHtml(b.latex, true) }} />
          {(() => {
            const bad = formulaWarn(b.latex)
            return bad.length > 0 ? (
              <p className="text-2xs text-red-600" data-testid="struct-formula-warn">导出将被阻断：不支持 {bad.join('、')}</p>
            ) : null
          })()}
        </div>
      )}

      {kind === 'figure' && (
        <div className="flex flex-col gap-2">
          {b.resource ? (
            <img src={`/api/projects/${encodeURIComponent(pid)}/struct/resources/${encodeURIComponent(b.resource)}`}
              alt="图资源预览" className="max-h-48 self-start rounded-sm border border-border" data-testid="struct-figure-img" />
          ) : (
            <p className="text-2xs text-red-600">未上传图片（导出门禁将阻断）</p>
          )}
          {canEdit && (
            <input type="file" accept="image/png,image/jpeg,image/gif" className="text-xs"
              onChange={async (e) => {
                const f = e.target.files?.[0]
                if (!f) return
                try {
                  const r = await structApi.uploadResource(pid, f)
                  patch(i, { resource: r.rid })
                } catch (err) {
                  window.alert(`图片上传失败：${errText(err)}`)
                }
              }}
              data-testid="struct-figure-upload" />
          )}
          <input className={inputCls} value={b.caption} disabled={!canEdit} placeholder="图题（编号自动）"
            onChange={(e) => patch(i, { caption: e.target.value })} data-testid="struct-figure-caption" />
          <RefChips objects={objects} num={num} onInsert={insertRef('caption')} />
        </div>
      )}

      {kind === 'table' && <TableEditor b={b} i={i} canEdit={canEdit} patch={patch} num={num} objects={objects} />}
    </article>
  )
}

function TableEditor({ b, i, canEdit, patch, num, objects }: {
  b: Extract<StructBlock, { type: 'table' }>
  i: number
  canEdit: boolean
  patch: (i: number, p: Partial<StructBlock>) => void
  num: Record<string, string>
  objects: ObjEntry[]
}) {
  const rows = b.rows.length ? b.rows : [['', '']]
  const ncol = Math.max(b.header.length, ...rows.map((r) => r.length), 1)
  const setCell = (r: number, c: number, v: string) => {
    const next = rows.map((row) => [...row])
    while (next[r].length <= c) next[r].push('')
    next[r][c] = v
    patch(i, { rows: next })
  }
  const setHead = (c: number, v: string) => {
    const head = [...(b.header.length ? b.header : Array.from({ length: ncol }, () => ''))]
    while (head.length <= c) head.push('')
    head[c] = v
    patch(i, { header: head })
  }
  const addRow = () => patch(i, { rows: [...rows, Array.from({ length: ncol }, () => '')] })
  const addCol = () => patch(i, {
    header: b.header.length ? [...b.header, ''] : [],
    rows: rows.map((r) => [...r, '']),
  })
  const delCol = () => {
    if (ncol <= 1) return
    patch(i, {
      header: b.header.length ? b.header.slice(0, -1) : [],
      rows: rows.map((r) => r.slice(0, -1)),
    })
  }

  return (
    <div className="flex flex-col gap-2">
      <input className={inputCls} value={b.caption} disabled={!canEdit} placeholder="表题（编号自动）"
        onChange={(e) => patch(i, { caption: e.target.value })} data-testid="struct-table-caption" />
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr>
              {b.header.length > 0
                ? b.header.map((h, c) => (
                  <th key={c} className="border border-border p-1">
                    <input className={cn(inputCls, 'font-semibold')} value={h} disabled={!canEdit}
                      onChange={(e) => setHead(c, e.target.value)} aria-label={`表头第${c + 1}列`} />
                  </th>
                ))
                : <th className="border border-border p-1 text-fg-muted">（无表头）</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>
                {Array.from({ length: ncol }, (_, c) => (
                  <td key={c} className="border border-border p-1">
                    <input className={inputCls} value={row[c] ?? ''} disabled={!canEdit}
                      onChange={(e) => setCell(r, c, e.target.value)} aria-label={`第${r + 1}行第${c + 1}列`} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canEdit && (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="xs" onClick={addRow} data-testid="struct-table-add-row">加行</Button>
          <Button variant="outline" size="xs" onClick={addCol} data-testid="struct-table-add-col">加列</Button>
          <Button variant="outline" size="xs" onClick={delCol} disabled={ncol <= 1}>减列</Button>
        </div>
      )}
      <RefChips objects={objects} num={num} onInsert={(full) => patch(i, { caption: `${b.caption}[[${full}]]` } as Partial<StructBlock>)} />
    </div>
  )
}

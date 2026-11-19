import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, EditorView as EV } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { autocompletion, type CompletionContext } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { search, searchKeymap } from '@codemirror/search'
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting, StreamLanguage, type StreamParser } from '@codemirror/language'
import { stexMath } from '@codemirror/legacy-modes/mode/stex'
import katex from 'katex'
import { BookOpen, Crosshair, Download, Eye, EyeOff, FileDown, FolderInput, History, MessageSquarePlus, Play, Plus, RefreshCw, Reply, Search, Sigma, Sparkles, SquareFunction, Upload, Users, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SplitPane } from '@/components/shell/SplitPane'
import { cn } from '@/lib/utils'
import { latexApi, type DocxExportManifest, type LatexBuildInfo, type LatexBuildOutcome, type LatexDiagnostic, type LatexFileInfo, type WordExportManifest } from '@/lib/api/latex'
import { paperProposalApi, type FixVerification } from '@/lib/api/paperProposals'
import { libraryApi } from '@/lib/api/library'
import { ProjectContentIndex } from './editorSearch'
import { makeCiteSource, makeRefSource, type CiteCandidate } from './citeCompletions'
import { Settings2 } from 'lucide-react'
import { errorKind } from '@/lib/api/net'
import { useStudio } from '@/store'
import { SaveBuildController, type ControllerSnapshot } from './saveBuild'
import { CommentsSidebar } from './CommentsSidebar'
import { LibraryPanel } from './LibraryPanel'
import { ProposalPanel } from './ProposalPanel'
import { RebuttalPanel } from '../rebuttal/RebuttalPanel'
import { applyToView, locateAnchor, revertInView, type AnchorLike } from './proposalApply'
import { createDraftStore, type DraftStore } from './latexDraft'
import { LatexFileTree } from './LatexFileTree'
import { LatexHistory } from './LatexHistory'
import { LatexGitPanel } from './LatexGitPanel'
import { CrossFileSearch } from './CrossFileSearch'
import { SymbolPanel } from './SymbolPanel'
import { LatexIssues } from './LatexIssues'
import { LatexPreflight } from './LatexPreflight'
import { BRAND_NAME } from '@/lib/brand'
import './latex-workbench.css'

/**
 * w21 批A：LaTeX 工程最小工作台（单人编辑闭环）。
 * 形态：左侧文件列表 + 可拖拽左右分栏（源码 | 实时 PDF 预览）+ 底部状态栏。
 * 保存/编译调度全部在 SaveBuildController（saveBuild.ts，含竞态测试）：
 * - 打字停顿 2s 自动保存（恒开）；自动编译开启时保存完成点接着编译；
 * - 保存飞行中编辑/切换、409 冲突、请求乱序等竞态由 controller 处理；
 * - 冲突态暂停自动链，用户显式选择「覆盖服务器」或「放弃本地修改」。
 * 边界：不接协同、不渲染 AI/批注/修订入口、不支持文件新建/删除/上传。
 */
// pdf.js 体积大且依赖 DOMMatrix：随工作台 lazy 加载，避免拉进测试环境（同 AttachmentPreview 惯例）
const LatexPdf = lazy(() => import('@/components/attachments/AttachmentPdf'))

function errText(e: unknown): string {
  const anyErr = e as { message?: string; detail?: { message?: string } }
  return anyErr?.detail?.message || anyErr?.message || String(e)
}

function shortId(buildId: string | undefined | null): string {
  return buildId ? buildId.slice(-6) : '—'
}

export function LatexWorkbench({ pid }: { pid: string }) {
  const project = useStudio((s) => s.project)
  const authStatus = useStudio((s) => s.authStatus)
  const userEmail = useStudio((s) => s.user?.email ?? null)
  const openCollabCenter = useStudio((s) => s.openCollabCenter)
  // 正文编辑权：后端 my_role（off ⇒ null 可写）；viewer/reviewer 只读（reviewer 可评论不可改正文）
  const role = useStudio((s) => s.project?.role) as
    | 'owner'
    | 'editor'
    | 'agent'
    | 'reviewer'
    | 'viewer'
    | null
    | undefined
  const canEdit = role == null || role === 'owner' || role === 'editor' || role === 'agent'
  const main = project?.settings?.latex?.main ?? 'main.tex'
  const engine = project?.settings?.latex?.engine ?? 'pdflatex'
  const title = project?.title ?? pid
  const initialBuild = useRef<string | null>(null)

  const [files, setFiles] = useState<LatexFileInfo[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [loadErr, setLoadErr] = useState('')
  const [autoBuild, setAutoBuild] = useState(true)
  const [snap, setSnap] = useState<ControllerSnapshot | null>(null)
  const [outcome, setOutcome] = useState<LatexBuildOutcome | null>(null)
  const [builds, setBuilds] = useState<LatexBuildInfo[]>([])
  const [previewBuildId, setPreviewBuildId] = useState<string | null>(null)
  const [previewIsOld, setPreviewIsOld] = useState(false)
  const [paneW, setPaneW] = useState(600)
  const [sideTab, setSideTab] = useState<'comments' | 'library' | 'proposals' | 'rebuttal' | null>(null)
  const [cursorLine, setCursorLine] = useState<number | null>(null)
  const [locateFlash, setLocateFlash] = useState('')
  const [reloadTick, setReloadTick] = useState(0)
  const [draftProposal, setDraftProposal] = useState<{ path: string; content: string; savedAt: number } | null>(null)
  const [draftRestored, setDraftRestored] = useState(false)
  const [storageOk, setStorageOk] = useState(true)
  // DOCX 实验性导出（jcip；后端 PATENT_STUDIO_DOCX_EXPORT=on 才可用，404 时按钮隐藏语义=不可用提示）
  const [exporting, setExporting] = useState(false)
  const [exportResult, setExportResult] = useState<DocxExportManifest | null>(null)
  const [exportErr, setExportErr] = useState('')
  const [exportAvailable, setExportAvailable] = useState(true)
  // 通用 Word 导出（v0.6.7 导师阅读版）
  const [wordExporting, setWordExporting] = useState(false)
  const [wordResult, setWordResult] = useState<WordExportManifest | null>(null)
  const [wordExportErr, setWordExportErr] = useState('')
  const [wordHistory, setWordHistory] = useState<WordExportManifest[]>([])
  // v0.2：编译设置（主文件/引擎）——服务端持久化；改配置后旧构建在前端标记「旧配置」
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsBusy, setSettingsBusy] = useState(false)
  const [configStamp, setConfigStamp] = useState(0)
  const [exportHistory, setExportHistory] = useState<DocxExportManifest[]>([])
  const [preview, setPreview] = useState<{ path: string; kind: 'image' | 'pdf' } | null>(null)
  const [sideView, setSideView] = useState<'files' | 'issues' | 'preflight' | 'history' | 'git'>('files')
  const [panelNote, setPanelNote] = useState('')
  const [previewScroll, setPreviewScroll] = useState<{ page: number; n: number } | null>(null)
  const [symbolsOpen, setSymbolsOpen] = useState(false)
  const [searchSignal, setSearchSignal] = useState(0)
  const [mathSel, setMathSel] = useState('')
  const uploadRef = useRef<HTMLInputElement | null>(null)
  const zipRef = useRef<HTMLInputElement | null>(null)
  const previewBodyRef = useRef<HTMLDivElement | null>(null)
  const draftWriteTimer = useRef<number | undefined>(undefined)
  const viewRef = useRef<EditorView | null>(null)

  // 本地草稿存储（localStorage 不可用时置空并明确提示，编辑器照常可用）
  const draftStore = useMemo((): DraftStore => {
    let storage: Storage | null = null
    try {
      storage = window.localStorage
    } catch {
      storage = null
    }
    return createDraftStore(storage)
  }, [])
  useEffect(() => {
    setStorageOk(draftStore.available())
  }, [draftStore])
  // 用户/实例范围：authed 用邮箱；off/anon 同一浏览器视为同一人
  const userScope = authStatus === 'authed' && userEmail ? `u:${userEmail}` : 'anon'
  const scopeRef = useRef(userScope)
  useEffect(() => {
    scopeRef.current = userScope
  }, [userScope])

  // PDF 页宽随预览栏实测宽度（分栏可拖拽；AttachmentPdf 挂载瞬间自测量会取到未稳定的小宽度）
  useEffect(() => {
    const el = previewBodyRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0].contentRect.width)
      if (w > 100) setPaneW(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const refreshBuilds = useCallback(async () => {
    try {
      const reply = await latexApi.builds(pid)
      setBuilds(reply.builds)
      return reply
    } catch {
      return null
    }
  }, [pid])

  // ---- 编辑器三件套数据层（v0.6）：工程内容索引 + 引用候选 ----
  // 索引/候选都活在 ref（CM 整体重建不丢缓存）；失效是显式的：保存、文件树增删改、文献变更。
  const contentIndexRef = useRef<ProjectContentIndex | null>(null)
  if (!contentIndexRef.current) {
    contentIndexRef.current = new ProjectContentIndex({
      list: () => latexApi.files(pid),
      read: (path) => latexApi.read(pid, path),
    })
  }
  const contentIndex = contentIndexRef.current
  const refreshIndex = useCallback(() => {
    contentIndex.invalidate()
    void contentIndex.ensure().catch(() => { /* 索引失败静默：搜索/补全降级为空，不影响编辑 */ })
  }, [contentIndex])
  const citeDataRef = useRef<{ cites: CiteCandidate[] }>({ cites: [] })
  const [libraryStamp, setLibraryStamp] = useState(0)
  const onLibraryChanged = useCallback(() => {
    refreshIndex()
    setLibraryStamp((t) => t + 1)
  }, [refreshIndex])
  useEffect(() => {
    let cancelled = false
    libraryApi.get(pid).then((r) => {
      if (cancelled) return
      citeDataRef.current = { cites: r.entries }
    }).catch(() => { /* 文献库不可用时补全为空 */ })
    return () => { cancelled = true }
  }, [pid, libraryStamp])
  useEffect(() => {
    refreshIndex()
  }, [refreshIndex, pid])

  // ---- 调度控制器（保存/编译竞态全部在此，见 saveBuild.ts） ----
  const ctrlRef = useRef<SaveBuildController | null>(null)
  if (!ctrlRef.current) {
    ctrlRef.current = new SaveBuildController(
      {
        save: (path, content, base) => latexApi.save(pid, path, content, base ?? undefined),
        reload: (path) => latexApi.read(pid, path),
        build: async (eng) => {
          const out: LatexBuildOutcome = await latexApi.build(pid, eng)
          setOutcome(out)
          return { buildId: out.build_id, status: out.status, durationMs: out.duration_ms }
        },
        isConflict: (e) => errorKind(e) === 'stale',
        isForbidden: (e) => {
          const anyErr = e as { status?: number; response?: { status?: number } }
          return anyErr?.status === 403 || anyErr?.response?.status === 403
        },
        message: errText,
        schedule: (fn, ms) => {
          const t = window.setTimeout(fn, ms)
          return () => window.clearTimeout(t)
        },
        onBuildResult: (res) => {
          // 预览与产物跟随本次构建：失败时回退展示最近一次成功构建并明确标注
          setPreviewBuildId(res.buildId)
          setPreviewIsOld(false)
          void refreshBuilds().then((reply) => {
            if (res.status !== 'ok') {
              setPreviewBuildId(reply?.latest_ok_build_id ?? null)
              setPreviewIsOld(!!reply?.latest_ok_build_id)
            }
          })
        },
      },
      {
        onSaved: (path, _sha, contentAtSend) => {
          // 服务器内容 == 本次请求内容 == 当前本地内容 ⇒ 草稿使命完成；
          // 若飞行中/之后又有输入（content 不一致），草稿保留最新内容
          if (ctrl.getContent() === contentAtSend) {
            draftStore.removeDraft(userScope, pid, path)
          }
          refreshIndex()
        },
      },
      engine,
    )
  }
  const ctrl = ctrlRef.current

  // DOCX 实验性导出：产物必须来自最近一次已保存内容——有未保存修改时先触发保存并
  // 等待落定；保存冲突/失败/权限丢失一律取消导出（不得导出旧内容并提示成功）。
  const runDocxExport = useCallback(async () => {
    if (exporting) return
    setExportErr('')
    setExporting(true)
    try {
      let s = ctrl.snapshot()
      if (s.dirty || s.saving) {
        ctrl.saveNow()
        const deadline = Date.now() + 15000
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 200))
          s = ctrl.snapshot()
          if (s.conflict || s.permLost) {
            setExportErr(s.conflict ? '保存存在冲突，已取消导出（请先解决冲突）' : '保存失败（无写入权限），已取消导出')
            return
          }
          if (!s.dirty && !s.saving) break
        }
        if (s.dirty || s.saving) {
          setExportErr('保存未在限时内完成，已取消导出（请稍后重试）')
          return
        }
      }
      const m = await latexApi.exportDocx(pid)
      setExportResult(m)
    } catch (e) {
      if (errorKind(e) === 'not_found') {
        setExportAvailable(false)
        setExportErr('DOCX 导出未在本部署开启（PATENT_STUDIO_DOCX_EXPORT=on）')
      } else {
        setExportErr(e instanceof Error ? e.message : '导出失败')
      }
    } finally {
      setExporting(false)
    }
  }, [exporting, ctrl, pid])

  // 通用 Word 导出（v0.6.7 导师阅读版）：与 DOCX 实验导出同一「先保存落定」守卫；
  // pandoc 转换语义而非排版结果——banner 明示需人工核对。
  const runWordExport = useCallback(async () => {
    if (wordExporting) return
    setWordExportErr('')
    setWordExporting(true)
    try {
      let s = ctrl.snapshot()
      if (s.dirty || s.saving) {
        ctrl.saveNow()
        const deadline = Date.now() + 15000
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 200))
          s = ctrl.snapshot()
          if (s.conflict || s.permLost) {
            setWordExportErr(s.conflict ? '保存存在冲突，已取消导出（请先解决冲突）' : '保存失败（无写入权限），已取消导出')
            return
          }
          if (!s.dirty && !s.saving) break
        }
        if (s.dirty || s.saving) {
          setWordExportErr('保存未在限时内完成，已取消导出（请稍后重试）')
          return
        }
      }
      const m = await latexApi.exportWord(pid)
      setWordResult(m)
      void latexApi.wordExports(pid).then((r) => setWordHistory(r.exports.slice(0, 3))).catch(() => {})
    } catch (e) {
      setWordExportErr(e instanceof Error ? e.message : '导出失败')
    } finally {
      setWordExporting(false)
    }
  }, [wordExporting, ctrl, pid])

  // Word 导出记录（最近 3 条；源码变更后旧导出标记 stale）
  useEffect(() => {
    let alive = true
    latexApi
      .wordExports(pid)
      .then((r) => {
        if (alive) setWordHistory(r.exports.slice(0, 3))
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [pid])

  // 导出记录（最近 3 条；源码变更后旧导出标记 stale=对应旧内容）
  useEffect(() => {
    let alive = true
    latexApi
      .docxExports(pid)
      .then((r) => {
        if (alive) setExportHistory(r.exports.slice(0, 3))
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [pid, exportResult])

  // 编辑事件包装：草稿合并写入（600ms 防抖；markEdited 解除丢弃名单）
  useEffect(() => {
    const orig = ctrl.edit.bind(ctrl)
    ctrl.edit = (content: string) => {
      const p = ctrl.getPath()
      if (p) draftStore.markEdited(userScope, pid, p)
      orig(content)
      if (draftWriteTimer.current) window.clearTimeout(draftWriteTimer.current)
      draftWriteTimer.current = window.setTimeout(() => {
        draftWriteTimer.current = undefined
        const pp = ctrl.getPath()
        if (pp) draftStore.saveDraft(userScope, pid, pp, ctrl.getContent(), null)
      }, 600)
    }
    return () => {
      ctrl.edit = orig
      if (draftWriteTimer.current) window.clearTimeout(draftWriteTimer.current)
    }
  }, [ctrl, draftStore, pid, userScope])

  useEffect(() => ctrl.subscribe(setSnap), [ctrl])
  // 草稿恢复态跟随保存闭环：显式保存成功（draftPaused 解除）后撤掉恢复提示条
  useEffect(() => {
    if (draftRestored && snap && !snap.draftPaused && !snap.dirty && !snap.saving) {
      setDraftRestored(false)
    }
  }, [draftRestored, snap])
  // 未保存内容离页提示（补充手段；真正的保护是本地草稿恢复）
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (ctrl.isDirty()) {
        e.preventDefault()
      }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [ctrl])

  // Ctrl/Cmd+S：立即保存（写作者本能操作；不依赖自动保存的 2s 停顿）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (!canEdit) return
        const s = ctrl.snapshot()
        if (s.dirty && !s.saving && !s.conflict) ctrl.saveNow()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ctrl, canEdit])

  useEffect(() => ctrl.setEngine(engine), [ctrl, engine])
  useEffect(
    () => () => {
      ctrl.dispose()
    },
    [ctrl],
  )

  // ---- 文件打开 ----

  /** 打开文件后检查本地草稿：与服务器相同 ⇒ 静默清理；不同 ⇒ 出恢复选择条（不自动覆盖服务器）。 */
  const checkDraftAfterOpen = useCallback(
    (rel: string, serverContent: string, cancelled: () => boolean) => {
      const draft = draftStore.loadDraft(userScope, pid, rel)
      if (cancelled()) return
      if (!draft) {
        setDraftProposal(null)
        return
      }
      if (draft.content === serverContent) {
        // 服务器已保存相同内容：清草稿，不重复提示
        draftStore.removeDraft(userScope, pid, rel)
        setDraftProposal(null)
      } else {
        setDraftProposal({ path: rel, content: draft.content, savedAt: draft.savedAt })
      }
    },
    [draftStore, pid, userScope],
  )

  const openFile = useCallback(
    async (rel: string) => {
      try {
        const read = await latexApi.read(pid, rel)
        ctrl.open(rel, read.content, read.sha)
        setActive(rel)
        setReloadTick((t) => t + 1) // CM 按新内容整体重建
        setDraftRestored(false)
        checkDraftAfterOpen(rel, read.content, () => false)
      } catch (e) {
        setLoadErr(errText(e))
      }
    },
    [pid, ctrl, checkDraftAfterOpen],
  )

  const switchFile = useCallback(
    (rel: string) => {
      if (rel === active) return
      if (ctrl.isDirty() && !window.confirm('当前文件有未保存修改，放弃并切换？')) return
      void openFile(rel)
    },
    [active, ctrl, openFile],
  )

  /** 版本历史恢复：确认未保存修改 → 整树恢复 → 文件清单/编辑器/索引/构建列表全部刷新。
   *  恢复可能增删文件、改动当前打开文件——恢复后打开原文件；原文件没了则回落主文件。 */
  const handleHistoryRestore = useCallback(
    async (sha: string): Promise<string | null> => {
      if (ctrl.isDirty() && !window.confirm('当前有未保存的修改，恢复将丢弃这些修改。继续？')) return null
      const r = await latexApi.restoreVersion(pid, sha)
      refreshIndex()
      const reply = await latexApi.files(pid)
      setFiles(reply.files)
      const cur = ctrl.getPath()
      const target = (cur ? reply.files.find((f) => f.path === cur && f.editable) : null)
        ?? reply.files.find((f) => f.path === main && f.editable)
        ?? reply.files.find((f) => f.editable)
      if (target) {
        await openFile(target.path)
      } else {
        setActive(null)
      }
      void refreshBuilds() // 源码变化 → 构建列表 stale 标记刷新
      const deletedNote = r.deleted.length ? `，删除 ${r.deleted.length} 个多余文件` : ''
      return `已恢复 ${r.written} 个文件${deletedNote}${r.changed ? '' : '（与当前内容一致，无变化）'}`
    },
    [pid, ctrl, main, refreshIndex, refreshBuilds, openFile],
  )

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const reply = await latexApi.files(pid)
        if (cancelled) return
        setFiles(reply.files)
        const first = reply.files.find((f) => f.path === main && f.editable) ?? reply.files.find((f) => f.editable)
        if (first) {
          const read = await latexApi.read(pid, first.path)
          if (cancelled) return
          ctrl.open(first.path, read.content, read.sha)
          setActive(first.path)
          setReloadTick((t) => t + 1)
          checkDraftAfterOpen(first.path, read.content, () => cancelled)
        }
        const buildsReply = await refreshBuilds()
        // 刷新后恢复真实最近构建：失败态不被隐藏——最近一次构建失败时展示最近成功产物并标注「非本次结果」
        if (!cancelled && buildsReply) {
          if (buildsReply.latest_ok_build_id) {
            setPreviewBuildId(buildsReply.latest_ok_build_id)
            setPreviewIsOld(!!buildsReply.builds.length && buildsReply.builds[0].status !== 'ok')
          }
          if (first && !buildsReply.builds.length && initialBuild.current !== pid && canEdit && !draftStore.loadDraft(userScope, pid, first.path)) {
            initialBuild.current = pid
            ctrl.buildNow()
          }
        }
      } catch (e) {
        if (!cancelled) setLoadErr(errText(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [pid, main, refreshBuilds, ctrl, checkDraftAfterOpen])

  // ---- 编辑器 ----

  const st = useMemo(
    () =>
      EditorState.create({
        doc: ctrl.getContent(),
        extensions: [
          lineNumbers(),
          history(),
          drawSelection(),
          highlightActiveLine(),
          bracketMatching(),
          EV.lineWrapping,
          StreamLanguage.define(stexMath as unknown as StreamParser<unknown>),
          syntaxHighlighting(defaultHighlightStyle),
          keymap.of([
            { key: 'Mod-Shift-f', run: () => { setSearchSignal((t) => t + 1); return true } },
            ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab,
          ]),
          search({ top: true }),
          // 引用补全（\cite 家族→文献库 keys；\ref 家族→全工程 \label）——只读角色不挂
          ...(canEdit
            ? [autocompletion({
                override: [
                  (ctx: CompletionContext) => makeCiteSource(citeDataRef.current.cites)(ctx),
                  (ctx: CompletionContext) =>
                    makeRefSource(contentIndex.ready ? contentIndex.collectLabels() : [])(ctx),
                ],
                icons: false,
              })]
            : []),
          // 只读角色（viewer/reviewer）：可选择/复制/搜索/定位，不能编辑正文
          ...(canEdit ? [] : [EditorState.readOnly.of(true), EV.editable.of(false)]),
          // CM 全高模式：.cm-scroller 是唯一滚动容器（修复外层双滚动/全高撑破布局）
          EditorView.theme({
            "&": { height: "100%" },
            ".cm-scroller": { overflow: "auto" },
          }),
          // 文档变化 → controller（保存内容/竞态处理全在 controller；漏同步=保存回写旧内容的实测事故）
          EV.updateListener.of((u) => {
            if (u.docChanged) ctrl.edit(u.state.doc.toString())
              if (u.selectionSet) {
                setCursorLine(u.state.doc.lineAt(u.state.selection.main.head).number)
                // 选区是完整公式时 → 底部 KaTeX 预览（v0.4.2）
                const selText = u.state.sliceDoc(u.state.selection.main.from, u.state.selection.main.to).trim()
                setMathSel(/^(?:\$\$[\s\S]+\$\$|\$[^$\n]+\$|\\\[[\s\S]+\\\]|\\\([\s\S]+\\\))$/.test(selText) ? selText : '')
              }
          }),
        ],
      }),
    // 内容在打开/冲突重载/只读切换时整体重建；日常编辑走 view 内部状态
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [active, reloadTick, canEdit],
  )

  const jumpTo = useCallback(
    (file: string, line: number | null) => {
      const view = viewRef.current
      if (!view || file !== ctrl.getPath() || line == null) return
      const total = view.state.doc.lines
      const ln = Math.min(Math.max(1, line), total)
      const pos = view.state.doc.line(ln).from
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true })
      view.focus()
    },
    [ctrl],
  )

  // ---- 文献引用插入 / AI 提案落地（v0.4） ----

  /** 在面板打开前的光标/选区处插入引用（CM state 保留选区；不落焦不丢位置）。 */
  const insertCitations = useCallback(
    (entries: { citation_key: string }[], command: string) => {
      const keys = entries.map((e) => e.citation_key)
      const view = viewRef.current
      if (!view || !active) return
      const sel = view.state.selection.main
      const ins = `\\${command}{${keys.join(',')}}`
      view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: ins },
        selection: { anchor: sel.from + ins.length },
        scrollIntoView: true,
        userEvent: 'input.cite',
      })
      view.focus()
    },
    [active],
  )

  const getSelection = useCallback(() => {
    const view = viewRef.current
    if (!view || !active) return null
    const { from, to } = view.state.selection.main
    const doc = view.state.doc.toString()
    return { text: doc.slice(from, to), doc, from, to }
  }, [active])

  const doApplyProposal = useCallback(
    (anchor: AnchorLike, suggested: string) =>
      applyToView(viewRef.current, anchor, suggested, active, active ?? ''),
    [active],
  )

  const doRevertProposal = useCallback(
    (anchor: AnchorLike, appliedText: string) =>
      revertInView(viewRef.current, anchor, appliedText, active, active ?? ''),
    [active],
  )

  /** 定位提案原文（不改内容）：必要时先切换文件。 */
  const locateProposal = useCallback(
    (anchor: AnchorLike & { file: string }) => {
      const go = () => {
        const view = viewRef.current
        if (!view) return
        const doc = view.state.doc.toString()
        const loc = locateAnchor(doc, anchor)
        if (loc.ok) {
          view.dispatch({ selection: { anchor: loc.start, head: loc.end }, scrollIntoView: true })
          view.focus()
          setLocateFlash('')
        } else {
          setLocateFlash(loc.reason === 'ambiguous' ? '定位：原文出现多处且无法消歧' : '定位：原文已变化（找不到该段）')
          window.setTimeout(() => setLocateFlash(''), 4000)
        }
      }
      if (anchor.file !== ctrl.getPath()) {
        void openFile(anchor.file).then(go)
      } else {
        go()
      }
    },
    [ctrl, openFile],
  )

  // ---- 派生 ----


  // ---- 工程文件面板：新建 / 上传 / ZIP 合并 / 整包下载（CoCraft 式工具条） ----

  const reloadFiles = useCallback(async () => {
    try {
      setFiles((await latexApi.files(pid)).files)
    } catch { /* 刷新失败保旧列表 */ }
  }, [pid])

  useEffect(() => {
    if (!panelNote) return
    const t = window.setTimeout(() => setPanelNote(''), 8000)
    return () => window.clearTimeout(t)
  }, [panelNote])

  const activeDir = active && active.includes('/') ? active.slice(0, active.lastIndexOf('/')) : ''

  const onNewFile = useCallback(async () => {
    const raw = window.prompt('新建文件：输入 ZIP 内相对路径（如 sections/method.tex）')
    if (!raw) return
    const rel = raw.trim().replace(/^\.\//, '').replace(/^\/+/, '')
    if (!rel) return
    try {
      await latexApi.createFile(pid, rel)
      await reloadFiles()
      refreshIndex()
      setPanelNote(`已创建 ${rel}`)
      void switchFile(rel)
    } catch (e) {
      const msg = errText(e)
      setPanelNote(`新建失败：${msg}`)
    }
  }, [pid, reloadFiles, switchFile, refreshIndex])

  const onUploadFiles = useCallback(async (list: FileList) => {
    const dir = activeDir
    const failures: string[] = []
    let ok = 0
    for (const f of Array.from(list)) {
      const rel = dir ? `${dir}/${f.name}` : f.name
      try {
        await latexApi.uploadFile(pid, rel, f)
        ok += 1
      } catch (e) {
        failures.push(`${rel}（${errText(e)}）`)
      }
    }
    await reloadFiles()
    refreshIndex()
    setPanelNote(`已上传 ${ok} 个文件${failures.length ? `；失败 ${failures.length} 个：${failures.join('；')}` : ''}`)
  }, [activeDir, pid, reloadFiles, refreshIndex])

  const onUploadZip = useCallback(async (f: File) => {
    try {
      const r = await latexApi.uploadZipMerge(pid, f)
      const parts = [`新增 ${r.added.length} 个文件`]
      if (r.skipped_existing.length) parts.push(`跳过已存在 ${r.skipped_existing.length} 个`)
      if (r.skipped_rejected.length) parts.push(`忽略不支持 ${r.skipped_rejected.length} 个`)
      setPanelNote(parts.join('；'))
      setSideView('files')
      await reloadFiles()
      refreshIndex()
    } catch (e) {
      setPanelNote(`ZIP 合并失败：${errText(e)}`)
    }
  }, [pid, reloadFiles, refreshIndex])

  const onRenameFile = useCallback(async (rel: string) => {
    const raw = window.prompt(`重命名/移动文件\n当前：${rel}\n输入新路径（含目录）：`, rel)
    if (!raw || raw.trim() === rel) return
    const newPath = raw.trim().replace(/^\.\//, '').replace(/^\/+/, '')
    if (!newPath) return
    try {
      const r = await latexApi.renameFile(pid, rel, newPath)
      await reloadFiles()
      refreshIndex()
      setPanelNote(`已重命名为 ${r.path}${r.main_updated ? '（编译主文件已同步更新）' : ''}`)
      if (active === rel) await openFile(r.path)
    } catch (e) {
      setPanelNote(`重命名失败：${errText(e)}`)
    }
  }, [pid, active, reloadFiles, openFile, refreshIndex])

  const onDeleteFile = useCallback(async (rel: string) => {
    if (!window.confirm(`删除文件「${rel}」？\n此操作不可恢复（不影响已构建的 PDF 与提案历史）。`)) return
    try {
      await latexApi.deleteFile(pid, rel)
      await reloadFiles()
      refreshIndex()
      setPanelNote(`已删除 ${rel}`)
      if (active === rel) {
        const next = files.find((f) => f.editable && f.path !== rel)
        if (next) await openFile(next.path)
      }
    } catch (e) {
      setPanelNote(`删除失败：${errText(e)}`)
    }
  }, [pid, active, files, reloadFiles, openFile, refreshIndex])



  const dirty = snap?.dirty ?? false
  const savedSha = snap?.savedSha ?? null
  const saving = snap?.saving ?? false
  const building = snap?.building ?? false
  const conflict = snap?.conflict ?? false
  const permLost = snap?.permLost ?? false
  const notice = snap?.notice ?? null
  const error = snap?.error ?? null
  const diagList: LatexDiagnostic[] = outcome?.diagnostics ?? []
  const pdfUrl = previewBuildId
    ? `/api/projects/${encodeURIComponent(pid)}/latex/builds/${previewBuildId}/artifacts/pdf`
    : null
  const latest = builds[0]
  const staleNow = latest ? latest.stale : false
  // 配置变化晚于最新构建 ⇒ 旧构建结果按「旧配置」呈现（不冒充新配置成功）
  const configStale = configStamp > 0 && latest ? new Date(latest.started_at).getTime() < configStamp : false

  // ---- SyncTeX：源码行 ⇄ PDF 定位 ----

  const locateInPdf = useCallback(async () => {
    if (!previewBuildId || building || !active) return
    try {
      const r = await latexApi.synctexView(pid, previewBuildId, active, cursorLine ?? 1)
      setPreviewScroll({ page: r.page, n: Date.now() })
      setLocateFlash('')
    } catch (e) {
      setLocateFlash(`PDF 定位失败：${errText(e)}`)
      window.setTimeout(() => setLocateFlash(''), 4000)
    }
  }, [pid, previewBuildId, active, cursorLine, building])

  const onPdfClickLocate = useCallback(async (info: { page: number; xPt: number; yPt: number }) => {
    if (!previewBuildId || building) return
    try {
      const r = await latexApi.synctexEdit(pid, previewBuildId, info.page, info.xPt, info.yPt)
      if (r.file !== active) {
        await openFile(r.file)
        window.setTimeout(() => jumpTo(r.file, r.line), 250)
      } else {
        jumpTo(r.file, r.line)
      }
    } catch { /* 点击处无对应源码（图/空白），静默 */ }
  }, [pid, previewBuildId, building, active, openFile, jumpTo])

  // ---- AI 审稿 → Issues（外发确认在工作台，正文当前文件全文） ----

  /** 跨文件搜索命中跳转：跨文件先 openFile 再 jumpTo（同 Issues onJump 模式）。 */
  const jumpToSearchHit = useCallback(
    (path: string, line: number) => {
      if (path !== active) {
        void openFile(path).then(() => {
          window.setTimeout(() => jumpTo(path, line), 200)
        })
      } else {
        jumpTo(path, line)
      }
    },
    [active, openFile, jumpTo],
  )

  const aiReviewCurrentFile = useCallback(async (file: string): Promise<number> => {
    const content = ctrl.getContent()
    if (!content.trim()) {
      // 防御性拦截：空文件不弹 confirm、不发请求（错误由 Issues 面板 role=alert 呈现）
      throw new Error(`「${file}」当前内容为空，无法进行 AI 审阅`)
    }
    if (!window.confirm(
      `AI 审阅将把「${file}」全文（约 ${content.length} 字符）发送给你配置的模型进行审稿，\n生成的问题清单会逐条加入 Issues。\n\n继续发送？`)) {
      return -1
    }
    const r = await latexApi.aiReview(pid, file, content)
    return r.added
  }, [pid, ctrl])

  // ---- 修复闭环（v0.5）：从编译错误生成修复提案（显式触发）+ 采纳后重编译验证 ----

  const [proposalTick, setProposalTick] = useState(0)

  /** Issues 页签编译错误行的入口：定位错误文件与行 → 以该行±上下文为锚生成修复提案。
   *  外发范围仅该行±2 行与错误信息——与既有「选区外发」边界一致。 */
  const proposeFixFromDiag = useCallback(async (diag: LatexDiagnostic) => {
    if (!canEdit) return
    const file = diag.file.replace(/^\.\//, '')
    try {
      if (file !== active) {
        if (ctrl.isDirty() && !window.confirm('切换到错误所在文件会放弃当前未保存修改，继续？')) return
        await openFile(file)
        await new Promise((r) => setTimeout(r, 150))
      }
      if (ctrl.getPath() !== file) {
        setLoadErr(`无法打开 ${file}，请手动打开后再生成修复提案`)
        return
      }
      const lines = ctrl.getContent().split('\n')
      const pick = (n: number) => (n >= 1 && n <= lines.length ? lines[n - 1] : '')
      const ln = diag.line ?? 1
      let used = ln
      let lineText = pick(ln).trim()
      if (!lineText) {
        for (const d of [1, -1, 2, -2]) {
          if (pick(ln + d).trim()) { used = ln + d; lineText = pick(ln + d).trim(); break }
        }
      }
      if (!lineText) {
        setLoadErr('错误行附近没有可定位的文本——请手动选中相关代码后用「自定义修改」生成')
        return
      }
      const s = ctrl.snapshot()
      await paperProposalApi.generate(pid, {
        mode: 'latex',
        file,
        base_sha: s.savedSha || '0'.repeat(64),
        original_text: lineText.slice(0, 300),
        context_before: `${pick(used - 2)}\n${pick(used - 1)}`,
        context_after: `${pick(used + 1)}\n${pick(used + 2)}`,
        action: 'custom',
        instruction: `修复这行 LaTeX 的编译错误：${diag.message.slice(0, 300)}`,
        error_context: { file, line: diag.line, message: diag.message },
      })
      setSideTab('proposals')
      setProposalTick((t) => t + 1)
    } catch (e) {
      setLoadErr(errText(e))
    }
  }, [pid, ctrl, active, canEdit, openFile])

  /** 修复验证：等保存落定 → 服务端重编译对照 → 同步构建/预览面板状态。 */
  const verifyProposalFix = useCallback(async (proposalId: string): Promise<FixVerification> => {
    let s = ctrl.snapshot()
    if (s.dirty || s.saving) {
      ctrl.saveNow()
      const deadline = Date.now() + 20000
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200))
        s = ctrl.snapshot()
        if (s.conflict || s.permLost) {
          throw new Error(s.conflict ? '保存冲突，请先解决冲突再验证' : '保存失败（无写入权限），无法验证')
        }
        if (!s.dirty && !s.saving) break
      }
      if (s.dirty || s.saving) throw new Error('保存未在限时内完成，无法验证')
    }
    const r = await paperProposalApi.verifyFix(pid, proposalId)
    // verify 在服务端跑了真实构建：把工作台的构建/预览状态对齐到这次构建
    setPreviewBuildId(r.verification.build_id)
    setPreviewIsOld(r.verification.build_status !== 'ok')
    void refreshBuilds().then((reply) => {
      const latest = reply?.builds[0]
      if (latest) setOutcome({ ...latest, pdf_url: null, log_url: '' } as LatexBuildOutcome)
    })
    return r.verification
  }, [ctrl, pid, refreshBuilds])


  async function applyBuildSettings(main: string, engine: string): Promise<void> {
    if (!canEdit || settingsBusy) return
    setSettingsBusy(true)
    try {
      await latexApi.updateBuildSettings(pid, main, engine)
      setConfigStamp(Date.now())
      setSettingsOpen(false)
      // 服务端 settings 已持久化；本地 project 缓存里的 main/engine 一并刷新
      useStudio.setState((st) => ({
        project: st.project && st.project.id === pid
          ? { ...st.project, settings: { ...st.project.settings, latex: { main, engine } } }
          : st.project,
      }))
      setPreviewIsOld(true)
    } finally {
      setSettingsBusy(false)
    }
  }

  // 预览产物相对「正在编辑的内容」的状态表达（六态）
  const previewState = building
    ? 'building'
    : outcome && outcome.status === 'error'
      ? 'last-failed'
      : previewIsOld
        ? 'old-ok'
        : configStale
          ? '旧配置'
          : staleNow || dirty
          ? 'stale'
          : 'current'

  const insertAtCursor = useCallback((text: string) => {
    const view = viewRef.current
    if (!view || !canEdit) return
    const sel = view.state.selection.main
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: text },
      selection: { anchor: sel.from + text.length },
      scrollIntoView: true,
    })
    view.focus()
  }, [canEdit])

  const editorPane = (
    <section aria-label="源码编辑" className="flex h-full min-h-0 min-w-0 flex-col" data-testid="latex-editor">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-2 text-xs text-fg-muted">
        <span className="truncate">{active ?? '未打开文件'}</span>
        <span className="ml-auto shrink-0" data-testid="latex-edit-state">
          {canEdit
            ? saving
              ? '保存中…'
              : dirty
                ? draftRestored
                  ? '草稿已恢复（自动保存暂停）'
                  : permLost
                    ? '未保存（无写入权限，已暂停自动保存）'
                    : '未保存（停顿后自动保存）'
                : '已保存'
            : '只读访问（可批注）'}
          {!autoBuild && canEdit && !building && ' · 编译需手动'}
          {!storageOk && ' · 本地恢复不可用'}
        </span>
        <button
          type="button"
          className="shrink-0 rounded px-1.5 py-0.5 text-xs text-fg-muted transition-colors hover:bg-hover hover:text-fg"
          title="跨文件搜索（Ctrl+Shift+F）"
          onClick={() => setSearchSignal((t) => t + 1)}
          data-testid="latex-crossfile-toggle"
        >
          <Search aria-hidden className="mr-0.5 inline size-3.5" />
          搜索
        </button>
        <button
          type="button"
          className={cn('shrink-0 rounded px-1.5 py-0.5 text-xs transition-colors disabled:opacity-50',
            symbolsOpen ? 'bg-primary-soft text-primary' : 'text-fg-muted hover:bg-hover hover:text-fg')}
          disabled={!canEdit}
          title="符号面板（点击插入到光标处）"
          onClick={() => setSymbolsOpen((v) => !v)}
          data-testid="latex-symbols-toggle"
        >
          <Sigma aria-hidden className="mr-0.5 inline size-3.5" />
          符号
        </button>
        <button
          type="button"
          className="shrink-0 rounded px-1.5 py-0.5 text-xs text-fg-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-50"
          disabled={!previewBuildId || building || !active}
          title="在 PDF 中定位当前行（SyncTeX 正向）"
          onClick={() => void locateInPdf()}
          data-testid="latex-locate-pdf"
        >
          <Crosshair aria-hidden className="mr-0.5 inline size-3.5" />
          在 PDF 定位
        </button>
      </div>
      {symbolsOpen && (
        <div className="shrink-0 border-b border-line bg-panel">
          <SymbolPanel onInsert={insertAtCursor} onClose={() => setSymbolsOpen(false)} />
        </div>
      )}
      <div className="min-h-0 flex-1" data-testid="latex-cm-host">
        <CodeMirrorHost state={st} viewRef={viewRef} />
      </div>
      {mathSel && (
        <div className="shrink-0 border-t border-line bg-panel px-2 py-1.5" data-testid="latex-math-preview">
          <span className="mr-1.5 text-2xs text-fg-muted">公式预览</span>
          <span
            className="text-fg-strong"
            dangerouslySetInnerHTML={{
              __html: katex.renderToString(mathSel, { throwOnError: false, displayMode: mathSel.trimStart().startsWith('$$') }),
            }}
          />
        </div>
      )}
    </section>
  )

  const previewPane = (
    <section aria-label="编译与预览" className="flex h-full min-h-0 min-w-0 flex-col" data-testid="latex-preview">
      <div
        className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-2 text-xs"
        data-testid="latex-build-status"
      >
        {building ? (
          <>
            <RefreshCw aria-hidden className="size-3.5 animate-spin" />
            <span>编译中…</span>
          </>
        ) : (
          <>
            <span className={cn(outcome && outcome.status === 'error' ? 'text-danger' : 'text-fg-muted')}>
              {outcome
                ? `构建 ${shortId(outcome.build_id)} · ${outcome.status === 'ok' ? '成功' : outcome.status === 'canceled' ? '已取消' : '失败'} · ${engine} · ${outcome.duration_ms}ms`
                : latest
                  ? `最近构建 ${shortId(latest.build_id)} · ${latest.status === 'ok' ? '成功' : latest.status === 'canceled' ? '已取消' : '失败'}`
                  : '尚未编译'}
            </span>
            {previewState === 'old-ok' && <span className="text-warning">（展示的是历史成功构建，非本次结果）</span>}
            {previewState === 'stale' && <span className="text-warning">（源码已修改，预览可能过期）</span>}
            {previewState === 'last-failed' && <span className="text-danger">（最近一次编译失败）</span>}
            {outcome && outcome.status === 'canceled' && <span className="text-warning">（已手动取消）</span>}
            {exportAvailable && (
              <button
                type="button"
                className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-fg-muted hover:bg-hover hover:text-fg disabled:opacity-50"
                onClick={runDocxExport}
                disabled={exporting || Boolean(snap?.dirty)}
                title={snap?.dirty ? '请先保存（自动保存进行中或手动 Ctrl+S）后再导出' : '导出 DOCX（实验性，中文信息学报 profile）'}
                data-testid="latex-export-docx"
              >
                <FileDown aria-hidden className="size-3.5" />
                {exporting ? '导出中…' : '导出 DOCX（实验）'}
              </button>
            )}
            <button
              type="button"
              className={cn('inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-fg-muted hover:bg-hover hover:text-fg disabled:opacity-50', !exportAvailable && 'ml-auto')}
              onClick={runWordExport}
              disabled={wordExporting || Boolean(snap?.dirty)}
              title={snap?.dirty ? '请先保存（自动保存进行中或手动 Ctrl+S）后再导出' : '导出 Word（导师阅读版；转换语义而非排版结果，需人工核对）'}
              data-testid="latex-export-word"
            >
              <FileDown aria-hidden className="size-3.5" />
              {wordExporting ? '导出中…' : '导出 Word'}
            </button>
          </>
        )}
      </div>
      {wordExportErr && (
        <div role="alert" className="shrink-0 border-b border-line px-2 py-1 text-xs text-danger" data-testid="latex-word-error">
          {wordExportErr}
        </div>
      )}
      {wordResult && (
        <div className="shrink-0 border-b border-line px-2 py-1 text-xs" data-testid="latex-word-result">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'font-medium',
                wordResult.status === 'pass' && 'text-success',
                wordResult.status === 'degraded' && 'text-warning',
                wordResult.status === 'blocked' && 'text-danger',
              )}
            >
              Word 导出 · {wordResult.status === 'pass' ? '完成' : wordResult.status === 'degraded' ? '完成（有降级）' : '已阻断'}
            </span>
            {wordResult.artifacts['paper.docx'] && (
              <a
                className="underline hover:no-underline"
                href={latexApi.wordArtifactUrl(pid, wordResult.export_id, 'paper.docx')}
                download
                data-testid="latex-word-download"
              >
                下载 paper.docx
              </a>
            )}
            <span className="ml-auto text-fg-muted" title={`pandoc ${wordResult.tool.pandoc || '?'} · ${wordResult.tool.duration_ms}ms`}>
              {wordResult.tool.duration_ms}ms
            </span>
          </div>
          {wordResult.degrades.length > 0 && (
            <ul className="mt-0.5 space-y-0.5 text-warning">
              {wordResult.degrades.map((d, i) => (
                <li key={i}>· {d}</li>
              ))}
            </ul>
          )}
          <div className="mt-1 border-t border-line pt-1 leading-5 text-fg-muted" data-testid="latex-word-scope">
            导师阅读版：pandoc 转换源码语义，公式多数可转（OMML），自定义宏/浮动体版式/复杂表格可能走样——
            打开 Word 后请人工核对；非投稿格式承诺。历史导出见下方记录（源码已变更的标记为旧内容）。
          </div>
          {wordHistory.length > 0 && (
            <div className="mt-1 text-fg-muted" data-testid="latex-word-history">
              导出记录：
              <ul className="mt-0.5 space-y-0.5">
                {wordHistory.map((h) => (
                  <li key={h.export_id} className="flex items-center gap-2">
                    <span className="font-mono text-2xs">{h.export_id}</span>
                    {h.stale && <span className="text-warning">（旧内容）</span>}
                    {h.artifacts['paper.docx'] && !h.stale && (
                      <a className="underline hover:no-underline" href={latexApi.wordArtifactUrl(pid, h.export_id, 'paper.docx')} download>
                        下载
                      </a>
                    )}
                    {h.status !== 'pass' && <span className="text-warning">{h.status === 'degraded' ? '有降级' : '已阻断'}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {exportResult && (
        <div className="shrink-0 border-b border-line px-2 py-1 text-xs" data-testid="latex-export-result">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'font-medium',
                exportResult.status === 'pass' && 'text-success',
                exportResult.status === 'degraded' && 'text-warning',
                exportResult.status === 'blocked' && 'text-danger',
              )}
            >
              DOCX 导出（实验）· {exportResult.status === 'pass' ? '完成' : exportResult.status === 'degraded' ? '完成（有降级）' : '已阻断'}
            </span>
            {(['paper.docx', 'report.json'] as const).map((n) =>
              exportResult.artifacts[n] ? (
                <a
                  key={n}
                  className="underline hover:no-underline"
                  href={latexApi.docxArtifactUrl(pid, exportResult.export_id, n)}
                  data-testid={`latex-export-${n}`}
                >
                  {n}
                </a>
              ) : null,
            )}
          </div>
          <div className="mt-0.5 text-fg-muted">{exportResult.export_status}</div>
          {exportResult.degrades.length > 0 && (
            <ul className="mt-0.5 space-y-0.5 text-warning">
              {exportResult.degrades.map((d, i) => (
                <li key={i}>· {d}</li>
              ))}
            </ul>
          )}
          {/* 状态口径（防误读）：支持范围 / 静态编号 / 已知版式差异 / 非投稿承诺 / 非在线编辑 */}
          <div className="mt-1 border-t border-line pt-1 leading-5 text-fg-muted" data-testid="latex-export-scope">
            仅支持「中文信息学报（实验）」示例形态（jcip profile）；编号为静态文本，修改对象后需重新导出；
            首页与奇偶页眉等版式差异见转换报告；不保证符合期刊最终投稿要求；不是原生 Word 在线编辑。
          </div>
        </div>
      )}
      {exportHistory.length > 0 && (
        <div className="shrink-0 border-b border-line px-2 py-1 text-xs" data-testid="latex-export-history">
          <div className="mb-0.5 font-medium text-fg-muted">导出记录</div>
          <ul className="space-y-0.5">
            {exportHistory.map((e) => (
              <li key={e.export_id} className="flex items-center gap-2">
                <span className="text-fg-muted">{e.export_id}</span>
                <span
                  className={cn(
                    e.status === 'pass' && 'text-success',
                    e.status === 'degraded' && 'text-warning',
                    e.status === 'blocked' && 'text-danger',
                  )}
                >
                  {e.status}
                </span>
                {e.stale && <span className="text-warning">（对应旧内容，源码已修改）</span>}
                {e.artifacts['paper.docx'] && (
                  <a
                    className="underline hover:no-underline"
                    href={latexApi.docxArtifactUrl(pid, e.export_id, 'paper.docx')}
                  >
                    docx
                  </a>
                )}
                <a className="underline hover:no-underline" href={latexApi.docxArtifactUrl(pid, e.export_id, 'report.json')}>
                  报告
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
      {!exportAvailable && exportErr && (
        <div className="shrink-0 border-b border-line px-2 py-1 text-xs text-fg-muted" data-testid="latex-export-unavailable">
          {exportErr}
        </div>
      )}
      {diagList.length > 0 && (
        <div className="max-h-36 shrink-0 overflow-auto border-b border-line px-2 py-1" data-testid="latex-diagnostics">
          <div className="mb-1 text-xs font-medium text-danger">诊断（{diagList.length}）</div>
          <ul className="space-y-0.5">
            {diagList.map((d, i) => (
              <li key={i}>
                <button
                  className="w-full truncate text-left text-xs text-danger hover:underline"
                  onClick={() => jumpTo(d.file.replace(/^\.\//, ''), d.line)}
                  disabled={d.file.replace(/^\.\//, '') !== ctrl.getPath()}
                  title={d.file !== ctrl.getPath() ? '切换到对应文件后可跳转' : '点击跳到源码行'}
                >
                  {d.file}
                  {d.line != null ? `:${d.line}` : ''} — {d.message}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto" ref={previewBodyRef}>
        {pdfUrl ? (
          <Suspense fallback={<div className="p-3 text-xs text-fg-muted">加载 PDF…</div>}>
            <LatexPdf
              url={pdfUrl}
              width={Math.min(794, Math.max(120, paneW - 32))}
              scrollToPage={previewScroll?.page ?? null}
              onPageClick={(info) => void onPdfClickLocate(info)}
            />
          </Suspense>
        ) : (
          <div className="p-3 text-xs text-fg-muted" data-testid="latex-pdf-empty">
            {builds.some((b) => b.status === 'error') && !builds.some((b) => b.status === 'ok')
              ? '编译失败，无 PDF；可修复诊断后重新编译。'
              : '编译成功后将在此显示 PDF。'}
          </div>
        )}
      </div>
    </section>
  )

  return (
    <div className="latex-workspace flex h-full min-h-0 flex-col bg-app text-fg" data-testid="latex-workbench">
      {/* 顶栏 */}
      <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2" data-testid="latex-topbar">
        <a className="latex-brand" href="#/" aria-label="返回项目列表"><img src="/logo-mark.svg" alt="" />{BRAND_NAME}</a>
        <SquareFunction aria-hidden className="size-4 text-fg-muted" />
        <h1 className="min-w-0 truncate text-sm font-semibold text-fg-strong" title={title}>
          {title}
        </h1>
        <span className="shrink-0 rounded bg-panel px-1.5 py-0.5 text-xs font-normal text-fg-muted">
          LaTeX · {engine} · {main}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => openCollabCenter('members')}
            data-testid="latex-share"
            title="邀请导师与协作者（导师按行批注，学生回复；抽屉内按角色显示可执行操作）"
          >
            <Users aria-hidden className="size-4" />
            分享
          </Button>
          <Button
            variant={sideTab === 'comments' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setSideTab((v) => (v === 'comments' ? null : 'comments'))}
            aria-pressed={sideTab === 'comments'}
            data-testid="latex-comments-toggle"
            title="批注侧栏"
          >
            <MessageSquarePlus aria-hidden className="size-4" />
            批注
          </Button>
          <Button
            variant={sideTab === 'library' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setSideTab((v) => (v === 'library' ? null : 'library'))}
            aria-pressed={sideTab === 'library'}
            data-testid="latex-library-toggle"
            title="文献管理（导入 / DOI·arXiv 查询 / 引用插入 / 去重）"
          >
            <BookOpen aria-hidden className="size-4" />
            文献
          </Button>
          <Button
            variant={sideTab === 'proposals' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setSideTab((v) => (v === 'proposals' ? null : 'proposals'))}
            aria-pressed={sideTab === 'proposals'}
            data-testid="latex-proposals-toggle"
            title="论文助手（精读 / 写作 / 润色 / 去AI味 → 差异审阅 → 安全采纳）"
          >
            <Sparkles aria-hidden className="size-4" />
            论文助手
          </Button>
          <Button
            variant={sideTab === 'rebuttal' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setSideTab((v) => (v === 'rebuttal' ? null : 'rebuttal'))}
            aria-pressed={sideTab === 'rebuttal'}
            data-testid="latex-rebuttal-toggle"
            title="审稿回复信（意见拆条 / 进度跟踪 / AI 草稿 / 导出 Response Letter）"
          >
            <Reply aria-hidden className="size-4" />
            回复信
          </Button>
          {canEdit && (
            <Button
              variant={autoBuild ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => {
                setAutoBuild((v) => {
                  ctrl.setAutoBuild(!v)
                  return !v
                })
              }}
              aria-pressed={autoBuild}
              data-testid="latex-auto-toggle"
              title={
                autoBuild
                  ? '自动保存与自动编译均开启；点击仅关闭自动编译（自动保存保持开启）'
                  : '自动编译已关（自动保存仍会在停顿后进行）；点击重新开启'
              }
            >
              {autoBuild ? <Eye aria-hidden className="size-4" /> : <EyeOff aria-hidden className="size-4" />}
              自动编译
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => window.location.assign('#/')} data-testid="latex-back">
            所有项目
          </Button>
          {canEdit && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => ctrl.saveNow()}
              disabled={!dirty || saving || permLost}
              data-testid="latex-save"
              title={permLost ? '当前账号无写入权限' : undefined}
            >
              保存{dirty ? ' *' : ''}
            </Button>
          )}
          <Button size="sm" onClick={() => ctrl.buildNow()} disabled={building} data-testid="latex-build">
            {building ? <RefreshCw aria-hidden className="size-4 animate-spin" /> : <Play aria-hidden className="size-4" />}
            编译
          </Button>
          {building && canEdit && (
            <Button variant="ghost" size="sm" onClick={() => ctrl.cancelBuild()} data-testid="latex-build-cancel" title="终止编译进程，保留已有产物">
              <X aria-hidden className="size-4" />
              取消
            </Button>
          )}
          {canEdit && (
            <Button variant="ghost" size="sm" onClick={() => setSettingsOpen((v) => !v)} data-testid="latex-settings-toggle"
              title="主文件与编译引擎">
              <Settings2 aria-hidden className="size-4" />
              编译设置
            </Button>
          )}
        </div>
        {settingsOpen && (
          <div className="w-full border-t border-border bg-panel px-4 py-3 flex flex-wrap items-center gap-3 text-sm" data-testid="latex-settings">
            <label className="flex items-center gap-2">
              <span className="text-xs text-fg-muted">主文件</span>
              <select
                className="rounded-sm border border-border bg-app px-2 py-1 text-xs"
                value={main}
                onChange={(e) => void applyBuildSettings(e.target.value, engine)}
                data-testid="latex-settings-main"
              >
                {files.filter((f) => f.path.toLowerCase().endsWith('.tex')).map((f) => (
                  <option key={f.path} value={f.path}>{f.path}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2">
              <span className="text-xs text-fg-muted">引擎</span>
              <select
                className="rounded-sm border border-border bg-app px-2 py-1 text-xs"
                value={engine}
                onChange={(e) => void applyBuildSettings(main, e.target.value)}
                data-testid="latex-settings-engine"
              >
                <option value="pdflatex">pdfLaTeX</option>
                <option value="xelatex">XeLaTeX（中文推荐）</option>
              </select>
            </label>
            <span className="text-2xs text-fg-muted">
              保存后立即持久化；旧构建将标记为「旧配置」。中文工程建议 XeLaTeX。
            </span>
          </div>
        )}
      </header>

      {/* 本地草稿恢复选择条：检测到与服务器不同的本地草稿（不自动覆盖服务器） */}
      {draftProposal && !draftRestored && (
        <div
          role="alert"
          className="flex shrink-0 items-center gap-3 border-b border-line bg-panel px-3 py-1.5 text-xs"
          data-testid="latex-draft-proposal"
        >
          <span className="min-w-0 flex-1 text-fg-strong">
            {canEdit
              ? `检测到未保存的本地草稿（${draftProposal.path}，${new Date(draftProposal.savedAt).toLocaleString()}，约 ${draftProposal.content.length} 字符）。恢复后自动保存将暂停，由你确认后再保存。`
              : `检测到本地草稿（${draftProposal.path}），但当前为只读访问，无法提交。草稿已保留。`}
          </span>
          {canEdit && (
            <Button
              size="sm"
              data-testid="latex-draft-restore"
              onClick={() => {
                ctrl.restoreDraft(draftProposal.content)
                setDraftRestored(true)
                setDraftProposal(null)
                setReloadTick((t) => t + 1) // CM 重建为草稿内容
              }}
            >
              恢复本地草稿
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            data-testid="latex-draft-discard"
            onClick={() => {
              draftStore.markDiscarded(userScope, pid, draftProposal.path)
              draftStore.removeDraft(userScope, pid, draftProposal.path)
              setDraftProposal(null)
            }}
          >
            使用服务器版本（丢弃草稿）
          </Button>
        </div>
      )}
      {/* 草稿已恢复：自动保存暂停，显式保存即确认 */}
      {draftRestored && (
        <div
          role="status"
          className="flex shrink-0 items-center gap-3 border-b border-line bg-panel px-3 py-1.5 text-xs"
          data-testid="latex-draft-restored"
        >
          <span className="min-w-0 flex-1 text-fg-strong">
            本地草稿已恢复到编辑器（未保存）。自动保存已暂停——请核对内容后保存到服务器，或丢弃。
          </span>
          <Button size="sm" data-testid="latex-draft-save" onClick={() => ctrl.saveNow()} disabled={saving}>
            保存到服务器
          </Button>
          <Button
            variant="ghost"
            size="sm"
            data-testid="latex-draft-drop"
            onClick={() => {
              const path = ctrl.getPath()
              if (!path) return
              draftStore.markDiscarded(userScope, pid, path)
              draftStore.removeDraft(userScope, pid, path)
              setDraftRestored(false)
              void openFile(path) // 重新加载服务器版本
            }}
          >
            丢弃草稿
          </Button>
        </div>
      )}

      {/* 冲突恢复条：409 后自动链全部暂停，由用户显式选择 */}
      {conflict && (
        <div
          role="alert"
          className="flex shrink-0 items-center gap-3 border-b border-warning/40 bg-warning/10 px-3 py-1.5 text-xs"
          data-testid="latex-conflict"
        >
          <span className="min-w-0 flex-1 text-fg-strong">{error}</span>
          <Button
            size="sm"
            data-testid="latex-conflict-overwrite"
            onClick={() => {
              ctrl.resolveOverwrite()
            }}
          >
            以本地内容覆盖服务器
          </Button>
          <Button
            variant="ghost"
            size="sm"
            data-testid="latex-conflict-reload"
            onClick={async () => {
              const fresh = await ctrl.resolveReload()
              // 放弃本地 ⇒ 本地草稿一并丢弃（否则刷新后恢复条复活）
              if (fresh && active) {
                draftStore.markDiscarded(userScope, pid, active)
                draftStore.removeDraft(userScope, pid, active)
                await openFile(active) // CM 重建为服务器版本
              }
            }}
          >
            放弃本地修改
          </Button>
        </div>
      )}

      {notice && !conflict && (
        <div
          role="status"
          className="shrink-0 border-b border-line bg-panel px-3 py-1 text-xs text-fg-muted"
          data-testid="latex-notice"
        >
          {notice}
        </div>
      )}
      {error && !conflict && (
        <div role="alert" className="shrink-0 border-b border-line px-3 py-1 text-xs text-danger" data-testid="latex-error">
          {error}
        </div>
      )}
      {loadErr && (
        <div role="alert" className="shrink-0 border-b border-line px-3 py-1 text-xs text-danger">
          {loadErr}
        </div>
      )}
      {locateFlash && (
        <div role="status" className="shrink-0 border-b border-line px-3 py-1 text-xs text-warning" data-testid="latex-locate-flash">
          {locateFlash}
        </div>
      )}

      {/* 主体：文件面板（文件 | Issues 页签） | 源码 | 实时预览（可拖拽分栏） */}
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="工程文件"
          className="hidden w-56 shrink-0 flex-col border-r border-line bg-app md:flex"
          data-testid="latex-files"
        >
          <div className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1" role="tablist" aria-label="侧栏视图">
            <button
              type="button" role="tab" aria-selected={sideView === 'files'}
              className={cn('rounded-md px-1.5 py-0.5 text-xs transition-colors',
                sideView === 'files' ? 'bg-primary-soft font-medium text-primary' : 'text-fg-muted hover:bg-hover hover:text-fg')}
              onClick={() => setSideView('files')}
              data-testid="latex-tab-files"
            >
              文件
            </button>
            <button
              type="button" role="tab" aria-selected={sideView === 'issues'}
              className={cn('rounded-md px-1.5 py-0.5 text-xs transition-colors',
                sideView === 'issues' ? 'bg-primary-soft font-medium text-primary' : 'text-fg-muted hover:bg-hover hover:text-fg')}
              onClick={() => setSideView('issues')}
              data-testid="latex-tab-issues"
            >
              Issues
            </button>
            <button
              type="button" role="tab" aria-selected={sideView === 'preflight'}
              className={cn('rounded-md px-1.5 py-0.5 text-xs transition-colors',
                sideView === 'preflight' ? 'bg-primary-soft font-medium text-primary' : 'text-fg-muted hover:bg-hover hover:text-fg')}
              onClick={() => setSideView('preflight')}
              data-testid="latex-tab-preflight"
            >
              检查
            </button>
            <button
              type="button" role="tab" aria-selected={sideView === 'history'}
              className={cn('rounded-md px-1.5 py-0.5 text-xs transition-colors',
                sideView === 'history' ? 'bg-primary-soft font-medium text-primary' : 'text-fg-muted hover:bg-hover hover:text-fg')}
              onClick={() => setSideView('history')}
              data-testid="latex-tab-history"
            >
              <History aria-hidden className="mr-0.5 inline size-3" />
              历史
            </button>
            <button
              type="button" role="tab" aria-selected={sideView === 'git'}
              className={cn('rounded-md px-1.5 py-0.5 text-xs transition-colors',
                sideView === 'git' ? 'bg-primary-soft font-medium text-primary' : 'text-fg-muted hover:bg-hover hover:text-fg')}
              onClick={() => setSideView('git')}
              data-testid="latex-tab-git"
            >
              同步
            </button>
            <span className="ml-auto flex items-center gap-1 text-2xs text-fg-muted" title={dirty ? '有未保存修改' : '已保存'}>
              <span aria-hidden className={cn('size-2 rounded-full', dirty || saving ? 'bg-warn-dot animate-pulse' : 'bg-ok-dot')} />
              {files.length}
            </span>
          </div>
          {sideView === 'files' ? (
            <>
              <div className="flex shrink-0 items-center gap-0.5 border-b border-line px-2 py-1">
                <span className="mr-auto text-2xs text-fg-muted">工程文件</span>
                <a
                  className="grid size-6 place-items-center rounded-md text-fg-muted transition-colors hover:bg-hover hover:text-fg"
                  href={latexApi.exportZipUrl(pid)} download
                  title="下载整包 ZIP" data-testid="latex-files-download"
                >
                  <Download aria-hidden className="size-3.5" />
                </a>
                <button
                  type="button"
                  className="grid size-6 place-items-center rounded-md text-fg-muted transition-colors hover:bg-hover hover:text-fg"
                  title="上传文件（到当前目录；默认不覆盖同名）" data-testid="latex-files-upload"
                  onClick={() => uploadRef.current?.click()}
                >
                  <Upload aria-hidden className="size-3.5" />
                </button>
                <button
                  type="button"
                  className="grid size-6 place-items-center rounded-md text-fg-muted transition-colors hover:bg-hover hover:text-fg"
                  title="上传 ZIP 合并入工程（不覆盖已有文件）" data-testid="latex-files-upload-zip"
                  onClick={() => zipRef.current?.click()}
                >
                  <FolderInput aria-hidden className="size-3.5" />
                </button>
                <button
                  type="button"
                  className="grid size-6 place-items-center rounded-md text-fg-muted transition-colors hover:bg-hover hover:text-fg"
                  title="新建文件" data-testid="latex-files-new"
                  onClick={() => void onNewFile()}
                >
                  <Plus aria-hidden className="size-4" />
                </button>
              </div>
              {panelNote && (
                <div className="shrink-0 border-b border-line px-2 py-1 text-2xs leading-4 text-fg-muted" data-testid="latex-files-note">
                  {panelNote}
                </div>
              )}
              <div className="min-h-0 flex-1 overflow-auto p-2">
                <LatexFileTree
                  files={files}
                  active={active}
                  dirty={dirty}
                  onOpen={switchFile}
                  onPreview={(path) => setPreview({ path, kind: /\.pdf$/i.test(path) ? 'pdf' : 'image' })}
                  onRenameFile={(path) => void onRenameFile(path)}
                  onDeleteFile={(path) => void onDeleteFile(path)}
                />
                {files.length === 0 && !loadErr && <div className="px-1 text-xs text-fg-muted">加载中…</div>}
              </div>
              <input
                ref={uploadRef} type="file" multiple className="hidden"
                onChange={(e) => { const fs = e.target.files; if (fs?.length) void onUploadFiles(fs); e.target.value = '' }}
              />
              <input
                ref={zipRef} type="file" accept=".zip" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void onUploadZip(f); e.target.value = '' }}
              />
            </>
          ) : sideView === 'issues' ? (
            <LatexIssues
              pid={pid}
              activeFile={active}
              activeFileEmpty={active !== null && ctrl.getPath() === active && ctrl.getContent().trim() === ''}
              diagList={diagList}
              aiReview={canEdit ? aiReviewCurrentFile : undefined}
              proposeFix={canEdit ? (d) => void proposeFixFromDiag(d) : undefined}
              onJump={(file, line) => {
                if (file !== active) {
                  void openFile(file).then(() => {
                    window.setTimeout(() => jumpTo(file, line), 200)
                  })
                } else {
                  jumpTo(file, line)
                }
              }}
            />
          ) : sideView === 'preflight' ? (
            <LatexPreflight pid={pid} canEdit={canEdit} />
          ) : sideView === 'history' ? (
            <LatexHistory pid={pid} canEdit={canEdit} onRestore={handleHistoryRestore} />
          ) : (
            <LatexGitPanel
              pid={pid}
              canEdit={canEdit}
              onPulled={() => {
                // 拉取更新了工作区：文件清单/编辑器/索引/构建 stale 全刷新（同恢复路径）
                void (async () => {
                  refreshIndex()
                  try {
                    const reply = await latexApi.files(pid)
                    setFiles(reply.files)
                    const cur = ctrl.getPath()
                    const target = (cur ? reply.files.find((f) => f.path === cur && f.editable) : null)
                      ?? reply.files.find((f) => f.path === main && f.editable)
                      ?? reply.files.find((f) => f.editable)
                    if (target) await openFile(target.path)
                    void refreshBuilds()
                  } catch { /* 文件清单刷新失败不阻断（下次打开重取） */ }
                })()
              }}
            />
          )}
        </nav>
        <div className="min-h-0 min-w-0 flex-1">
          <SplitPane storageKey="latex-split" min={0.25} left={editorPane} right={previewPane} />
        </div>
        {sideTab && (
          <aside className="hidden w-96 shrink-0 border-l border-line md:flex md:flex-col" data-testid="latex-side-panel">
            {sideTab === 'comments' && (
              <CommentsSidebar
                pid={pid}
                activePath={active}
                savedSha={savedSha}
                dirty={dirty}
                currentLine={cursorLine}
                reloadSignal={reloadTick}
                onJump={(file, line) => {
                  if (file !== active) {
                    void openFile(file).then(() => {
                      window.setTimeout(() => jumpTo(file, line), 200)
                    })
                  } else {
                    jumpTo(file, line)
                  }
                }}
              />
            )}
            {sideTab === 'library' && (
              <LibraryPanel
                pid={pid}
                canEdit={canEdit}
                activePath={active}
                onInsertCitations={insertCitations}
                onLibraryChanged={onLibraryChanged}
              />
            )}
            {sideTab === 'proposals' && (
              <ProposalPanel
                pid={pid}
                canEdit={canEdit}
                activePath={active}
                dirty={dirty}
                saving={saving}
                getSelection={getSelection}
                applyProposal={doApplyProposal}
                revertProposal={doRevertProposal}
                locateProposal={locateProposal}
                reloadSignal={proposalTick}
                verifyFix={canEdit ? verifyProposalFix : undefined}
              />
            )}
            {sideTab === 'rebuttal' && (
              <RebuttalPanel
                pid={pid}
                canEdit={canEdit}
                activeFile={active}
                cursorLine={cursorLine}
                onJump={(file, line) => {
                  if (file !== active) {
                    void openFile(file).then(() => {
                      window.setTimeout(() => jumpTo(file, line), 200)
                    })
                  } else {
                    jumpTo(file, line)
                  }
                }}
              />
            )}
          </aside>
        )}
      </div>

      {/* 源文件只读预览（图片/PDF） */}
      {preview && <SourcePreviewOverlay pid={pid} preview={preview} onClose={() => setPreview(null)} />}

      {/* 跨文件搜索（Ctrl+Shift-F / 小工具条「搜索」） */}
      <CrossFileSearch index={contentIndex} openSignal={searchSignal} onPick={jumpToSearchHit} />

      {/* 状态栏 */}
      <footer
        className="flex h-6 shrink-0 items-center gap-3 border-t border-line px-3 text-xs text-fg-muted"
        data-testid="latex-statusbar"
      >
        <span className="min-w-0 truncate">
          {active ?? '—'}
          {dirty && <span className="text-warning"> · 未保存</span>}
          {building && ' · 编译中'}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-5 px-1.5 text-xs"
          data-testid="latex-goto-line"
          onClick={() => {
            const raw = window.prompt('跳转到行：')
            if (raw == null) return
            const n = Number.parseInt(raw, 10)
            if (Number.isFinite(n) && active) jumpTo(active, n)
          }}
        >
          转到行
        </Button>
        <span className="ml-auto shrink-0">
          {latest ? (
            <>
              最近构建 {shortId(latest.build_id)} · {latest.status === 'ok' ? '成功' : '失败'}
              {latest.status === 'ok' ? ` · ${latest.duration_ms}ms` : ''}
              {staleNow && ' · 源码已变化，预览可能过期'}
            </>
          ) : (
            '尚未编译'
          )}
        </span>
      </footer>
    </div>
  )
}

/** 源文件只读预览弹层（图片/PDF；后端 raw 端点带 CSP sandbox，svg/pdf 内脚本不执行）。 */
function SourcePreviewOverlay({ pid, preview, onClose }: {
  pid: string
  preview: { path: string; kind: 'image' | 'pdf' }
  onClose(): void
}) {
  const url = `/api/projects/${encodeURIComponent(pid)}/latex/raw/${preview.path.split('/').map(encodeURIComponent).join('/')}`
  return (
    <div
      role="dialog"
      aria-label={`预览 ${preview.path}`}
      data-testid="latex-source-preview"
      className="fixed inset-0 z-popover grid place-items-center bg-black/55 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl bg-panel shadow-md">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3 text-xs">
          <span className="min-w-0 truncate font-medium text-fg-strong" title={preview.path}>{preview.path}</span>
          <a
            className="ml-auto shrink-0 text-fg-muted underline-offset-2 hover:text-fg hover:underline"
            href={`${url}?dl=1`}
            data-testid="latex-preview-download"
          >
            下载
          </a>
          <button
            type="button"
            className="shrink-0 rounded p-1 text-fg-muted transition-colors hover:bg-hover hover:text-fg"
            onClick={onClose}
            aria-label="关闭预览"
            data-testid="latex-preview-close"
          >
            <X aria-hidden className="size-4" />
          </button>
        </div>
        {preview.kind === 'image' ? (
          <div className="grid min-h-0 flex-1 place-items-center overflow-auto bg-paper-canvas p-3">
            <img src={url} alt={preview.path} className="max-h-[76vh] max-w-full bg-white object-contain" data-testid="latex-preview-image" />
          </div>
        ) : (
          <iframe src={url} title={preview.path} className="h-[76vh] w-full bg-white" data-testid="latex-preview-pdf" />
        )}
      </div>
    </div>
  )
}

/** 符号面板分组（v0.4.2）：点击插入到光标处 */
/** CodeMirror 挂载：state 变化（换文件/冲突重载）时整体重建视图 */
function CodeMirrorHost({
  state,
  viewRef,
}: {
  state: EditorState
  viewRef: RefObject<EditorView | null>
}) {
  const host = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!host.current) return
    const view = new EditorView({ state, parent: host.current })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [state, viewRef])
  return <div ref={host} className="h-full" />
}

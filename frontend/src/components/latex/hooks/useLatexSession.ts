import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { glossaryApi, type GlossaryEntry } from '@/lib/api/glossary'
import { latexApi, type LatexBuildInfo, type LatexBuildOutcome, type LatexFileInfo } from '@/lib/api/latex'
import { libraryApi } from '@/lib/api/library'
import { errorKind } from '@/lib/api/net'
import { useStudio } from '@/store'
import type { CiteCandidate } from '../citeCompletions'
import { ProjectContentIndex } from '../editorSearch'
import { createDraftStore, type DraftStore } from '../latexDraft'
import { SaveBuildController, type ControllerSnapshot } from '../saveBuild'

export function errText(e: unknown): string {
  const anyErr = e as { message?: string; detail?: { message?: string } }
  return anyErr?.detail?.message || anyErr?.message || String(e)
}

export function shortId(buildId: string | undefined | null): string {
  return buildId ? buildId.slice(-6) : '—'
}

export function useLatexSession({
  pid,
  main,
  engine,
  canEdit,
  userScope,
  onFileLoaded,
}: {
  pid: string
  main: string
  engine: string
  canEdit: boolean
  userScope: string
  onFileLoaded?: (rel: string, content: string) => void
}) {
  const initialBuild = useRef<string | null>(null)
  const onFileLoadedRef = useRef(onFileLoaded)
  onFileLoadedRef.current = onFileLoaded

  const [files, setFiles] = useState<LatexFileInfo[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [openTabs, setOpenTabs] = useState<string[]>(() => {
    try {
      const raw = window.sessionStorage.getItem(`paper-latex-tabs:${pid}`)
      const parsed = raw ? JSON.parse(raw) : null
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  })
  const [loadErr, setLoadErr] = useState('')
  const [autoBuild, setAutoBuild] = useState(true)
  const [snap, setSnap] = useState<ControllerSnapshot | null>(null)
  const [outcome, setOutcome] = useState<LatexBuildOutcome | null>(null)
  const [builds, setBuilds] = useState<LatexBuildInfo[]>([])
  const [previewBuildId, setPreviewBuildId] = useState<string | null>(null)
  const [previewIsOld, setPreviewIsOld] = useState(false)
  const [reloadTick, setReloadTick] = useState(0)
  const [draftProposal, setDraftProposal] = useState<{ path: string; content: string; savedAt: number } | null>(null)
  const [draftRestored, setDraftRestored] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsBusy, setSettingsBusy] = useState(false)
  const [configStamp, setConfigStamp] = useState(0)
  const [libraryStamp, setLibraryStamp] = useState(0)
  const [glossaryStamp, setGlossaryStamp] = useState(0)
  const draftWriteTimer = useRef<number | undefined>(undefined)

  const draftStore = useMemo((): DraftStore => {
    let storage: Storage | null = null
    try {
      storage = window.localStorage
    } catch {
      storage = null
    }
    return createDraftStore(storage)
  }, [])
  const storageOk = useMemo(() => draftStore.available(), [draftStore])

  const contentIndexRef = useRef<{ pid: string; index: ProjectContentIndex } | null>(null)
  if (!contentIndexRef.current || contentIndexRef.current.pid !== pid) {
    contentIndexRef.current = {
      pid,
      index: new ProjectContentIndex({
        list: () => latexApi.files(pid),
        read: (p: string) => latexApi.read(pid, p),
      }),
    }
  }
  const contentIndex = contentIndexRef.current.index

  const refreshIndex = useCallback(() => {
    contentIndex.invalidate()
    void contentIndex.ensure().catch(() => {
      /* 索引失败静默：搜索/补全降级为空，不影响编辑 */
    })
  }, [contentIndex])

  const citeDataRef = useRef<{ cites: CiteCandidate[] }>({ cites: [] })
  const glossaryRef = useRef<GlossaryEntry[]>([])
  const onLibraryChanged = useCallback(() => {
    refreshIndex()
    setLibraryStamp((t) => t + 1)
  }, [refreshIndex])
  const onGlossaryChanged = useCallback(() => {
    setGlossaryStamp((t) => t + 1)
  }, [])

  useEffect(() => {
    let cancelled = false
    glossaryApi
      .list(pid)
      .then((r) => {
        if (!cancelled) glossaryRef.current = r.entries
      })
      .catch(() => {
        /* 术语表不可用时静默降级 */
      })
    return () => {
      cancelled = true
    }
  }, [pid, glossaryStamp])

  useEffect(() => {
    let cancelled = false
    libraryApi
      .get(pid)
      .then((r) => {
        if (!cancelled) citeDataRef.current = { cites: r.entries }
      })
      .catch(() => {
        /* 文献库不可用时补全为空 */
      })
    return () => {
      cancelled = true
    }
  }, [pid, libraryStamp])

  useEffect(() => {
    refreshIndex()
  }, [refreshIndex, pid])

  const refreshBuilds = useCallback(async () => {
    try {
      const reply = await latexApi.builds(pid)
      setBuilds(reply.builds)
      return reply
    } catch {
      return null
    }
  }, [pid])

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

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (ctrl.isDirty()) e.preventDefault()
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [ctrl])

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
  useEffect(() => () => ctrl.dispose(), [ctrl])

  const checkDraftAfterOpen = useCallback(
    (rel: string, serverContent: string, cancelled: () => boolean) => {
      const draft = draftStore.loadDraft(userScope, pid, rel)
      if (cancelled()) return
      if (!draft) {
        setDraftProposal(null)
        return
      }
      if (draft.content === serverContent) {
        draftStore.removeDraft(userScope, pid, rel)
        setDraftProposal(null)
      } else {
        setDraftProposal({ path: rel, content: draft.content, savedAt: draft.savedAt })
      }
    },
    [draftStore, pid, userScope],
  )

  const trackTab = useCallback(
    (rel: string) => {
      setOpenTabs((prev) => {
        const next = prev.includes(rel) ? prev : [...prev, rel]
        try {
          window.sessionStorage.setItem(`paper-latex-tabs:${pid}`, JSON.stringify(next))
        } catch {
          /* ignore */
        }
        return next
      })
    },
    [pid],
  )

  const openFile = useCallback(
    async (rel: string) => {
      try {
        const read = await latexApi.read(pid, rel)
        ctrl.open(rel, read.content, read.sha)
        onFileLoadedRef.current?.(rel, read.content)
        setActive(rel)
        trackTab(rel)
        setReloadTick((t) => t + 1)
        setDraftRestored(false)
        checkDraftAfterOpen(rel, read.content, () => false)
      } catch (e) {
        setLoadErr(errText(e))
      }
    },
    [pid, ctrl, checkDraftAfterOpen, trackTab],
  )

  const switchFile = useCallback(
    (rel: string) => {
      if (rel === active) return
      if (ctrl.isDirty() && !window.confirm('当前文件有未保存修改，放弃并切换？')) return
      void openFile(rel)
    },
    [active, ctrl, openFile],
  )

  const closeTab = useCallback(
    (rel: string) => {
      if (rel === active && ctrl.isDirty() && !window.confirm('当前文件有未保存修改，放弃并关闭？')) return
      setOpenTabs((prev) => {
        const idx = prev.indexOf(rel)
        const next = prev.filter((x) => x !== rel)
        try {
          window.sessionStorage.setItem(`paper-latex-tabs:${pid}`, JSON.stringify(next))
        } catch {
          /* ignore */
        }
        if (rel === active && next.length > 0) {
          const fallback = next[Math.min(idx, next.length - 1)]
          void openFile(fallback)
        }
        return next
      })
    },
    [active, ctrl, openFile, pid],
  )

  const reloadFiles = useCallback(async () => {
    try {
      setFiles((await latexApi.files(pid)).files)
    } catch {
      /* 刷新失败保旧列表 */
    }
  }, [pid])

  const handleHistoryRestore = useCallback(
    async (sha: string): Promise<string | null> => {
      if (ctrl.isDirty() && !window.confirm('当前有未保存的修改，恢复将丢弃这些修改。继续？')) return null
      const r = await latexApi.restoreVersion(pid, sha)
      refreshIndex()
      const reply = await latexApi.files(pid)
      setFiles(reply.files)
      const cur = ctrl.getPath()
      const target =
        (cur ? reply.files.find((f) => f.path === cur && f.editable) : null) ??
        reply.files.find((f) => f.path === main && f.editable) ??
        reply.files.find((f) => f.editable)
      if (target) await openFile(target.path)
      else setActive(null)
      void refreshBuilds()
      const deletedNote = r.deleted.length ? `，删除 ${r.deleted.length} 个多余文件` : ''
      return `已恢复 ${r.written} 个文件${deletedNote}${r.changed ? '' : '（与当前内容一致，无变化）'}`
    },
    [pid, ctrl, main, refreshIndex, refreshBuilds, openFile],
  )

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const reply = await latexApi.files(pid)
        if (cancelled) return
        setFiles(reply.files)
        const first = reply.files.find((f) => f.path === main && f.editable) ?? reply.files.find((f) => f.editable)
        if (first) {
          const read = await latexApi.read(pid, first.path)
          if (cancelled) return
          ctrl.open(first.path, read.content, read.sha)
          onFileLoadedRef.current?.(first.path, read.content)
          setActive(first.path)
          trackTab(first.path)
          setReloadTick((t) => t + 1)
          checkDraftAfterOpen(first.path, read.content, () => cancelled)
        }
        const buildsReply = await refreshBuilds()
        if (!cancelled && buildsReply) {
          if (buildsReply.latest_ok_build_id) {
            setPreviewBuildId(buildsReply.latest_ok_build_id)
            setPreviewIsOld(!!buildsReply.builds.length && buildsReply.builds[0].status !== 'ok')
          }
          if (
            first &&
            !buildsReply.builds.length &&
            initialBuild.current !== pid &&
            canEdit &&
            !draftStore.loadDraft(userScope, pid, first.path)
          ) {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid, main, refreshBuilds, ctrl, checkDraftAfterOpen])

  const applyBuildSettings = useCallback(
    async (nextMain: string, nextEngine: string): Promise<void> => {
      if (!canEdit || settingsBusy) return
      setSettingsBusy(true)
      try {
        await latexApi.updateBuildSettings(pid, nextMain, nextEngine)
        setConfigStamp(Date.now())
        setSettingsOpen(false)
        useStudio.setState((st) => ({
          project:
            st.project && st.project.id === pid
              ? { ...st.project, settings: { ...st.project.settings, latex: { main: nextMain, engine: nextEngine } } }
              : st.project,
        }))
        setPreviewIsOld(true)
      } finally {
        setSettingsBusy(false)
      }
    },
    [canEdit, settingsBusy, pid],
  )

  const onPulled = useCallback(() => {
    void (async () => {
      refreshIndex()
      try {
        const reply = await latexApi.files(pid)
        setFiles(reply.files)
        const cur = ctrl.getPath()
        const target =
          (cur ? reply.files.find((f) => f.path === cur && f.editable) : null) ??
          reply.files.find((f) => f.path === main && f.editable) ??
          reply.files.find((f) => f.editable)
        if (target) await openFile(target.path)
        void refreshBuilds()
      } catch {
        /* 文件清单刷新失败不阻断（下次打开重取） */
      }
    })()
  }, [pid, ctrl, main, openFile, refreshIndex, refreshBuilds])

  const toggleAutoBuild = useCallback(() => {
    setAutoBuild((v) => {
      ctrl.setAutoBuild(!v)
      return !v
    })
  }, [ctrl])

  const restoreDraftProposal = useCallback(() => {
    if (!draftProposal) return
    ctrl.restoreDraft(draftProposal.content)
    setDraftRestored(true)
    setDraftProposal(null)
    setReloadTick((t) => t + 1)
  }, [ctrl, draftProposal])

  const discardDraftProposal = useCallback(() => {
    if (!draftProposal) return
    draftStore.markDiscarded(userScope, pid, draftProposal.path)
    draftStore.removeDraft(userScope, pid, draftProposal.path)
    setDraftProposal(null)
  }, [draftStore, draftProposal, pid, userScope])

  const dropRestoredDraft = useCallback(() => {
    const path = ctrl.getPath()
    if (!path) return
    draftStore.markDiscarded(userScope, pid, path)
    draftStore.removeDraft(userScope, pid, path)
    setDraftRestored(false)
    void openFile(path)
  }, [ctrl, draftStore, openFile, pid, userScope])

  const reloadConflictFile = useCallback(async () => {
    const fresh = await ctrl.resolveReload()
    if (fresh && active) {
      draftStore.markDiscarded(userScope, pid, active)
      draftStore.removeDraft(userScope, pid, active)
      await openFile(active)
    }
  }, [active, ctrl, draftStore, openFile, pid, userScope])

  const applyMergedConflict = useCallback(
    (mergedContent: string, newSha: string) => {
      if (!active) return
      ctrl.open(active, mergedContent, newSha)
      draftStore.removeDraft(userScope, pid, active)
      setDraftRestored(false)
      setReloadTick((t) => t + 1)
      refreshIndex()
    },
    [active, ctrl, draftStore, pid, refreshIndex, userScope],
  )

  // 当显式保存成功（draftPaused 解除），草稿恢复状态自然失效
  const effectiveDraftRestored = Boolean(draftRestored && !(snap && !snap.draftPaused && !snap.dirty && !snap.saving))

  return {
    ctrl,
    files,
    active,
    openTabs,
    loadErr,
    setLoadErr,
    autoBuild,
    toggleAutoBuild,
    snap,
    outcome,
    setOutcome,
    builds,
    previewBuildId,
    setPreviewBuildId,
    previewIsOld,
    setPreviewIsOld,
    reloadTick,
    draftProposal,
    draftRestored: effectiveDraftRestored,
    storageOk,
    settingsOpen,
    setSettingsOpen,
    configStamp,
    contentIndex,
    citeDataRef,
    glossaryRef,
    refreshIndex,
    refreshBuilds,
    onLibraryChanged,
    onGlossaryChanged,
    openFile,
    switchFile,
    closeTab,
    handleHistoryRestore,
    reloadFiles,
    applyBuildSettings,
    onPulled,
    restoreDraftProposal,
    discardDraftProposal,
    dropRestoredDraft,
    reloadConflictFile,
    applyMergedConflict,
  }
}

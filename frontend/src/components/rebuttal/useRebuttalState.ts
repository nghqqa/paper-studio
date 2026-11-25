import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  rebuttalApi,
  type RebuttalExportFormat,
  type RebuttalItem,
  type RebuttalMode,
  type RebuttalRoundDetail,
  type RebuttalRoundSummary,
  type RebuttalState,
  type RebuttalStatus,
} from '@/lib/api/rebuttal'
import { downloadFile } from '@/lib/download'
import { useStudio } from '@/store'
import { type ItemForm, formOf, msgOf } from './rebuttalHelpers'

export function useRebuttalState({
  pid,
  canEdit,
  activeFile,
  cursorLine,
}: {
  pid: string
  canEdit: boolean
  activeFile: string | null
  cursorLine: number | null
}) {
  const aiDisabledByOrg = useStudio((s) => s.aiDisabledByOrg)
  const aiEnabled = !aiDisabledByOrg
  const [state, setState] = useState<RebuttalState | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [banner, setBanner] = useState('')
  const [notice, setNotice] = useState<string | null>(null)

  const [importText, setImportText] = useState('')
  const [importMode, setImportMode] = useState<RebuttalMode>('replace')
  const [importing, setImporting] = useState(false)

  const [reviewer, setReviewer] = useState('')
  const [status, setStatus] = useState<RebuttalStatus | ''>('')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [form, setForm] = useState<ItemForm | null>(null)
  const [dirty, setDirty] = useState(false)

  const [saving, setSaving] = useState(false)
  const [aiBusy, setAiBusy] = useState(false)
  const [exportFmt, setExportFmt] = useState<RebuttalExportFormat | null>(null)
  const [rounds, setRounds] = useState<RebuttalRoundSummary[]>([])
  const [viewRound, setViewRound] = useState<'current' | number>('current')
  const [roundDetail, setRoundDetail] = useState<RebuttalRoundDetail | null>(null)

  const load = useCallback(async () => {
    try {
      const st = await rebuttalApi.load(pid)
      setState(st)
      setLoadFailed(false)
    } catch (e) {
      setBanner(msgOf(e))
      setLoadFailed(true)
    }
    try {
      setRounds((await rebuttalApi.rounds(pid)).rounds)
    } catch {
      setRounds([])
    }
  }, [pid])

  useEffect(() => {
    void load()
  }, [load])

  const openRound = async (n: 'current' | number) => {
    setViewRound(n)
    if (n === 'current') {
      setRoundDetail(null)
      return
    }
    try {
      setRoundDetail(await rebuttalApi.round(pid, n))
    } catch (e) {
      setBanner(msgOf(e))
    }
  }

  const items = useMemo(() => state?.items ?? [], [state])
  const reviewers = useMemo(() => [...new Set(items.map((it) => it.reviewer))], [items])
  const addressed = items.filter((it) => it.status === 'addressed').length
  const visible = useMemo(
    () => items.filter((it) => (!reviewer || it.reviewer === reviewer) && (!status || it.status === status)),
    [items, reviewer, status],
  )
  const selected = items.find((it) => it.id === activeId) ?? null

  useEffect(() => {
    if (selected) {
      setForm(formOf(selected))
      setDirty(false)
      setNotice(null)
    } else {
      setForm(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])

  const patchForm = (patch: Partial<ItemForm>) => {
    setForm((f) => (f ? { ...f, ...patch } : f))
    setDirty(true)
  }

  const doImport = async (fn: () => Promise<{ items: RebuttalItem[]; warnings: string[]; round: number }>) => {
    setImporting(true)
    setBanner('')
    try {
      const r = await fn()
      setState((s) => ({ ...(s ?? { updated_at: null, round: 0, items: [], warnings: [] }), ...r }))
      setReviewer('')
      setStatus('')
      setActiveId(null)
      try {
        setRounds((await rebuttalApi.rounds(pid)).rounds)
      } catch {
        /* 静默 */
      }
      setViewRound('current')
      setRoundDetail(null)
      if (r.warnings.length) setNotice(r.warnings.join('；'))
    } catch (e) {
      setBanner(msgOf(e))
    } finally {
      setImporting(false)
    }
  }

  const saveItem = async () => {
    if (!selected || !form || !canEdit) return
    setSaving(true)
    setBanner('')
    try {
      const it = await rebuttalApi.updateItem(pid, selected.id, {
        status: form.status,
        response: form.response,
        edits_summary: form.editsSummary,
        location: form.location,
      })
      setState((s) => (s ? { ...s, items: s.items.map((x) => (x.id === it.id ? it : x)) } : s))
      setDirty(false)
    } catch (e) {
      setBanner(msgOf(e))
    } finally {
      setSaving(false)
    }
  }

  const switchStatus = async (next: RebuttalStatus) => {
    if (!selected || !canEdit) return
    setForm((f) => (f ? { ...f, status: next } : f))
    setBanner('')
    try {
      const it = await rebuttalApi.updateItem(pid, selected.id, { status: next })
      setState((s) => (s ? { ...s, items: s.items.map((x) => (x.id === it.id ? it : x)) } : s))
    } catch (e) {
      setBanner(msgOf(e))
    }
  }

  const runDraft = async () => {
    if (!selected || !canEdit || !aiEnabled || aiBusy) return
    setAiBusy(true)
    setBanner('')
    try {
      const r = await rebuttalApi.draft(pid, selected.id)
      setState((s) => (s ? { ...s, items: s.items.map((x) => (x.id === r.item.id ? r.item : x)) } : s))
      setNotice(r.warnings.length ? r.warnings.join('；') : null)
    } catch (e) {
      setBanner(msgOf(e))
    } finally {
      setAiBusy(false)
    }
  }

  const adoptDraft = () => {
    const draft = selected?.ai_draft
    if (!draft) return
    patchForm({ response: draft.response_draft, editsSummary: draft.edits_summary_draft || form?.editsSummary || '' })
  }

  const linkCursor = () => {
    if (!activeFile || cursorLine == null) return
    patchForm({ location: { ...(form?.location ?? {}), file: activeFile, line: cursorLine } })
  }

  const doExport = async (fmt: RebuttalExportFormat) => {
    if (exportFmt) return
    setExportFmt(fmt)
    setBanner('')
    try {
      await downloadFile(rebuttalApi.exportUrl(pid, fmt), `response-letter.${fmt}`)
    } catch (e) {
      setBanner(msgOf(e))
    } finally {
      setExportFmt(null)
    }
  }

  return {
    aiEnabled,
    state,
    loadFailed,
    banner,
    notice,
    importText,
    setImportText,
    importMode,
    setImportMode,
    importing,
    reviewer,
    setReviewer,
    status,
    setStatus,
    setActiveId,
    form,
    dirty,
    saving,
    aiBusy,
    exportFmt,
    rounds,
    viewRound,
    roundDetail,
    items,
    reviewers,
    addressed,
    visible,
    selected,
    load,
    openRound,
    patchForm,
    importPasted: () => {
      if (importText.trim() && !importing) void doImport(() => rebuttalApi.parse(pid, importText, importMode))
    },
    importFile: (f: File | undefined) => {
      if (f && !importing) void doImport(() => rebuttalApi.parseFile(pid, f, importMode))
    },
    saveItem,
    switchStatus,
    runDraft,
    adoptDraft,
    linkCursor,
    doExport,
  }
}

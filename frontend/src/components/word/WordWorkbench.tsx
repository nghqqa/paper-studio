import { useCallback, useEffect, useRef, useState } from 'react'
import { BookOpen, FileDown, History, Loader2, RefreshCw, Save, Sparkles, Upload, Users, MessageSquareQuote, MessageSquareText, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ApiError } from '@/lib/api/net'
import { wordApi, type WordCitationStyle, type WordRenumberResult, type WordState } from '@/lib/api/word'
import { downloadFile } from '@/lib/download'
import { selectCanManage, useStudio } from '@/store'
import { loadOnlyOffice, type OnlyOfficeEditor } from './onlyoffice'
import { saveWordAndWait } from './saveWord'
import { WordSidePanels } from './WordSidePanels'

const errorText = (e: unknown) => e instanceof Error ? e.message : String(e)
const formatTime = (value: string | undefined) => value ? new Date(value).toLocaleString('zh-CN') : '—'
let editorId = 0

export function WordWorkbench({ pid }: { pid: string }) {
  return <WordSession key={pid} pid={pid} />
}

function WordSession({ pid }: { pid: string }) {
  const title = useStudio((s) => s.project?.title ?? pid)
  const openCollabCenter = useStudio((s) => s.openCollabCenter)
  const canManage = useStudio(selectCanManage)
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<OnlyOfficeEditor | null>(null)
  const editSequence = useRef(0)
  const dirty = useRef(false)
  const editorPending = useRef(false)
  const operation = useRef<AbortController | null>(null)
  const uploadInput = useRef<HTMLInputElement>(null)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error' | 'unconfigured'>('loading')
  const [error, setError] = useState('')
  const [actionError, setActionError] = useState('')
  const [notice, setNotice] = useState('')
  const [state, setState] = useState<WordState | null>(null)
  const [canSave, setCanSave] = useState(false)
  const [canDownload, setCanDownload] = useState(false)
  const [hasChanges, setHasChanges] = useState(false)
  const [busy, setBusy] = useState(false)
  const [versionsOpen, setVersionsOpen] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [renumberBusy, setRenumberBusy] = useState(false)
  const [sidePanel, setSidePanel] = useState<'library' | 'proposals' | 'preflight' | 'rebuttal' | 'comments' | null>(null)
  const [docKey, setDocKey] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let alive = true
    const mount = host.current
    let readyTimer: number | undefined
    let instance: OnlyOfficeEditor | null = null
    setPhase('loading'); setError(''); setActionError(''); setState(null)
    setCanSave(false); setCanDownload(false); setHasChanges(dirty.current); setBusy(false)
    // 重试加载同一稿件时仍保留待确认标记，不能把重连当成一次成功保存。
    editorPending.current = false
    const fail = (e: unknown) => {
      if (!alive) return
      window.clearTimeout(readyTimer)
      setError(errorText(e))
      setPhase(e instanceof ApiError && e.status === 503 ? 'unconfigured' : 'error')
    }
    void (async () => {
      try {
        const [reply, initial] = await Promise.all([wordApi.editorConfig(pid), wordApi.state(pid)])
        setDocKey((reply.config.document as { key?: string } | undefined)?.key ?? null)
        if (!alive) return
        setState(initial)
        const permissions = reply.config.document?.permissions
        setCanSave(reply.config.editorConfig?.mode !== 'view' && (permissions?.edit !== false || permissions?.review === true))
        setCanDownload(permissions?.download !== false)
        const api = await loadOnlyOffice(reply.document_server_url)
        if (!alive || !mount) return
        const placeholder = document.createElement('div')
        placeholder.id = `word-editor-${++editorId}`
        mount.replaceChildren(placeholder)
        readyTimer = window.setTimeout(() => fail(new Error('Word 文档打开超时，请检查文档服务后重试')), 90_000)
        instance = new api.DocEditor(placeholder.id, {
          ...reply.config,
          events: {
            onDocumentReady: () => { if (alive) { window.clearTimeout(readyTimer); setPhase('ready') } },
            onDocumentStateChange: (event: { data?: boolean }) => {
              if (!alive) return
              editorPending.current = Boolean(event.data)
              if (!event.data) return
              dirty.current = true; editSequence.current += 1; setHasChanges(true); setNotice('')
            },
            onError: (event: { data?: { errorCode?: number; errorDescription?: string } }) => {
              const code = event?.data?.errorCode
              const desc = event?.data?.errorDescription
              console.error('DocsAPI onError', code, desc)
              fail(new Error(`Word 编辑器报告错误${typeof code === 'number' ? `（代码 ${code}${desc ? `：${desc}` : ''}）` : '，请检查连接后重试'}`))
            },
            onWarning: () => { if (alive) setNotice('编辑器连接出现提示，请检查编辑器内的通知。') },
          },
        })
        editor.current = instance
      } catch (e) { fail(e) }
    })()
    return () => {
      alive = false
      window.clearTimeout(readyTimer)
      operation.current?.abort()
      operation.current = null
      instance?.destroyEditor()
      editor.current = null
      mount?.replaceChildren()
    }
  }, [pid, attempt])

  // 仅切换稿件时清提示；attempt 重载（上传新版本后）保留成功提示供用户核对。
  useEffect(() => { setNotice('') }, [pid])

  // 状态只代表回传到服务器的 DOCX，不用编辑器的“已同步”事件冒充已落盘。
  useEffect(() => {
    if (phase !== 'ready') return
    let active = true
    const timer = window.setInterval(() => {
      void wordApi.state(pid).then((next) => { if (active) setState(next) }).catch(() => undefined)
    }, 5000)
    return () => { active = false; window.clearInterval(timer) }
  }, [pid, phase])

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty.current || operation.current) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])

  const run = useCallback(async (action: 'save' | 'download' | 'pdf') => {
    if (operation.current) return false
    const controller = new AbortController()
    operation.current = controller
    setBusy(true); setActionError(''); setNotice('')
    let sequence = editSequence.current
    try {
      let saved = await wordApi.state(pid)
      controller.signal.throwIfAborted()
      setState(saved)
      const needsSave = dirty.current || editorPending.current || editSequence.current !== sequence
      // 脏稿的新请求可清理上次失败状态；干净稿不能把失败状态下的快照声称为最新保存。
      if (!needsSave && saved.last_error) throw new Error(saved.last_error)
      if (needsSave && !canSave) throw new Error('当前文档存在未确认的修改，请使用可编辑账号保存后再下载。')
      if (needsSave) {
        // 先等浏览器端改动同步到文档服务，再请求服务端 forcesave；否则可能回传输入前的旧稿。
        const deadline = Date.now() + 15_000
        while (editorPending.current) {
          controller.signal.throwIfAborted()
          if (Date.now() > deadline) throw new Error('编辑器仍在同步修改，请等待连接恢复后再保存。')
          await new Promise((resolve) => window.setTimeout(resolve, 150))
        }
        sequence = editSequence.current
        saved = await saveWordAndWait(pid, { signal: controller.signal, onState: setState })
      } else if (saved.saving) throw new Error('文档服务正在保存，请等待保存完成后再试。')
      controller.signal.throwIfAborted()
      if (editSequence.current !== sequence || editorPending.current) throw new Error('保存期间又有新修改，请再次保存后下载。')
      dirty.current = false; setHasChanges(false)
      if (action === 'download') {
        const version = [...saved.versions].reverse().find((v) => v.sha === saved.sha)
        if (!version) throw new Error('尚未找到此稿件的已保存版本，请稍后重试。')
        await downloadFile(wordApi.versionDownloadUrl(pid, version.id), `${title}.docx`)
      }
      if (action === 'pdf') {
        const pdf = await wordApi.exportPdf(pid)
        controller.signal.throwIfAborted()
        if (pdf.sha !== saved?.sha) throw new Error('文档版本已更新，请重新导出 PDF')
        await downloadFile(pdf.url, `${title}.pdf`)
      }
      if (!controller.signal.aborted) setNotice(action === 'save' ? '已确认保存到服务器' : action === 'pdf' ? '已发起已保存版本的 PDF 下载，请查看浏览器下载列表。' : '已发起已保存版本的 Word 下载，请查看浏览器下载列表。')
      return !controller.signal.aborted
    } catch (e) {
      if (!controller.signal.aborted) setActionError(errorText(e))
      return false
    } finally {
      if (operation.current === controller) { operation.current = null; setBusy(false) }
    }
  }, [pid, title, canSave])

  useEffect(() => {
    const save = () => { if (phase === 'ready' && canSave) void run('save') }
    window.addEventListener('paper-word-save', save)
    return () => window.removeEventListener('paper-word-save', save)
  }, [phase, canSave, run])

  const downloadSaved = async (url: string, filename: string) => {
    try {
      await downloadFile(url, filename)
      setNotice('已发起所选已保存版本的下载，请查看浏览器下载列表。')
    } catch (e) { setActionError(errorText(e)) }
  }

  // 桌面 Word/WPS 往返：本地精调稿回传为新版本。带当前已知 sha 做并发核对；期间他人
  // 保存或 DS 回传中时后端 409，展示错误并刷新服务器快照，绝不静默强覆。
  const handleUploadFile = async (file: File) => {
    if (operation.current) return
    if (dirty.current || editorPending.current) {
      const ok = window.confirm('上传新版本将覆盖当前网页编辑器中的未保存修改，并生成新的历史版本快照（旧版本仍可下载）。是否继续？')
      if (!ok) return
    }
    setUploading(true); setActionError(''); setNotice('')
    try {
      const result = await wordApi.uploadVersion(pid, file, state?.sha ?? undefined)
      dirty.current = false
      editorPending.current = false
      setHasChanges(false)
      setState(result.state)
      setNotice(result.unchanged
        ? `上传的文件与已保存版本 ${result.version} 内容一致，未新增版本。`
        : `已上传为版本 ${result.version}，编辑器正在重新加载新内容。`)
      // 服务端已轮换 DS 会话键：递增 attempt 让编辑器用新 doc_key 重新拉取最新 DOCX，
      // 防止旧页签内容滞留或延迟回调覆写。
      setAttempt((v) => v + 1)
    } catch (e) {
      setActionError(errorText(e))
      void wordApi.state(pid).then((next) => setState(next)).catch(() => undefined)
    } finally {
      setUploading(false)
    }
  }

  // 引用编号重排（P1-0-B）：服务端权威 DOCX 确定性 OOXML 重排，与浏览器编辑器状态无关。
  // 与上传同语义：基于服务器已保存版本执行——未保存修改会被丢弃（轮换 doc_key 后编辑器重开
  // 加载最新文档），故脏稿先弹确认；409 冲突展示错误并刷新快照，绝不静默重试。
  const handleRenumberCitations = useCallback(async (style?: WordCitationStyle): Promise<WordRenumberResult | null> => {
    if (operation.current) return null
    if (dirty.current || editorPending.current) {
      const ok = window.confirm('重排引用将基于服务器已保存版本执行；当前网页编辑器中尚未保存的修改将被丢弃。'
        + '建议先点「保存」再重排。是否继续？')
      if (!ok) return null
    }
    const controller = new AbortController()
    operation.current = controller
    setRenumberBusy(true); setActionError(''); setNotice('')
    try {
      const result = await wordApi.renumberCitations(pid, { style, expected_sha: state?.sha })
      controller.signal.throwIfAborted()
      dirty.current = false
      editorPending.current = false
      setHasChanges(false)
      setState(result.state)
      if (result.changed) {
        // 重排会轮换会话键并重载编辑器（侧栏随之重开），警示并入工作台状态行才能跨重载可见。
        const warnText = (result.warnings ?? []).join('；')
        setNotice(`已按出现顺序重排引用（映射 ${Object.keys(result.mapping).length} 处编号），编辑器正在重新加载最新文档。`
          + (warnText ? `注意：${warnText}。` : ''))
        // 服务端已轮换 DS 会话键：递增 attempt 让编辑器用新 doc_key 重新拉取重排后的 DOCX。
        setAttempt((v) => v + 1)
      } else {
        setNotice('引用已按出现顺序排列，无需修改。')
      }
      return result
    } catch (e) {
      if (!controller.signal.aborted) setActionError(errorText(e))
      void wordApi.state(pid).then((next) => setState(next)).catch(() => undefined)
      return null
    } finally {
      if (operation.current === controller) { operation.current = null; setRenumberBusy(false) }
    }
  }, [pid, state?.sha])

  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-app text-fg" data-testid="word-workbench">
      <header className="flex flex-wrap items-center gap-2 border-b border-border bg-panel px-3 py-2">
        <a href="#/" className="rounded-sm px-2 py-1 text-sm text-fg-muted hover:bg-hover" onClick={(event) => {
          if (!dirty.current && !operation.current) return
          event.preventDefault()
          if (operation.current) { setNotice('正在处理保存或下载，请稍候再返回项目列表。'); return }
          if (phase === 'ready' && canSave) void run('save').then((saved) => { if (saved) window.location.assign('#/') })
          else setActionError('请先恢复编辑器连接并保存当前修改，再返回项目列表。')
        }}>所有项目</a>
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h1>
        <span className="rounded-sm bg-sunken px-2 py-1 text-xs text-fg-muted">Word</span>
        <Button variant="outline" size="sm" onClick={() => openCollabCenter('members')}><Users aria-hidden /> {canManage ? '邀请协作' : '协作者'}</Button>
        <Button variant="outline" size="sm" onClick={() => setVersionsOpen((v) => !v)} aria-expanded={versionsOpen}><History aria-hidden /> 版本</Button>
        <Button variant="outline" size="sm" disabled={phase !== 'ready' || !canSave || busy} onClick={() => void run('save')} data-testid="word-save"><Save aria-hidden /> 保存</Button>
        <Button variant="outline" size="sm" disabled={phase !== 'ready' || !canDownload || busy} onClick={() => void run('pdf')}><FileDown aria-hidden /> PDF</Button>
        <Button size="sm" disabled={phase !== 'ready' || !canDownload || busy} onClick={() => void run('download')} data-testid="word-download"><FileDown aria-hidden /> {canSave ? '保存并下载 Word' : '下载已保存 Word'}</Button>
        <Button variant={sidePanel === 'library' ? 'default' : 'outline'} size="sm" onClick={() => setSidePanel((v) => (v === 'library' ? null : 'library'))} aria-expanded={sidePanel === 'library'} data-testid="word-library-toggle"><BookOpen aria-hidden /> 文献</Button>
        <Button variant={sidePanel === 'proposals' ? 'default' : 'outline'} size="sm" onClick={() => setSidePanel((v) => (v === 'proposals' ? null : 'proposals'))} aria-expanded={sidePanel === 'proposals'} data-testid="word-proposals-toggle"><Sparkles aria-hidden /> 论文助手</Button>
        <Button variant={sidePanel === 'preflight' ? 'default' : 'outline'} size="sm" disabled={phase !== 'ready' || busy} onClick={() => setSidePanel((v) => (v === 'preflight' ? null : 'preflight'))} aria-expanded={sidePanel === 'preflight'} data-testid="word-preflight-toggle"><ShieldCheck aria-hidden /> 投稿检查</Button>
        <Button variant={sidePanel === 'rebuttal' ? 'default' : 'outline'} size="sm" disabled={phase !== 'ready' || busy} onClick={() => setSidePanel((v) => (v === 'rebuttal' ? null : 'rebuttal'))} aria-expanded={sidePanel === 'rebuttal'} data-testid="word-rebuttal-toggle"><MessageSquareQuote aria-hidden /> 回复信</Button>
        <Button variant={sidePanel === 'comments' ? 'default' : 'outline'} size="sm" disabled={phase !== 'ready' || busy} onClick={() => setSidePanel((v) => (v === 'comments' ? null : 'comments'))} aria-expanded={sidePanel === 'comments'} data-testid="word-comments-toggle"><MessageSquareText aria-hidden /> 批注</Button>
      </header>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border bg-panel px-3 py-1.5 text-xs text-fg-muted" role="status" aria-live="polite">
        <span>{busy ? '正在等待保存确认…' : hasChanges ? '有修改待确认保存' : state?.saving ? '文档服务正在回传文件…' : state ? `已保存版本 ${state.version}` : '正在读取文档…'}</span>
        {state && <span>服务器保存时间：{formatTime(state.updated_at)}</span>}
        {phase === 'ready' && <span>公式：Alt+=；居中编号：公式末尾输入 #(2) 后回车；LaTeX 编辑可打开「插件」</span>}
        {notice && <span className="text-fg">{notice}</span>}
      </div>
      {actionError && <div className="border-b border-border bg-panel px-3 py-2 text-sm" role="alert">
        <p className="text-danger-fg">{actionError}</p>
        {canDownload && !!state?.versions.length && <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-xs text-fg-muted">可查看服务器已保存版本；尚未回传的修改不在其中。</span>
          <Button size="xs" variant="outline" onClick={() => setVersionsOpen(true)}>查看已保存版本</Button>
        </div>}
      </div>}
      {state?.last_error && !actionError && <p className="border-b border-border bg-panel px-3 py-2 text-sm text-danger-fg" role="alert">{state.last_error}</p>}
      <main className="relative flex min-h-0 flex-1 overflow-hidden">
        <div className="relative min-h-0 min-w-0 flex-1">
          <div ref={host} className="h-full w-full" data-testid="word-editor-host" />
          {phase !== 'ready' && <div className="absolute inset-0 grid place-items-center bg-app px-5" data-testid="word-loading">
            <div className="max-w-lg space-y-3 text-center">
              {phase === 'loading' ? <><Loader2 className="mx-auto size-6 animate-spin text-fg-muted" aria-hidden /><p className="text-sm">正在打开 Word 文档…</p></> : <>
                <p className="font-semibold">{phase === 'unconfigured' ? 'Word 编辑服务尚未就绪' : '暂时无法打开 Word 编辑器'}</p>
                <p className="text-sm text-fg-muted" role="alert">{error}</p>
                <Button variant="outline" size="sm" onClick={() => setAttempt((v) => v + 1)}><RefreshCw aria-hidden /> 重试</Button>
                {state && canDownload && <Button variant="outline" size="sm" className="ml-2" onClick={() => void downloadSaved(wordApi.downloadUrl(pid), `${title}.docx`)}>下载服务器已保存版本</Button>}
              </>}
            </div>
          </div>}
        </div>
        {phase === 'ready' && sidePanel && (
          <WordSidePanels
            pid={pid}
            docKey={docKey}
            canEdit={canSave}
            saving={Boolean(state?.saving)}
            stateSha={state?.sha ?? null}
            stateVersion={state?.version ?? null}
            open={sidePanel}
            onClose={() => setSidePanel(null)}
            onRenumberCitations={handleRenumberCitations}
            renumberBusy={renumberBusy}
          />
        )}
        {versionsOpen && <aside className="w-72 max-w-[80vw] overflow-auto border-l border-border bg-panel p-3" aria-label="Word 已保存版本">
          <h2 className="text-sm font-semibold">已保存版本</h2>
          <p className="my-2 text-xs text-fg-muted">每次文件回传后记录版本。历史版本不包含尚未回传的修改，下载不会覆盖当前稿件，也不代表本次修改已保存。</p>
          {canSave && <div className="space-y-1 border-b border-border pb-2">
            <Button size="xs" variant="outline" disabled={busy || uploading} onClick={() => uploadInput.current?.click()} data-testid="word-upload-version">
              <Upload aria-hidden /> {uploading ? '正在上传…' : '上传本地修改稿（.docx）'}
            </Button>
            <p className="text-xs text-fg-muted">以本地精调稿覆盖服务器当前稿并生成新版本；旧版本仍可下载。</p>
            <input ref={uploadInput} type="file" accept=".docx" className="hidden" tabIndex={-1} aria-hidden="true"
              onChange={(e) => {
                const picked = e.target.files?.[0]
                e.target.value = ''
                if (picked) void handleUploadFile(picked)
              }} />
          </div>}
          {[...(state?.versions ?? [])].reverse().map((version, index) => <div key={version.id} className="space-y-1 border-b border-border py-2">
            <p className="text-xs font-medium">版本 {(state?.versions.length ?? 0) - index}</p>
            <p className="text-xs">{formatTime(version.created_at)}</p>
            {canDownload && <Button size="xs" variant="outline" onClick={() => void downloadSaved(wordApi.versionDownloadUrl(pid, version.id), `${title}-${version.id}.docx`)}>下载此版本</Button>}
          </div>)}
          {!state?.versions.length && <p className="text-xs text-fg-muted">暂无版本记录</p>}
        </aside>}
      </main>
    </div>
  )
}

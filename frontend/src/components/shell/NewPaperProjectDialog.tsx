import { useEffect, useState } from 'react'
import { FileText, FileUp, Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Segmented } from '@/components/ui/segmented'
import { latexApi } from '@/lib/api/latex'
import { wordApi } from '@/lib/api/word'
import { structApi, type PaperTemplatesReply } from '@/lib/api/struct'
import { thumbUrl } from '@/lib/api/paperTemplates'
import { ApiError } from '@/lib/api/net'
import { useStudio } from '@/store'
import { cn } from '@/lib/utils'

/** 新建弹窗内的模板缩略图：thumb 布尔先行过滤（不发无效请求），onError 回退到图标布局。 */
function TemplateThumb({ format, id, name, version, updatedAt, thumb, icon, className }: {
  format: 'latex' | 'docx'; id: string; name: string; version?: number; updatedAt?: number | null
  thumb?: boolean; icon?: React.ReactNode; className?: string
}) {
  const [broken, setBroken] = useState(false)
  if (!thumb || broken) return <>{icon ?? null}</>
  return <img src={thumbUrl({ format, id, version, updated_at: updatedAt })} alt={`${name} 首页预览`} loading="lazy" aria-hidden
    onError={() => setBroken(true)} className={cn('h-12 w-9 shrink-0 rounded-xs border border-border object-cover object-top', className)} />
}

/** Word 原稿是中文论文默认入口；存量结构化稿件在原工作台提供转换入口。 */
export function NewPaperProjectDialog({ open, onOpenChange, onZipImport }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** 上传压缩包：宿主（Dashboard）打开既有 ImportDialog（两段式 ZIP 导入）；未提供（移动端）时隐藏该按钮 */
  onZipImport?: () => void
}) {
  const closeDialog = useStudio((s) => s.closeDialog)
  const wordEditorEnabled = useStudio((s) => s.wordEditorEnabled)
  const wordEditorReady = useStudio((s) => s.wordEditorReady)
  const toast = useStudio((s) => s.toast)
  const [mode, setMode] = useState<'latex' | 'word'>('word')
  const [wordTemplate, setWordTemplate] = useState('blank')
  const [wordFile, setWordFile] = useState<File | null>(null)
  const [reg, setReg] = useState<PaperTemplatesReply | null>(null)
  const [regErr, setRegErr] = useState('')
  const [templateId, setTemplateId] = useState('blank')
  const [tplQuery, setTplQuery] = useState('')
  const [title, setTitle] = useState('')
  const [venue, setVenue] = useState('')
  const [field, setField] = useState('')
  const [rank, setRank] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setErr(null)
    setRegErr('')
    setBusy(false)
    if (useStudio.getState().wordEditorEnabled === null) void useStudio.getState().fetchMeta()
    let alive = true
    structApi.paperTemplates()
      .then((r) => {
        if (!alive) return
        setReg(r)
        if (!r.latex.some((t) => t.id === templateId)) setTemplateId(r.latex[0]?.id ?? '')
        setWordTemplate((old) => r.word?.some((t) => t.id === old) ? old : r.word?.[0]?.id ?? '')
      })
      .catch((e) => { if (alive) setRegErr(e instanceof ApiError ? e.message : String(e)) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const activeMode = mode
  const wordAvailable = wordEditorEnabled === true && wordEditorReady === true

  async function create() {
    setBusy(true)
    setErr(null)
    try {
      let pid: string
      if (activeMode === 'latex') {
        const p = await latexApi.createDemo(templateId, title.trim() || undefined)
        toast(`已创建「${p.title || p.id}」`, 'success')
        pid = p.id
      } else {
        if (!wordAvailable) throw new Error('Word 编辑服务尚未就绪，请联系管理员配置 ONLYOFFICE 文档服务。')
        const p = wordFile
          ? await wordApi.import(wordFile, title.trim() || undefined)
          : await wordApi.create({ title: title.trim() || '未命名论文', template: wordTemplate, venue, field, rank })
        toast(`已创建「${p.title || p.id}」`, 'success')
        pid = p.id
      }
      onOpenChange(false)
      window.location.assign(`#/p/${encodeURIComponent(pid)}`)
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="new-paper-dialog" className="sm:max-w-2xl sm:max-h-[calc(100dvh-2rem)] sm:overflow-y-auto">
        <DialogHeader>
          <DialogTitle>新建项目</DialogTitle>
          <DialogDescription>
            使用 Word 模板直接写作，或选择 LaTeX 工程进行编译预览。
          </DialogDescription>
        </DialogHeader>

        <Segmented
          options={[
            { value: 'word', label: 'Word 论文' },
            { value: 'latex', label: 'LaTeX 论文' },
          ]}
          value={activeMode}
          onValueChange={(v) => setMode(v as 'latex' | 'word')}
          aria-label="写作模式"
          size="md"
          data-testid="np-mode"
        />

        {activeMode === 'latex' ? (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="np-paper-title">项目名称</Label>
              <Input id="np-paper-title" value={title} onChange={(e) => setTitle(e.target.value)}
                placeholder="可留空，使用模板默认标题" data-testid="np-title" />
            </div>
            <div className="space-y-1">
              <Label>模板库</Label>
              {regErr && <p className="text-xs text-danger-fg">模板库加载失败：{regErr}</p>}
              {!reg && !regErr && <Loader2 className="size-4 animate-spin text-fg-muted" aria-label="加载模板" />}
              <Input value={tplQuery} onChange={(e) => setTplQuery(e.target.value)}
                placeholder="搜索模板（名称 / 出版商 / 关键词）" data-testid="np-template-search" />
              <div className="max-h-56 space-y-1 overflow-auto" data-testid="np-templates">
                {(reg?.latex ?? [])
                  .filter((t) => {
                    const q = tplQuery.trim().toLowerCase()
                    if (!q) return true
                    return [t.name, t.desc, t.venue, t.kind, t.language].some((x) => (x ?? '').toLowerCase().includes(q))
                  })
                  .map((t) => (
                  <label key={t.id}
                    className="flex cursor-pointer items-start gap-2 rounded-sm border border-border px-2 py-1.5 hover:bg-hover"
                    data-testid={`np-template-${t.id}`}>
                    <input type="radio" name="np-template" className="mt-1" checked={templateId === t.id}
                      onChange={() => setTemplateId(t.id)} />
                    <TemplateThumb format="latex" id={t.id} name={t.name} version={t.version} updatedAt={t.updated_at} thumb={t.thumb} />
                    <span className="min-w-0">
                      <span className="block text-sm text-fg">{t.name}</span>
                      <span className="block text-2xs text-fg-muted">{t.desc}</span>
                      <span className="mt-0.5 flex flex-wrap gap-1">
                        {[t.language, t.kind, t.venue, t.year].filter(Boolean).map((x, xi) => (
                          <span key={`${t.id}-${xi}`} className="rounded-xs bg-hover px-1 text-2xs text-fg-muted">{x}</span>
                        ))}
                        {t.verify === 'verified'
                          ? <Badge tone="ok" className="h-4 px-1.5 text-2xs">已验证编译</Badge>
                          : <Badge tone="warn" className="h-4 px-1.5 text-2xs">编译待验证</Badge>}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
            {onZipImport && (
              <Button type="button" variant="outline" size="sm" className="w-full"
                onClick={() => { onOpenChange(false); onZipImport() }} data-testid="np-zip">
                <FileUp aria-hidden /> 上传压缩包（LaTeX 工程 ZIP）
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="np-word-title">项目名称</Label>
              <Input id="np-word-title" value={title} onChange={(e) => setTitle(e.target.value)}
                placeholder="未命名论文" data-testid="np-word-title" />
            </div>
            {!wordAvailable && <p className="rounded-md border border-border bg-sunken p-3 text-sm text-fg-muted" role="status" data-testid="np-word-unavailable">
              {wordEditorEnabled === null ? '正在检查 Word 编辑服务…' : 'Word 编辑服务尚未就绪。请联系管理员启用 Word 编辑并配置 ONLYOFFICE 文档服务，然后重新打开此窗口。'}
            </p>}
            <div className="space-y-2">
              <Label>开始写作</Label>
              {regErr && <p role="alert" className="text-xs text-danger-fg">模板库加载失败：{regErr}</p>}
              {!reg && !regErr && <p className="text-sm text-fg-muted" role="status">正在加载模板…</p>}
              {reg && !reg.word?.length && <p className="text-sm text-fg-muted" role="status">暂无 Word 模板，可上传现有文档，或联系管理员添加模板。</p>}
              <div className="max-h-56 space-y-2 overflow-y-auto">
              {(reg?.word ?? []).map((t) => (
                <label key={t.id} className="flex cursor-pointer items-start gap-2 rounded-sm border border-border px-2 py-2 hover:bg-hover" data-testid={`np-word-template-${t.id}`}>
                  <input type="radio" name="np-word-template" checked={!wordFile && wordTemplate === t.id} onChange={() => { setWordFile(null); setWordTemplate(t.id); if (t.venue && !venue) setVenue(t.venue) }} />
                  <TemplateThumb format="docx" id={t.id} name={t.name} version={t.version} updatedAt={t.updated_at} thumb={t.thumb} icon={<FileText aria-hidden className="mt-0.5 size-4 text-fg-muted" />} />
                  <span><span className="block text-sm">{t.name}</span><span className="block text-xs text-fg-muted">{t.desc}</span></span>
                </label>
              ))}
              </div>
              <Label
                htmlFor="np-word-file"
                className={cn(
                  'relative flex cursor-pointer items-center gap-2 rounded-sm border border-border px-2 py-2 hover:bg-hover focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring',
                  wordFile && 'border-border-strong bg-hover',
                )}
              >
                <input
                  id="np-word-file"
                  type="file"
                  className="sr-only"
                  accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  data-testid="np-word-file"
                  onChange={(e) => {
                    const file = e.target.files?.[0] ?? null
                    setErr(null)
                    if (file && !file.name.toLowerCase().endsWith('.docx')) { setWordFile(null); setErr('请选择 .docx 格式的 Word 文档'); e.target.value = ''; return }
                    setWordFile(file)
                  }}
                />
                <FileUp aria-hidden className="size-4 shrink-0 text-fg-muted" />
                <span className="truncate">{wordFile ? `重新选择文档（已选：${wordFile.name}）` : '上传现有 Word 文档'}</span>
              </Label>
              {wordFile && <p className="text-xs text-fg-muted" data-testid="np-word-selected">将上传：{wordFile.name}。现有模板、正文和原生公式随 DOCX 保留。</p>}
            </div>
            {!wordFile && <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="space-y-1">
                <Label htmlFor="np-venue">投稿目标</Label>
                <Input id="np-venue" value={venue} onChange={(e) => setVenue(e.target.value)} placeholder="可选" data-testid="np-venue" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="np-field">学科领域</Label>
                <Input id="np-field" value={field} onChange={(e) => setField(e.target.value)} placeholder="可选" data-testid="np-field" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="np-rank">等级分区</Label>
                <Input id="np-rank" value={rank} onChange={(e) => setRank(e.target.value)} placeholder="可选，如 CCF-A" data-testid="np-rank" />
              </div>
            </div>}
          </div>
        )}

        {err && <p className="text-sm text-danger-fg" role="alert">{err}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => { onOpenChange(false); closeDialog() }}>取消</Button>
          <Button onClick={() => void create()} disabled={busy || (activeMode === 'latex' ? !templateId || !reg || !!regErr : !wordAvailable || (!wordFile && (!reg || !!regErr || !wordTemplate)))} data-testid="np-create">
            {busy && <Loader2 aria-hidden className="size-3.5 animate-spin" />} 创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

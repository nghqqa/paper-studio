import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Eye, ImageOff, Loader2, Pencil, Plus, RotateCcw, Search, Trash2, Upload } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Segmented } from '@/components/ui/segmented'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { paperTemplatesApi, thumbUrl, type ManagedPaperTemplate, type PaperTemplateInput, type PaperTemplatePatch, type PaperTemplateReplaceMeta } from '@/lib/api/paperTemplates'
import { useStudio } from '@/store'
import { cn } from '@/lib/utils'

/** 模板首页缩略图（broken-url 模式：url 变化自动复位；缺失/加载失败回退 dashed 占位，不发无效请求） */
function TemplateThumb({ t, className }: { t: Pick<ManagedPaperTemplate, 'format' | 'id' | 'name' | 'thumb' | 'version' | 'updated_at'>; className?: string }) {
  const [broken, setBroken] = useState<string | null>(null)
  const url = thumbUrl(t)
  if (!t.thumb || broken === url) {
    return <div className={cn('flex items-center justify-center rounded-xs border border-dashed border-border-strong text-fg-muted', className ?? 'h-12 w-9')} role="img" aria-label={`${t.name} 暂无预览`}><ImageOff className="size-4" aria-hidden /></div>
  }
  return <img src={url} alt={`${t.name} 首页预览`} loading="lazy" onError={() => setBroken(url)}
    className={cn('rounded-xs border border-border object-cover object-top', className ?? 'h-12 w-9 shrink-0')} />
}

function UploadTemplate({ onClose, onAdded }: { onClose(): void; onAdded(): Promise<void> }) {
  const [form, setForm] = useState<PaperTemplateInput>({ format: 'docx', name: '', venue: '', desc: '', language: '中文', kind: '期刊', main: '', engine: 'xelatex' })
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const patch = (values: Partial<PaperTemplateInput>) => setForm((f) => ({ ...f, ...values }))
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      await paperTemplatesApi.upload({ ...form, name: form.name.trim() }, file!)
      await onAdded(); onClose()
    } catch (e) { setError(e instanceof Error ? e.message : '上传失败，请重试') }
    finally { setBusy(false) }
  }
  return <Dialog open onOpenChange={(v) => { if (!v && !busy) onClose() }}>
    <DialogContent className="sm:max-w-xl max-h-[calc(100dvh-2rem)] overflow-y-auto" data-testid="paper-template-upload">
      <DialogHeader><DialogTitle>添加论文模板</DialogTitle><DialogDescription>保存后，所有成员都能在新建项目时使用。请先确认模板的排版和来源。</DialogDescription></DialogHeader>
      <form onSubmit={(e) => void submit(e)} className="grid gap-4">
        <Segmented aria-label="模板格式" value={form.format} options={[{ value: 'docx', label: 'Word' }, { value: 'latex', label: 'LaTeX' }]}
          onValueChange={(value) => { patch({ format: value as 'docx' | 'latex' }); setFile(null) }} />
        <div className="grid gap-1"><Label htmlFor="pt-name">模板名称</Label><Input id="pt-name" required maxLength={120} value={form.name} onChange={(e) => patch({ name: e.target.value })} placeholder="如：中文信息学报投稿模板" /></div>
        <div className="grid gap-1"><Label htmlFor="pt-venue">期刊或会议</Label><Input id="pt-venue" maxLength={200} value={form.venue} onChange={(e) => patch({ venue: e.target.value })} placeholder="可选" /></div>
        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-1"><Label htmlFor="pt-language">语言</Label><Input id="pt-language" maxLength={40} value={form.language} onChange={(e) => patch({ language: e.target.value })} /></div>
          <div className="grid gap-1"><Label htmlFor="pt-kind">文档类型</Label><Input id="pt-kind" maxLength={40} value={form.kind} onChange={(e) => patch({ kind: e.target.value })} placeholder="期刊 / 会议 / 学位论文" /></div>
        </div>
        <div className="grid gap-1"><Label htmlFor="pt-desc">说明</Label><Input id="pt-desc" maxLength={500} value={form.desc} onChange={(e) => patch({ desc: e.target.value })} placeholder="模板版本、投稿要求或适用范围" /></div>
        {form.format === 'latex' && <div className="grid gap-3 rounded-md border border-border p-3">
          <div className="grid gap-1"><Label htmlFor="pt-main">主文件路径（可选）</Label><Input id="pt-main" value={form.main} onChange={(e) => patch({ main: e.target.value })} placeholder="留空 = 自动检测（如 main.tex 或 template/main.tex）" /><p className="text-xs text-fg-muted">留空时平台自动扫描 ZIP 内含 \documentclass 的 .tex 并优先选择 *-template*；也可手动填写完整相对路径。</p></div>
          <div className="grid gap-1"><Label htmlFor="pt-engine">编译引擎</Label><Select value={form.engine} onValueChange={(value) => patch({ engine: value as PaperTemplateInput['engine'] })}><SelectTrigger id="pt-engine"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="xelatex">XeLaTeX（中文常用）</SelectItem><SelectItem value="pdflatex">pdfLaTeX</SelectItem></SelectContent></Select></div>
        </div>}
        <div className="grid gap-1"><Label htmlFor="pt-file">{form.format === 'docx' ? 'Word 模板文件（.docx）' : 'LaTeX 工程（.zip）'}</Label>
          <Input key={form.format} id="pt-file" type="file" required accept={form.format === 'docx' ? '.docx' : '.zip'} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <p className="text-xs text-fg-muted">{form.format === 'docx' ? '完整保留原件的公式、页眉和分栏。旧版 .doc 请先另存为 .docx。' : '包含主文件、样式、参考文献和图片。上传后平台将自动验证编译并生成预览。'}</p>
        </div>
        {error && <p role="alert" className="text-sm text-danger-fg">{error}</p>}
        <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={onClose}>取消</Button><Button type="submit" disabled={busy || !file || !form.name.trim()}>{busy && <Loader2 className="animate-spin" aria-hidden />}{busy ? '保存中…' : '添加模板'}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}

/** 编辑元信息：展示字段 builtin/upload 均可改；main/engine 仅上传的 LaTeX 模板（服务端白名单兜底）。 */
function EditTemplate({ t, onClose, onSaved }: { t: ManagedPaperTemplate; onClose(): void; onSaved(row: ManagedPaperTemplate): void }) {
  const [form, setForm] = useState({ name: t.name, desc: t.desc ?? '', venue: t.venue ?? '', language: t.language ?? '', kind: t.kind ?? '', year: t.year ?? '', main: t.main ?? '', engine: t.engine ?? 'xelatex' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const patch = (values: Partial<typeof form>) => setForm((f) => ({ ...f, ...values }))
  const structural = t.origin === 'upload' && t.format === 'latex'
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const body: PaperTemplatePatch = { name: form.name.trim(), desc: form.desc, venue: form.venue, language: form.language, kind: form.kind, year: form.year }
      if (structural) { body.main = form.main.trim(); body.engine = form.engine }
      onSaved(await paperTemplatesApi.updateMeta(t, body)); onClose()
    } catch (e) { setError(e instanceof Error ? e.message : '保存失败，请重试') }
    finally { setBusy(false) }
  }
  return <Dialog open onOpenChange={(v) => { if (!v && !busy) onClose() }}>
    <DialogContent className="sm:max-w-xl max-h-[calc(100dvh-2rem)] overflow-y-auto" data-testid="paper-template-edit">
      <DialogHeader><DialogTitle>编辑模板「{t.name}」</DialogTitle>
        <DialogDescription>{structural ? '修改后重新验收编译前，模板会显示为「编译待验证」。' : '内置模板的展示信息可调整；源文件与编译引擎随版本只读。'}</DialogDescription></DialogHeader>
      <form onSubmit={(e) => void submit(e)} className="grid gap-4">
        <div className="grid gap-1"><Label htmlFor="pte-name">模板名称</Label><Input id="pte-name" required maxLength={120} value={form.name} onChange={(e) => patch({ name: e.target.value })} /></div>
        <div className="grid gap-1"><Label htmlFor="pte-venue">期刊或会议</Label><Input id="pte-venue" maxLength={200} value={form.venue} onChange={(e) => patch({ venue: e.target.value })} placeholder="可选" /></div>
        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-1"><Label htmlFor="pte-language">语言</Label><Input id="pte-language" maxLength={40} value={form.language} onChange={(e) => patch({ language: e.target.value })} /></div>
          <div className="grid gap-1"><Label htmlFor="pte-kind">文档类型</Label><Input id="pte-kind" maxLength={40} value={form.kind} onChange={(e) => patch({ kind: e.target.value })} /></div>
        </div>
        <div className="grid gap-1"><Label htmlFor="pte-desc">说明</Label><Input id="pte-desc" maxLength={500} value={form.desc} onChange={(e) => patch({ desc: e.target.value })} /></div>
        <div className="grid gap-1"><Label htmlFor="pte-year">年份</Label><Input id="pte-year" maxLength={20} value={form.year} onChange={(e) => patch({ year: e.target.value })} placeholder="可选" /></div>
        {structural && <div className="grid gap-3 rounded-md border border-border p-3">
          <div className="grid gap-1"><Label htmlFor="pte-main">主文件路径</Label><Input id="pte-main" maxLength={240} value={form.main} onChange={(e) => patch({ main: e.target.value })} placeholder="模板压缩包内的 .tex 相对路径" /><p className="text-xs text-fg-muted">修改主文件或编译引擎会重置「已验证编译」状态，需重新验证。</p></div>
          <div className="grid gap-1"><Label htmlFor="pte-engine">编译引擎</Label><Select value={form.engine} onValueChange={(value) => patch({ engine: value as PaperTemplatePatch['engine'] })}><SelectTrigger id="pte-engine"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="xelatex">XeLaTeX（中文常用）</SelectItem><SelectItem value="pdflatex">pdfLaTeX</SelectItem></SelectContent></Select></div>
        </div>}
        {error && <p role="alert" className="text-sm text-danger-fg">{error}</p>}
        <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={onClose}>取消</Button><Button type="submit" disabled={busy || !form.name.trim()}>{busy && <Loader2 className="animate-spin" aria-hidden />}{busy ? '保存中…' : '保存'}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}

/** 替换版本（仅 origin=upload）：tid 不变、版本自增、verify 重置；失败完整回滚。 */
function ReplaceTemplate({ t, onClose, onSaved }: { t: ManagedPaperTemplate; onClose(): void; onSaved(row: ManagedPaperTemplate): void }) {
  const [file, setFile] = useState<File | null>(null)
  const [meta, setMeta] = useState<PaperTemplateReplaceMeta>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const latex = t.format === 'latex'
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const row = await paperTemplatesApi.replaceFile(t, file!, latex ? meta : undefined)
      onSaved(row); onClose()
    } catch (e) { setError(e instanceof Error ? e.message : '替换失败，请重试') }
    finally { setBusy(false) }
  }
  return <Dialog open onOpenChange={(v) => { if (!v && !busy) onClose() }}>
    <DialogContent className="sm:max-w-xl" data-testid="paper-template-replace">
      <DialogHeader><DialogTitle>替换「{t.name}」为新版本</DialogTitle>
        <DialogDescription>当前第 {t.version ?? 1} 版。替换后模板 id 不变、版本号 +1，验收状态重置；已创建的项目保留原内容不受影响。</DialogDescription></DialogHeader>
      <form onSubmit={(e) => void submit(e)} className="grid gap-4">
        <div className="grid gap-1"><Label htmlFor="ptr-file">{latex ? '新版本 LaTeX 工程（.zip）' : '新版本 Word 模板（.docx）'}</Label>
          <Input id="ptr-file" type="file" required accept={latex ? '.zip' : '.docx'} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <p className="text-xs text-fg-muted">替换成功后平台会自动重新验收并更新首页预览。</p></div>
        {latex && <div className="grid gap-3 rounded-md border border-border p-3">
          <div className="grid gap-1"><Label htmlFor="ptr-main">主文件路径</Label><Input id="ptr-main" maxLength={240} value={meta.main ?? ''} onChange={(e) => setMeta((m) => ({ ...m, main: e.target.value }))} placeholder={`留空沿用当前 ${t.main || 'main.tex'}`} /><p className="text-xs text-fg-muted">留空沿用当前主文件；填写后按新包内容校验。</p></div>
          <div className="grid gap-1"><Label htmlFor="ptr-engine">编译引擎</Label>
            <Select value={meta.engine ?? ''} onValueChange={(value) => setMeta((m) => ({ ...m, engine: value as PaperTemplateReplaceMeta['engine'] }))}>
              <SelectTrigger id="ptr-engine"><SelectValue placeholder="沿用当前引擎" /></SelectTrigger>
              <SelectContent><SelectItem value="xelatex">XeLaTeX（中文常用）</SelectItem><SelectItem value="pdflatex">pdfLaTeX</SelectItem></SelectContent>
            </Select></div>
        </div>}
        {error && <p role="alert" className="text-sm text-danger-fg">{error}</p>}
        <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={onClose}>取消</Button><Button type="submit" disabled={busy || !file}>{busy && <Loader2 className="animate-spin" aria-hidden />}{busy ? '替换中…' : '替换版本'}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}

/** 详情预览：大图 + 元信息 + 验收失败原因与日志尾部。 */
function DetailDialog({ t, onClose, onPreview }: { t: ManagedPaperTemplate; onClose(): void; onPreview(t: ManagedPaperTemplate): void }) {
  const [broken, setBroken] = useState<string | null>(null)
  const url = thumbUrl(t)
  return <Dialog open onOpenChange={(v) => { if (!v) onClose() }}>
    <DialogContent className="sm:max-w-lg max-h-[calc(100dvh-2rem)] overflow-y-auto" data-testid="paper-template-detail">
      <DialogHeader><DialogTitle>{t.name}</DialogTitle><DialogDescription>{[t.origin === 'builtin' ? '内置模板' : `管理员上传 · 第 ${t.version ?? 1} 版`, t.venue, t.year].filter(Boolean).join(' · ')}</DialogDescription></DialogHeader>
      <div className="grid gap-3">
        {t.thumb && broken !== url
          ? <img src={url} alt={`${t.name} 首页预览`} onError={() => setBroken(url)} className="max-h-96 w-full rounded-md border border-border object-contain" />
          : <div className="flex h-48 items-center justify-center rounded-md border border-dashed border-border-strong text-fg-muted" role="img" aria-label="暂无预览图"><div className="grid justify-items-center gap-2 text-xs"><ImageOff className="size-6" aria-hidden />{t.format === 'latex' ? '通过「验证编译」后自动生成预览' : '通过「生成预览」后自动生成'}</div></div>}
        <dl className="grid gap-1 text-sm">
          {[['格式', t.format === 'docx' ? 'Word' : 'LaTeX'], ['语言', t.language], ['类型', t.kind], ['说明', t.desc],
            [t.format === 'latex' ? '主文件' : null, t.format === 'latex' ? `${t.engine} · ${t.main}` : null]].filter((p) => p[0] && p[1]).map(([k, v]) => (
            <div key={k} className="grid grid-cols-[auto_1fr] gap-2"><dt className="text-fg-muted">{k}</dt><dd className="break-all text-fg">{v}</dd></div>
          ))}
        </dl>
        {t.verify_error && <div className="grid gap-1 rounded-md border border-danger-bg bg-danger-bg/40 p-3 text-sm" data-testid={`pt-detail-error-${t.format}-${t.id}`}>
          <p className="font-medium text-danger-fg">验收未通过：{t.verify_error}</p>
          {t.verify_log_tail && <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-sm bg-sunken p-2 text-2xs text-fg-muted">{t.verify_log_tail}</pre>}
        </div>}
        {!t.thumb && t.enabled && <Button variant="outline" size="sm" onClick={() => onPreview(t)}>
          {t.format === 'latex' ? '验证编译并生成预览' : '生成预览'}
        </Button>}
      </div>
      <DialogFooter><Button variant="outline" onClick={onClose}>关闭</Button></DialogFooter>
    </DialogContent>
  </Dialog>
}

export function PaperTemplatesPanel({ mobile = false }: { mobile?: boolean }) {
  const authOff = useStudio((s) => s.authStatus === 'off')
  const [items, setItems] = useState<ManagedPaperTemplate[]>([])
  const [autoAccept, setAutoAccept] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [showRemoved, setShowRemoved] = useState(false)
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<ManagedPaperTemplate | null>(null)
  const [editing, setEditing] = useState<ManagedPaperTemplate | null>(null)
  const [replacing, setReplacing] = useState<ManagedPaperTemplate | null>(null)
  // 详情弹窗只存 {format,id} 标识：行内验收/轮询更新 items 后，弹窗按标识实时派生当前行（快照不陈旧）
  const [detail, setDetail] = useState<{ format: ManagedPaperTemplate['format']; id: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [verifying, setVerifying] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState<string | null>(null)
  const mergeRow = useCallback((row: ManagedPaperTemplate) => {
    setItems((list) => list.map((old) => old.id === row.id && old.format === row.format ? row : old))
  }, [])
  const load = useCallback(async () => {
    setLoading(true); setError('')
    try { const r = await paperTemplatesApi.list(); setItems(r.items); setAutoAccept(r.auto_accept) }
    catch (e) { setError(e instanceof Error ? e.message : '模板库加载失败') }
    finally { setLoading(false) }
  }, [])
  /** 静默刷新（自动验收轮询用，不闪 loading 骨架） */
  const refresh = useCallback(async () => {
    try { const r = await paperTemplatesApi.list(); setItems(r.items); setAutoAccept(r.auto_accept) } catch { /* 轮询失败静默 */ }
  }, [])
  useEffect(() => { if (!authOff) void load() }, [authOff, load])
  // 自动验收进行中（存在未验证模板）每 5s 轮询，状态与缩略图落地即停
  const pendingVerify = autoAccept && items.some((t) => t.enabled && t.verify !== 'verified')
  useEffect(() => {
    if (!pendingVerify) return
    const timer = window.setInterval(() => { void refresh() }, 5000)
    return () => window.clearInterval(timer)
  }, [pendingVerify, refresh])
  useEffect(() => {
    if (!pendingVerify) return
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 进入待验收态立即刷一次
  }, [pendingVerify])
  async function change(t: ManagedPaperTemplate, restore: boolean) {
    setBusy(true); setError('')
    try {
      const row = await (restore ? paperTemplatesApi.restore(t) : paperTemplatesApi.remove(t))
      mergeRow(row); setRemoving(null)
    } catch (e) { setError(e instanceof Error ? e.message : '操作失败，请重试') }
    finally { setBusy(false) }
  }
  /** 验证编译：真实跑一遍 latexmk；成功后行内状态、缩略图与新建入口徽章同步。 */
  async function verify(t: ManagedPaperTemplate) {
    const key = `${t.format}-${t.id}`
    setVerifying(key); setError('')
    try {
      const r = await paperTemplatesApi.verify(t)
      mergeRow({ ...t, verify: r.verify, verify_error: r.verify_error, verified_at: r.verified_at, thumb: r.thumb })
    } catch (e) { setError(e instanceof Error ? e.message : '验证失败，请重试') }
    finally { setVerifying(null) }
  }
  /** Word 生成预览：ONLYOFFICE 转换验收（失败原因后端已持久化，行内展示）。 */
  async function preview(t: ManagedPaperTemplate) {
    const key = `${t.format}-${t.id}`
    setPreviewing(key); setError('')
    try {
      const r = await paperTemplatesApi.preview(t)
      mergeRow({ ...t, verify: r.verify, verify_error: r.verify_error, verified_at: r.verified_at, thumb: r.thumb })
      if (r.status === 'error') setDetail(r)
    } catch (e) { setError(e instanceof Error ? e.message : '生成预览失败，请重试') }
    finally { setPreviewing(null) }
  }
  const q = query.trim().toLowerCase()
  const shown = items.filter((t) => (showRemoved || t.enabled) && (!q || [t.name, t.venue, t.desc].some((x) => x?.toLowerCase().includes(q))))
  const detailRow = detail ? items.find((t) => t.format === detail.format && t.id === detail.id) ?? null : null
  if (authOff) return <p role="status" className="rounded-md border border-border p-4 text-sm text-fg-muted" data-testid="paper-template-auth-off">请先启用账号系统并使用平台管理员登录，再管理论文模板。</p>
  return <section className="grid gap-4" data-testid="paper-templates-panel" aria-label="论文模板库">
    <div className="flex flex-wrap items-center gap-3">
      <div className="relative min-w-44 flex-1"><Search aria-hidden className="absolute left-2.5 top-2 size-4 text-fg-muted" /><Input aria-label="搜索模板" className="pl-8" placeholder="搜索名称或投稿目标…" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
      <label className="flex items-center gap-2 text-sm text-fg-muted"><input type="checkbox" checked={showRemoved} onChange={(e) => setShowRemoved(e.target.checked)} />显示已移除</label>
      <Button onClick={() => setAdding(true)}><Plus aria-hidden />添加模板</Button>
    </div>
    {error && <div role="alert" className="flex items-center gap-2 text-sm text-danger-fg">{error}<Button variant="outline" size="sm" onClick={() => void load()}>重试</Button></div>}
    {mobile ? (
      <ul className="grid gap-cards-m" data-testid="paper-templates-mobile" data-variant="mobile">
        {shown.map((t) => (
          <li key={`${t.format}-${t.id}`} className="grid gap-group-m rounded-md border border-border bg-panel p-card-m" data-testid={`pt-row-${t.format}-${t.id}`}>
            <div className="flex min-w-0 items-center gap-2">
              <TemplateThumb t={t} className="h-14 w-10" />
              <div className="min-w-0 grid gap-0.5">
                <span className="truncate font-medium text-fg-strong">{t.name}</span>
                <span className="text-xs text-fg-muted">{t.format === 'docx' ? 'Word' : 'LaTeX'} · {t.origin === 'builtin' ? '内置' : `上传 · 第 ${t.version ?? 1} 版`} · {t.enabled ? '可使用' : '已移除'}</span>
              </div>
              <Badge tone={t.verify === 'verified' ? 'ok' : 'warn'} className="ml-auto">{t.format === 'latex'
                ? (t.verify === 'verified' ? '已验证编译' : '编译待验证')
                : (t.verify === 'verified' ? (t.thumb ? '已生成预览' : '可使用') : '未生成预览')}</Badge>
            </div>
            <div className="flex flex-wrap gap-2 [&>button]:flex-1">
              {t.enabled && t.format === 'latex' && t.verify !== 'verified' && (
                <Button size="lg" variant="outline" disabled={verifying !== null} onClick={() => void verify(t)}>{verifying === `${t.format}-${t.id}` ? '验证中…' : '验证编译'}</Button>
              )}
              {t.enabled && t.format === 'docx' && t.verify !== 'verified' && (
                <Button size="lg" variant="outline" disabled={previewing !== null} onClick={() => void preview(t)}>{previewing === `${t.format}-${t.id}` ? '生成中…' : '生成预览'}</Button>
              )}
              <Button size="lg" variant="outline" onClick={() => setDetail(t)}>详情</Button>
              <Button size="lg" variant="outline" onClick={() => setEditing(t)}>编辑</Button>
              {t.enabled && t.origin === 'upload' && <Button size="lg" variant="outline" onClick={() => setReplacing(t)}>替换</Button>}
              {t.enabled ? <Button size="lg" variant="ghost" disabled={busy} onClick={() => setRemoving(t)}><Trash2 aria-hidden />移除</Button> : <Button size="lg" variant="outline" disabled={busy} onClick={() => void change(t, true)}><RotateCcw aria-hidden />恢复</Button>}
            </div>
          </li>
        ))}
      </ul>
    ) : (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-left text-sm" aria-label="论文模板列表"><thead className="bg-sunken text-xs text-fg-muted"><tr><th className="px-4 py-3 font-medium">名称</th><th className="px-4 py-3 font-medium">格式</th><th className="px-4 py-3 font-medium">来源 / 状态</th><th className="px-4 py-3 text-right font-medium">操作</th></tr></thead>
        <tbody className="divide-y divide-border">{shown.map((t) => <tr key={`${t.format}-${t.id}`} data-testid={`pt-row-${t.format}-${t.id}`}>
          <td className="max-w-md px-4 py-3"><div className="flex items-center gap-2 font-medium text-fg-strong"><TemplateThumb t={t} />{t.name}</div><p className="mt-1 text-xs text-fg-muted">{t.desc || t.venue || '—'}</p>{t.format === 'latex' && <p className="mt-1 break-all text-xs text-fg-muted">{t.engine} · {t.main}</p>}</td>
          <td className="whitespace-nowrap px-4 py-3">{t.format === 'docx' ? 'Word' : 'LaTeX'}</td><td className="whitespace-nowrap px-4 py-3 text-xs text-fg-muted">{t.origin === 'builtin' ? '内置' : `上传 · 第 ${t.version ?? 1} 版`}<br /><span className={t.enabled ? 'text-success-fg' : ''}>{t.enabled ? '可使用' : '已移除'}</span>{t.enabled && t.verify !== 'verified' && <span className="block">{t.format === 'latex' ? '编译待验证' : '未生成预览'}</span>}{t.enabled && t.verify !== 'verified' && t.verify_error && <span className="mt-0.5 block max-w-52 whitespace-normal text-danger-fg" data-testid={`pt-verify-error-${t.format}-${t.id}`}>{t.verify_error}</span>}</td>
          <td className="px-4 py-3 text-right"><div className="flex items-center justify-end gap-1">
            {t.enabled && t.format === 'latex' && t.verify !== 'verified' && (
              <Button size="sm" variant="outline" aria-label={`验证编译 ${t.name}`} disabled={verifying !== null} onClick={() => void verify(t)} data-testid={`pt-verify-${t.format}-${t.id}`}>
                {verifying === `${t.format}-${t.id}` ? '验证中…' : '验证编译'}
              </Button>
            )}
            {t.enabled && t.format === 'docx' && t.verify !== 'verified' && (
              <Button size="sm" variant="outline" aria-label={`生成预览 ${t.name}`} disabled={previewing !== null} onClick={() => void preview(t)} data-testid={`pt-preview-${t.format}-${t.id}`}>
                {previewing === `${t.format}-${t.id}` ? '生成中…' : '生成预览'}
              </Button>
            )}
            {t.enabled && <Button size="sm" variant="ghost" aria-label={`详情 ${t.name}`} onClick={() => setDetail(t)} data-testid={`pt-detail-${t.format}-${t.id}`}><Eye aria-hidden />详情</Button>}
            {t.enabled && <Button size="sm" variant="ghost" aria-label={`编辑 ${t.name}`} onClick={() => setEditing(t)} data-testid={`pt-edit-${t.format}-${t.id}`}><Pencil aria-hidden />编辑</Button>}
            {t.enabled && t.origin === 'upload' && <Button size="sm" variant="ghost" aria-label={`替换版本 ${t.name}`} onClick={() => setReplacing(t)} data-testid={`pt-replace-${t.format}-${t.id}`}><Upload aria-hidden />替换</Button>}
            {t.enabled ? <Button size="sm" variant="ghost" aria-label={`移除 ${t.name}`} disabled={busy} onClick={() => setRemoving(t)}><Trash2 aria-hidden />移除</Button> : <Button size="sm" variant="outline" aria-label={`恢复 ${t.name}`} disabled={busy} onClick={() => void change(t, true)}><RotateCcw aria-hidden />恢复</Button>}
          </div></td>
        </tr>)}</tbody></table>
      {!shown.length && <p className="p-8 text-center text-sm text-fg-muted" role="status">{loading ? '正在加载模板…' : q ? '没有符合条件的模板' : '还没有模板，点击「添加模板」开始。'}</p>}
    </div>
    )}
    <p className="text-xs text-fg-muted">{items.filter((t) => t.enabled).length} 个可用模板 · 移除只影响新建入口，已创建的项目保留完整内容。</p>
    {adding && <UploadTemplate onClose={() => setAdding(false)} onAdded={load} />}
    {editing && <EditTemplate t={editing} onClose={() => setEditing(null)} onSaved={mergeRow} />}
    {replacing && <ReplaceTemplate t={replacing} onClose={() => setReplacing(null)} onSaved={mergeRow} />}
    {detailRow && <DetailDialog t={detailRow} onClose={() => setDetail(null)} onPreview={(t) => t.format === 'latex' ? void verify(t) : void preview(t)} />}
    <Dialog open={!!removing} onOpenChange={(v) => { if (!v && !busy) setRemoving(null) }}><DialogContent>
      <DialogHeader><DialogTitle>移除模板「{removing?.name}」？</DialogTitle><DialogDescription>成员将无法再使用此模板新建项目。已有项目不受影响；你可以在“显示已移除”中恢复。</DialogDescription></DialogHeader>
      {error && <p role="alert" className="text-sm text-danger-fg">{error}</p>}
      <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setRemoving(null)}>取消</Button><Button disabled={busy} onClick={() => { if (removing) void change(removing, false) }}>{busy ? '移除中…' : '确认移除'}</Button></DialogFooter>
    </DialogContent></Dialog>
  </section>
}

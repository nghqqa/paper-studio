import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Loader2, Plus, Trash2, Download, Copy, FileText, PencilLine, SendToBack } from 'lucide-react'
import { figuresApi, type FigurePalette, type ProjectFigure } from '@/lib/api/projectFigures'
import { req } from '@/lib/api/net'
import { extractNumericValue, parseDelimitedTable } from '@/lib/latexTable'
import type { ProjectSummary } from '@/lib/types'
import { useStudio } from '@/store'
import { PublishLatexDialog } from './PublishLatexDialog'

/** 方法图编辑器整包 lazy——@excalidraw/* 重资产只随本 chunk 在打开编辑器时下载（不进工作台首包）。 */
const DiagramEditor = lazy(() => import('./DiagramEditor').then((m) => ({ default: m.DiagramEditor })))

const initialData = '{"categories":["基线","本文"],"series":[{"name":"精度","values":[0.82,0.91]}]}'
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

/** 项目图表库；项目切换时重建局部状态，权限跟随选定项目。 */
export function ScientificFigures({ pid: initialPid }: { pid?: string }) {
  const allProjects = useStudio((s) => s.projects)
  const authStatus = useStudio((s) => s.authStatus)
  const superuser = useStudio((s) => s.user?.is_superuser ?? false)
  const projects = allProjects.filter((p) => (p.list_state ?? 'active') === 'active')
  const [pid, setPid] = useState(initialPid ?? '')
  useEffect(() => setPid(initialPid ?? ''), [initialPid])
  const project = projects.find((p) => p.id === pid)
  const canEdit = !!project && (authStatus === 'off' || (authStatus === 'authed'
    && (superuser || ['owner', 'agent', 'editor'].includes(project.my_role ?? ''))))

  return <ProjectFigures key={project?.id ?? ''} pid={pid} project={project} projects={projects} canEdit={canEdit} onSelect={setPid} />
}

function ProjectFigures({ pid, project, projects, canEdit, onSelect }: {
  pid: string
  project?: ProjectSummary
  projects: ProjectSummary[]
  canEdit: boolean
  onSelect: (pid: string) => void
}) {
  const [figures, setFigures] = useState<ProjectFigure[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [type, setType] = useState('line')
  const [palette, setPalette] = useState<FigurePalette>('academic')
  const [title, setTitle] = useState('')
  const [xLabel, setXLabel] = useState('')
  const [yLabel, setYLabel] = useState('')
  const [dataJson, setDataJson] = useState(initialData)
  const [csvImportOpen, setCsvImportOpen] = useState(false)
  const [csvText, setCsvText] = useState('')
  const [preview, setPreview] = useState<{ key: string; url: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [notice, setNotice] = useState('')
  // 方法图编辑器：undefined=关闭，null=新建，ProjectFigure=编辑既有图。
  const [editorFig, setEditorFig] = useState<ProjectFigure | null | undefined>(undefined)
  const [publishFig, setPublishFig] = useState<ProjectFigure | null>(null)
  const alive = useRef(false)
  const formKey = JSON.stringify([name, type, palette, title, xLabel, yLabel, dataJson])
  const previewUrl = preview?.key === formKey ? preview.url : ''
  const available = !!project

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  useEffect(() => {
    if (!available) return
    let current = true
    setFigures([])
    setLoading(true)
    setLoadError('')
    figuresApi.list(pid).then((r) => {
      if (current) setFigures(r.figures)
    }).catch((error: unknown) => {
      if (current) setLoadError(errorText(error))
    }).finally(() => {
      if (current) setLoading(false)
    })
    return () => { current = false }
  }, [pid, available, loadAttempt])

  function chartData() {
    const parsed = JSON.parse(dataJson)
    return { type, palette, title, x_label: xLabel, y_label: yLabel, categories: parsed.categories, series: parsed.series }
  }

  function applyCsvToJson() {
    const { headers, rows } = parseDelimitedTable(csvText)
    if (headers.length < 2 || rows.length === 0) {
      setErr('请至少粘贴表头与一行两列数据（首列为横轴类别，其余列为数值系列）')
      return
    }
    const categories = rows.map((r, i) => r[0] || `项${i + 1}`)
    const series = headers.slice(1).map((sname, sIdx) => ({
      name: sname || `系列${sIdx + 1}`,
      values: rows.map((r) => extractNumericValue(r[sIdx + 1] ?? '') ?? 0),
    }))
    setErr('')
    if (!xLabel && headers[0]) setXLabel(headers[0])
    setDataJson(JSON.stringify({ categories, series }))
    setCsvImportOpen(false)
    setNotice('已将 CSV/TSV 转换为图表数据，点击「预览」查看效果')
  }

  async function renderPreview() {
    if (!canEdit || busy) return
    setBusy(true); setErr(''); setNotice(''); setPreview(null)
    try {
      const response = await req<{ data_url: string }>('/api/charts/render', {
        method: 'POST', body: JSON.stringify(chartData()),
      })
      if (alive.current) setPreview({ key: formKey, url: response.data_url })
    } catch (error) { if (alive.current) setErr(errorText(error)) }
    finally { if (alive.current) setBusy(false) }
  }

  async function save() {
    if (!canEdit || busy || !previewUrl) return
    setBusy(true); setErr(''); setNotice('')
    try {
      // pid 属于本次挂载；切换项目后，旧请求仍只写入发起时的项目。
      const r = await figuresApi.create(pid, { name: name || '未命名图表', ...chartData() })
      if (!alive.current) return
      setFigures((f) => [...f, r.figure])
      setShowForm(false); setName(''); setPreview(null)
      setNotice('图表已保存到当前项目')
    } catch (error) { if (alive.current) setErr(errorText(error)) }
    finally { if (alive.current) setBusy(false) }
  }

  async function remove(fid: string) {
    if (!canEdit || busy) return
    if (!confirm('确认删除该图表？')) return
    setBusy(true); setErr(''); setNotice('')
    try {
      await figuresApi.remove(pid, fid)
      if (alive.current) setFigures((f) => f.filter((x) => x.id !== fid))
    } catch (error) { if (alive.current) setErr(errorText(error)) }
    finally { if (alive.current) setBusy(false) }
  }

  async function copyLatex(fid: string) {
    const fig = figures.find((x) => x.id === fid)
    if (!fig) return
    const code = `\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=0.85\\linewidth]{figures/${fid}.png}\n  \\caption{${fig.title || fig.name}}\n  \\label{fig:${fid}}\n\\end{figure}`
    setErr(''); setNotice('')
    try {
      await navigator.clipboard.writeText(code)
      if (alive.current) setNotice('已复制 LaTeX 引用')
    } catch { if (alive.current) setErr('无法复制，请允许浏览器访问剪贴板后重试') }
  }

  return (
    <div data-testid="scientific-figures">
      <div className="paper-figures-bar">
        <label htmlFor="figures-project">论文项目</label>
        <select id="figures-project" value={project ? pid : ''} onChange={(e) => onSelect(e.target.value)}
          className="paper-figures-select" data-testid="figures-project-select">
          <option value="">选择项目…</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.title || p.id}</option>)}
        </select>
        {canEdit && !loading && !loadError && (
          <>
            <button type="button" className="paper-primary" onClick={() => setShowForm((v) => !v)} disabled={busy} data-testid="figures-new">
              <Plus aria-hidden /> {showForm ? '收起表单' : '新建图表'}
            </button>
            <button type="button" className="paper-primary" onClick={() => setEditorFig(null)} disabled={busy} data-testid="figures-new-diagram">
              <PencilLine aria-hidden /> 新建方法图
            </button>
          </>
        )}
      </div>
      {err && <p className="paper-figures-error" role="alert">{err}</p>}
      {notice && <p role="status">{notice}</p>}
      {project?.source_format === 'docx' && <p>在 Word 项目中打开「插件 → LaTeX公式 → 科研图表」，可从本项目图表库插入。</p>}

      {!project ? (
        <div className="paper-figures-empty" data-testid="figures-no-project">
          <FileText aria-hidden />
          <strong>选择一个论文项目</strong>
          <p>{pid ? '该项目不在可用列表中，请选择一个使用中的项目。' : '选定项目后可创建和管理科研图表，并插入到该项目的论文中。'}</p>
        </div>
      ) : loading ? (
        <p role="status"><Loader2 className="paper-figures-loading" aria-hidden />正在加载图表…</p>
      ) : loadError ? (
        <div className="paper-figures-error" role="alert">
          <p>图表加载失败：{loadError}</p>
          <button type="button" className="paper-secondary" onClick={() => setLoadAttempt((value) => value + 1)}>重试加载</button>
        </div>
      ) : (
        <>
          {showForm && canEdit && (
            <form className="paper-figures-form" data-testid="figures-form" onSubmit={(e) => { e.preventDefault(); void save() }}>
              <div className="paper-figures-row">
                <div><label htmlFor="fig-name">图表名称</label><input id="fig-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：两组方法精度对比" /></div>
                <div><label htmlFor="fig-type">类型</label>
                  <select id="fig-type" value={type} onChange={(e) => setType(e.target.value)}>
                    <option value="line">折线图</option><option value="bar">柱状图</option>
                    <option value="scatter">散点图</option><option value="pie">饼图</option>
                  </select>
                </div>
                <div><label htmlFor="fig-palette">配色风格</label>
                  <select id="fig-palette" value={palette} onChange={(e) => setPalette(e.target.value as FigurePalette)} data-testid="fig-palette">
                    <option value="academic">学术期刊</option>
                    <option value="colorblind">色盲友好 (Okabe-Ito)</option>
                    <option value="grayscale">黑白印刷 (含线型区分)</option>
                    <option value="default">经典默认</option>
                  </select>
                </div>
              </div>
              <div><label htmlFor="fig-title">标题（可选，显示在图表上方）</label><input id="fig-title" value={title} onChange={(e) => setTitle(e.target.value)} /></div>
              <div className="paper-figures-row">
                <div><label htmlFor="fig-x">X 轴说明</label><input id="fig-x" value={xLabel} onChange={(e) => setXLabel(e.target.value)} /></div>
                <div><label htmlFor="fig-y">Y 轴说明</label><input id="fig-y" value={yLabel} onChange={(e) => setYLabel(e.target.value)} /></div>
              </div>
              <div>
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor="fig-data">数据 JSON（categories 为横轴取值，series 每项一条曲线）</label>
                  <button
                    type="button"
                    className="text-xs text-link hover:underline"
                    onClick={() => setCsvImportOpen((v) => !v)}
                    data-testid="fig-csv-toggle"
                  >
                    {csvImportOpen ? '收起 CSV 导入' : '从 CSV/TSV 粘贴数据'}
                  </button>
                </div>
                {csvImportOpen && (
                  <div className="my-2 grid gap-1.5 rounded border border-border bg-app p-2">
                    <textarea
                      rows={3}
                      value={csvText}
                      onChange={(e) => setCsvText(e.target.value)}
                      placeholder={'模型\tAcc\tF1\nBaseline\t84.2\t82.9\nOurs\t91.4\t90.8'}
                      aria-label="粘贴 CSV 或 TSV 表格数据"
                      data-testid="fig-csv-input"
                      className="paper-figures-json"
                    />
                    <div>
                      <button type="button" className="paper-secondary" onClick={applyCsvToJson} data-testid="fig-csv-apply">
                        转为图表 JSON
                      </button>
                    </div>
                  </div>
                )}
                <textarea id="fig-data" rows={4} value={dataJson} onChange={(e) => setDataJson(e.target.value)} className="paper-figures-json" />
              </div>
              <div className="paper-figures-form-actions">
                <button type="button" className="paper-secondary" onClick={renderPreview} disabled={busy}>预览</button>
                <button type="submit" className="paper-primary" disabled={busy || previewUrl === ''}>保存</button>
                {busy && <Loader2 className="paper-figures-loading-inline" aria-hidden />}
              </div>
              {previewUrl && <img src={previewUrl} alt="预览" className="paper-figures-preview" />}
            </form>
          )}

          {figures.length === 0 ? (
            <div className="paper-figures-empty" data-testid="figures-empty">
              <FileText aria-hidden />
              <strong>暂无图表</strong>
              <p>{canEdit ? '点击「新建图表」创建第一幅。' : '此项目还没有科研图表。'}</p>
            </div>
          ) : (
            <div className="paper-figures-grid" data-testid="figures-grid">
              {figures.map((f) => (
                <figure key={f.id} className="paper-figures-card" data-testid="figure-card">
                  <img src={figuresApi.pngUrl(pid, f.id, f.kind === 'diagram' ? f.version : undefined)} alt={f.name} loading="lazy" />
                  <strong title={f.name}>{f.name}</strong>
                  <span className="paper-figures-meta">
                    {f.kind === 'diagram'
                      ? `方法图 · v${f.version} · ${new Date((f.updated_at ?? f.created_at) * 1000).toLocaleDateString('zh-CN')}`
                      : `${f.type} · ${new Date(f.created_at * 1000).toLocaleDateString('zh-CN')}`}
                  </span>
                  <figcaption className="paper-figures-actions">
                    {f.kind === 'diagram' && canEdit && (
                      <button type="button" title="编辑方法图" aria-label={`编辑 ${f.name}`} onClick={() => setEditorFig(f)}><PencilLine aria-hidden /></button>
                    )}
                    <a href={figuresApi.pngUrl(pid, f.id, f.kind === 'diagram' ? f.version : undefined)} download={`${f.name}.png`} title="下载 PNG" aria-label={`下载 ${f.name}`}><Download aria-hidden /></a>
                    {f.kind !== 'diagram' && (
                      <>
                        <a href={figuresApi.exportUrl(pid, f.id, 'png', 300)} download={`${f.name}-300dpi.png`} title="下载 300 DPI 投稿高清 PNG" data-testid="figure-export-300" className="paper-figures-export-chip font-mono">300dpi</a>
                        <a href={figuresApi.exportUrl(pid, f.id, 'png', 600)} download={`${f.name}-600dpi.png`} title="下载 600 DPI 印刷超清 PNG" data-testid="figure-export-600" className="paper-figures-export-chip font-mono">600dpi</a>
                        <a href={figuresApi.exportUrl(pid, f.id, 'pdf', 300)} download={`${f.name}.pdf`} title="下载矢量 PDF" data-testid="figure-export-pdf" className="paper-figures-export-chip font-mono">PDF</a>
                        <a href={figuresApi.exportUrl(pid, f.id, 'svg', 300)} download={`${f.name}.svg`} title="下载矢量 SVG" data-testid="figure-export-svg" className="paper-figures-export-chip font-mono">SVG</a>
                      </>
                    )}
                    <button type="button" title="复制 LaTeX 引用" aria-label={`复制 ${f.name} 的 LaTeX 引用`} onClick={() => void copyLatex(f.id)}><Copy aria-hidden /></button>
                    {canEdit && project?.source_format === 'latex' && (
                      <button type="button" title="发布到 LaTeX" aria-label={`发布 ${f.name} 到 LaTeX`} onClick={() => setPublishFig(f)}><SendToBack aria-hidden /></button>
                    )}
                    {canEdit && (
                      <button type="button" title="删除" aria-label={`删除 ${f.name}`} disabled={busy} onClick={() => void remove(f.id)}><Trash2 aria-hidden /></button>
                    )}
                  </figcaption>
                </figure>
              ))}
            </div>
          )}
        </>
      )}
      {editorFig !== undefined && (
        <Suspense fallback={<p role="status"><Loader2 className="paper-figures-loading" aria-hidden />正在加载编辑器…</p>}>
          <DiagramEditor pid={pid} figure={editorFig} onClose={() => setEditorFig(undefined)}
            onSaved={(fig) => {
              setFigures((list) => list.some((x) => x.id === fig.id) ? list.map((x) => x.id === fig.id ? fig : x) : [...list, fig])
              setEditorFig(undefined)
              setNotice('方法图已保存')
            }} />
        </Suspense>
      )}
      {publishFig && (
        <PublishLatexDialog pid={pid} figure={publishFig} onClose={() => setPublishFig(null)}
          onPublished={() => setNotice('已发布到 LaTeX 工程 figures/ 目录')} />
      )}
    </div>
  )
}

import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { latexApi } from '@/lib/api/latex'

/**
 * 受限工程导入对话框（ZIP / Word 双模式，v0.6.8）：
 * - ZIP：上传校验 → 文件/候选主文件预览 → 选主文件与引擎 → 创建并跳工作台；
 *   拒绝原因（穿越/符号链接/嵌套归档/内部路径/超限）逐条展示，不静默删减。
 * - Word(.docx)：pandoc 转换语义（样式/编号不保留），CJK 自动建议 ctexart+xelatex；
 *   产物单 main.tex + media/ 图片目录；转换后用工作台编译与诊断修正。
 */
export function ImportDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (pid: string) => void
}) {
  const [mode, setMode] = useState<'zip' | 'docx'>('zip')
  const [file, setFile] = useState<File | null>(null)
  const [staging, setStaging] = useState(false)
  const [staged, setStaged] = useState<{
    token: string
    files: { path: string; size: number }[]
    main_candidates: string[]
    excluded: { path: string; reason: string }[]
    skipped: string[]
    warnings?: string[]
    engine?: string
    cjk?: boolean
  } | null>(null)
  const [main, setMain] = useState('')
  const [engine, setEngine] = useState<'pdflatex' | 'xelatex'>('xelatex')
  const [title, setTitle] = useState('')
  const [err, setErr] = useState('')
  const [creating, setCreating] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  if (!open) return null

  const reset = () => {
    setFile(null)
    setStaged(null)
    setMain('')
    setTitle('')
    setErr('')
    if (inputRef.current) inputRef.current.value = ''
  }

  const doUpload = async () => {
    if (!file || staging) return
    setStaging(true)
    setErr('')
    try {
      if (mode === 'docx') {
        const m = await latexApi.importDocxUpload(file)
        setStaged(m)
        setMain('main.tex')
        setEngine(m.cjk ? 'xelatex' : 'pdflatex')
        setTitle('')
      } else {
        const m = await latexApi.importUpload(file)
        setStaged(m)
        if (m.main_candidates.length === 1) setMain(m.main_candidates[0])
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : '上传失败')
    } finally {
      setStaging(false)
    }
  }

  const doCreate = async () => {
    if (!staged || creating) return
    if (mode === 'zip' && !main) return
    setCreating(true)
    setErr('')
    try {
      const m = mode === 'docx'
        ? await latexApi.importDocxCreate(staged.token, engine, title)
        : await latexApi.importCreate(staged.token, main, engine, title)
      onOpenChange(false)
      reset()
      onCreated(m.id)
    } catch (e) {
      setErr(e instanceof Error ? e.message : '创建失败')
    } finally {
      setCreating(false)
    }
  }

  const switchMode = (m: 'zip' | 'docx') => {
    setMode(m)
    reset()
  }

  return (
    <div
      role="dialog"
      aria-label={mode === 'docx' ? '导入 Word 论文' : '导入 LaTeX 工程（ZIP）'}
      data-testid="import-dialog"
      className="fixed inset-0 z-popover grid place-items-center bg-black/50 px-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onOpenChange(false)
      }}
    >
      <div className="w-full max-w-lg rounded-xl bg-panel p-6 shadow-md">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold text-fg-strong">
            {mode === 'docx' ? '导入 Word 论文' : '导入 LaTeX 工程（ZIP）'}
          </h2>
          <span className="ml-auto flex gap-1" role="tablist" aria-label="导入类型">
            {(['zip', 'docx'] as const).map((m) => (
              <button
                key={m}
                type="button" role="tab" aria-selected={mode === m}
                className={'rounded px-2 py-0.5 text-xs ' + (mode === m ? 'bg-primary-soft font-medium text-primary' : 'text-fg-muted hover:bg-hover')}
                onClick={() => switchMode(m)}
                data-testid={`import-mode-${m}`}
              >
                {m === 'zip' ? 'ZIP 工程' : 'Word 文档'}
              </button>
            ))}
          </span>
        </div>

        {mode === 'zip' ? (
          <p className="mt-1 text-xs text-fg-muted">
            上传 .zip（≤50MB，解压 ≤200MB / ≤500 文件）。不执行脚本、不联网装包；
            缺宏包或语法错误可在工作台诊断。含 .documentclass 的 .tex 为主文件候选；多个候选时请选择。
          </p>
        ) : (
          <p className="mt-1 text-xs text-fg-muted">
            上传 .docx（≤25MB），pandoc 转换为 LaTeX：公式与正文转为 LaTeX 语义，样式/页眉页脚/自动编号不保留；
            转换后请在工作台编译并按诊断修正。中文论文自动使用 ctexart + xelatex。
          </p>
        )}

        {!staged ? (
          <div className="mt-4 space-y-3">
            <input
              ref={inputRef}
              type="file"
              accept={mode === 'docx' ? '.docx' : '.zip'}
              data-testid="import-file"
              className="w-full rounded-md border border-border bg-app px-3 py-2 text-sm"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            {err && <p className="text-sm text-danger" data-testid="import-err">{err}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
              <Button onClick={doUpload} disabled={!file || staging} data-testid="import-upload">
                {staging ? (mode === 'docx' ? '转换中…' : '上传校验中…') : (mode === 'docx' ? '上传并转换' : '上传并预览')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            <div className="max-h-40 overflow-auto rounded-md border border-border p-2 text-xs" data-testid="import-files">
              {staged.files.map((f) => (
                <div key={f.path} className="flex justify-between gap-2 py-0.5">
                  <span className="truncate font-mono">{f.path}</span>
                  <span className="shrink-0 text-fg-muted">{(f.size / 1024).toFixed(1)}KB</span>
                </div>
              ))}
            </div>
            {staged.skipped.length > 0 && (
              <p className="text-xs text-fg-muted">已跳过系统垃圾文件：{staged.skipped.join('、')}</p>
            )}
            {staged.warnings && staged.warnings.length > 0 && (
              <ul className="text-xs text-warning">
                {staged.warnings.map((w, i) => (
                  <li key={i}>· {w}</li>
                ))}
              </ul>
            )}
            {staged.excluded.length > 0 && (
              <ul className="text-xs text-warning">
                {staged.excluded.map((x, i) => (
                  <li key={i}>· {x.path}：{x.reason}</li>
                ))}
              </ul>
            )}
            {mode === 'zip' && (
              <label className="block text-sm">
                主文件
                <select
                  className="mt-1 w-full rounded-md border border-border bg-app px-2 py-1.5"
                  value={main}
                  onChange={(e) => setMain(e.target.value)}
                  data-testid="import-main"
                >
                  {!main && (
                    <option value="" disabled>
                      请选择主文件（多个候选时人工确认）
                    </option>
                  )}
                  {staged.main_candidates.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </label>
            )}
            <label className="block text-sm">
              编译引擎{mode === 'docx' && staged.cjk ? '（已按中文检测推荐 xelatex）' : ''}
              <select
                className="mt-1 w-full rounded-md border border-border bg-app px-2 py-1.5"
                value={engine}
                onChange={(e) => setEngine(e.target.value as 'pdflatex' | 'xelatex')}
                data-testid="import-engine"
              >
                <option value="pdflatex">pdflatex</option>
                <option value="xelatex">xelatex（中文推荐）</option>
              </select>
            </label>
            <label className="block text-sm">
              项目名称（可选）
              <input
                className="mt-1 w-full rounded-md border border-border bg-app px-2 py-1.5"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={mode === 'docx' ? '导入的 Word 论文' : '导入的 LaTeX 工程'}
                data-testid="import-title"
              />
            </label>
            {err && <p className="text-sm text-danger" data-testid="import-err">{err}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => { reset(); onOpenChange(false) }}>取消</Button>
              <Button onClick={doCreate} disabled={(mode === 'zip' && !main) || creating} data-testid="import-create">
                {creating ? '创建中…' : '创建项目'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}


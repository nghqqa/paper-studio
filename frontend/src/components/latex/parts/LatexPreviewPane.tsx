import { lazy, Suspense, useState } from 'react'
import { FileDown, Package, RefreshCw } from 'lucide-react'
import type { SyncTexTarget } from '@/components/pdf/LatexPdfViewer'
import { SubmissionExportDialog } from '../SubmissionExportDialog'
import {
  latexApi,
  type LatexBuildInfo,
  type LatexBuildOutcome,
  type LatexDiagnostic,
  type WordExportManifest,
  type WordExportProfile,
} from '@/lib/api/latex'
import { cn } from '@/lib/utils'
import { shortId } from '../hooks/useLatexSession'

// pdf.js 体积大且依赖 DOMMatrix：随预览栏 lazy 加载，避免拉进测试环境
const LatexPdfViewer = lazy(() => import('@/components/pdf/LatexPdfViewer'))

export function LatexPreviewPane({
  pid,
  title,
  engine,
  building,
  dirty,
  outcome,
  latest,
  builds,
  previewState,
  pdfUrl,
  pdfDownloadUrl,
  previewScroll,
  diagList,
  active,
  wordProfile,
  wordExporting,
  wordResult,
  wordExportErr,
  wordHistory,
  onSelectWordProfile,
  onRunWordExport,
  onCloseWordResult,
  onJumpDiag,
  onInverseSync,
}: {
  pid: string
  title: string
  engine: string
  building: boolean
  dirty: boolean
  outcome: LatexBuildOutcome | null
  latest: LatexBuildInfo | undefined
  builds: LatexBuildInfo[]
  previewState: string
  pdfUrl: string | null
  pdfDownloadUrl: string | null
  previewScroll: SyncTexTarget | null
  diagList: LatexDiagnostic[]
  active: string | null
  wordProfile: WordExportProfile
  wordExporting: boolean
  wordResult: WordExportManifest | null
  wordExportErr: string
  wordHistory: WordExportManifest[]
  onSelectWordProfile: (p: WordExportProfile) => void
  onRunWordExport: () => void
  onCloseWordResult: () => void
  onJumpDiag: (file: string, line: number | null) => void
  onInverseSync: (info: { page: number; xPt: number; yPt: number }) => void
}) {
  const [submissionOpen, setSubmissionOpen] = useState(false)
  return (
    <section aria-label="编译与预览" className="flex h-full min-h-0 min-w-0 flex-col" data-testid="latex-preview">
      <div
        className="flex min-h-8 shrink-0 flex-wrap items-center gap-2 border-b border-line px-2 py-1 text-xs"
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
            <div className="ml-auto flex flex-wrap items-center gap-1">
              {pdfDownloadUrl && (
                <a
                  href={pdfDownloadUrl}
                  download={`${title || pid}.pdf`}
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-fg-muted hover:bg-hover hover:text-fg"
                  title="下载当前预览 PDF"
                  data-testid="latex-download-pdf"
                >
                  <FileDown aria-hidden className="size-3.5" />
                  下载 PDF
                </a>
              )}
              <select
                aria-label="Word 导出版式"
                value={wordProfile}
                onChange={(e) => onSelectWordProfile(e.target.value as WordExportProfile)}
                disabled={wordExporting}
                className="rounded border border-line bg-surface px-1.5 py-0.5 text-xs text-fg-muted hover:text-fg focus:outline-none"
                title="选择 Word 导出版式"
                data-testid="latex-word-profile"
              >
                <option value="academic">标准单栏</option>
                <option value="thesis">学位论文（大论文）</option>
                <option value="jcip">中文信息学报（双栏）</option>
              </select>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-fg-muted hover:bg-hover hover:text-fg disabled:opacity-50"
                onClick={onRunWordExport}
                disabled={wordExporting || dirty}
                title={
                  dirty
                    ? '请先保存（自动保存进行中或手动 Ctrl+S）后再导出'
                    : '导出 Word（自动中英文排版、公式居中编号靠右、图表编号与 GB/T 7714 参考文献）'
                }
                data-testid="latex-export-word"
              >
                <FileDown aria-hidden className="size-3.5" />
                {wordExporting ? '导出中…' : '导出 Word'}
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-fg-muted hover:bg-hover hover:text-fg"
                onClick={() => setSubmissionOpen(true)}
                title="生成干净投稿 ZIP（自动去注释、附带 .bbl 并裁剪未引用图片）"
                data-testid="latex-submission-export-btn"
              >
                <Package aria-hidden className="size-3.5" />
                投稿打包
              </button>
            </div>
          </>
        )}
      </div>

      {submissionOpen && (
        <SubmissionExportDialog pid={pid} open={submissionOpen} onOpenChange={setSubmissionOpen} />
      )}

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
              Word 导出（
              {wordResult.profile_display ||
                (wordResult.profile === 'jcip'
                  ? '中文信息学报双栏'
                  : wordResult.profile === 'thesis'
                    ? '学位论文（按章编号）'
                    : '标准学术单栏')}
              ）· {wordResult.status === 'pass' ? '完成' : wordResult.status === 'degraded' ? '完成（有提示）' : '已阻断'}
            </span>
            {wordResult.artifacts?.['paper.docx'] && (
              <a
                className="font-medium text-accent underline hover:no-underline"
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
            <button
              type="button"
              onClick={onCloseWordResult}
              className="rounded px-1 text-fg-muted hover:bg-hover hover:text-fg"
              aria-label="关闭导出结果"
            >
              ×
            </button>
          </div>
          {wordResult.degrades.length > 0 && (
            <ul className="mt-0.5 space-y-0.5 text-warning">
              {wordResult.degrades.map((d, i) => (
                <li key={i}>· {d}</li>
              ))}
            </ul>
          )}
          <div className="mt-1 border-t border-line pt-1 leading-5 text-fg-muted" data-testid="latex-word-scope">
            已按
            {wordResult.profile === 'jcip'
              ? '中文信息学报双栏'
              : wordResult.profile === 'thesis'
                ? '学位论文（按章编号）'
                : '标准学术单栏'}
            版式生成 Word（含 OMML 公式居中/编号右对齐、三线表与参考文献）， 建议在 Word 中快速核对复杂自定义宏或跨栏浮动体。
          </div>
          {wordHistory.length > 0 && (
            <div className="mt-1 text-fg-muted" data-testid="latex-word-history">
              最近导出：
              <ul className="mt-0.5 space-y-0.5">
                {wordHistory.map((h) => (
                  <li key={h.export_id} className="flex items-center gap-2">
                    <span className="font-mono text-2xs">{h.export_id}</span>
                    {h.profile_display && <span>{h.profile_display}</span>}
                    {h.stale && <span className="text-warning">（旧内容）</span>}
                    {h.artifacts?.['paper.docx'] && !h.stale && (
                      <a className="underline hover:no-underline" href={latexApi.wordArtifactUrl(pid, h.export_id, 'paper.docx')} download>
                        下载
                      </a>
                    )}
                    {h.status !== 'pass' && <span className="text-warning">{h.status === 'degraded' ? '有提示' : '已阻断'}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {diagList.length > 0 && (
        <div className="max-h-36 shrink-0 overflow-auto border-b border-line px-2 py-1" data-testid="latex-diagnostics">
          <div className="mb-1 text-xs font-medium text-danger">诊断（{diagList.length}）</div>
          <ul className="space-y-0.5">
            {diagList.map((d, i) => {
              const targetFile = d.file.replace(/^\.\//, '')
              return (
                <li key={i}>
                  <button
                    className="w-full truncate text-left text-xs text-danger hover:underline"
                    onClick={() => onJumpDiag(targetFile, d.line ?? null)}
                    title={targetFile !== active ? `切换到 ${targetFile} 并跳转` : '点击跳到源码行'}
                  >
                    {d.file}
                    {d.line != null ? `:${d.line}` : ''} — {d.message}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {pdfUrl ? (
          <Suspense fallback={<div className="p-3 text-xs text-fg-muted">加载 PDF…</div>}>
            <LatexPdfViewer
              url={pdfUrl}
              downloadUrl={pdfDownloadUrl}
              downloadFilename={`${title || pid}.pdf`}
              jumpTarget={previewScroll}
              onInverseSync={onInverseSync}
              building={building}
              stale={previewState === 'stale' || previewState === 'old-ok' || previewState === '旧配置'}
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
}

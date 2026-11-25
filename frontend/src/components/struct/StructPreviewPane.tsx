import { lazy, Suspense } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * 投稿版预览面板（v0.1.5）：右栏展示与导出**同一转换链**产出的 PDF。
 * 数据流：停顿自动保存成功 → POST /struct/preview（服务端按 content sha 缓存、同案单任务）
 * → 面板按 sha 对齐显示；内容再变化时以「预览过期」提示，不把旧 SHA 冒充当前版本。
 */
const Pdf = lazy(() => import('@/components/pdf/SimplePdfView'))

export interface PreviewState {
  phase: 'idle' | 'queued' | 'running' | 'done' | 'error'
  sha?: string
  vid?: string
  pdfUrl?: string
  durationMs?: number
  cached?: boolean
  error?: string
}

const PHASE_LABEL: Record<PreviewState['phase'], string> = {
  idle: '待生成',
  queued: '排队中…',
  running: '生成中…',
  done: '已完成',
  error: '失败',
}

export function StructPreviewPane({ state, currentSha, canEdit, onRetry }: {
  state: PreviewState
  currentSha: string
  canEdit: boolean
  onRetry: () => void
}) {
  const stale = state.phase === 'done' && !!state.sha && !!currentSha && state.sha !== currentSha
  return (
    <aside
      className="w-full shrink-0 rounded-md border border-border bg-panel lg:sticky lg:top-14 lg:w-[44%] lg:max-w-[620px]"
      aria-label="投稿版预览"
      data-testid="struct-preview"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <h2 className="text-xs font-semibold text-fg-muted">投稿版预览</h2>
        <span
          className={cn(
            'rounded-xs px-1.5 py-0.5 text-2xs',
            state.phase === 'done' ? 'bg-hover text-fg-muted'
              : state.phase === 'error' ? 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300'
                : 'bg-hover text-fg-muted',
          )}
          data-testid="struct-preview-phase"
        >
          {PHASE_LABEL[state.phase]}
          {state.phase === 'done' && state.cached ? '（缓存命中）' : ''}
        </span>
        {state.phase === 'running' && <Loader2 aria-hidden className="size-3.5 animate-spin text-fg-muted" />}
        {state.phase === 'done' && !stale && (
          <Button variant="ghost" size="icon-sm" aria-label="重新生成预览" title="重新生成预览" disabled={!canEdit} onClick={onRetry} data-testid="struct-preview-retry">
            <RefreshCw aria-hidden />
          </Button>
        )}
        <span className="ml-auto text-2xs text-fg-muted" data-testid="struct-preview-meta">
          {state.phase === 'done' && state.sha
            ? <>SHA {state.sha.slice(0, 8)} · {state.vid}{state.durationMs ? ` · ${(state.durationMs / 1000).toFixed(1)}s` : ''}</>
            : currentSha ? <>当前内容 SHA {currentSha.slice(0, 8)}</> : null}
        </span>
      </div>

      <p className="border-b border-border px-3 py-1.5 text-2xs leading-relaxed text-fg-muted">
        预览与导出 DOCX/PDF 来自<strong>同一转换链路</strong>（结构化 → LaTeX → pandoc → DOCX → PDF），
        所见即投稿版式。编号为静态文本；当前为全宽单栏（单栏题区=单栏正文）。
      </p>

      {stale && (
        <p className="border-b border-border bg-amber-50 px-3 py-1.5 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200" data-testid="struct-preview-stale">
          预览过期：内容已变化（预览 SHA {state.sha?.slice(0, 8)}，当前 {currentSha.slice(0, 8)}）。停顿后将自动更新。
        </p>
      )}
      {state.phase === 'error' && (
        <div className="border-b border-border px-3 py-2 text-xs text-danger-fg" data-testid="struct-preview-error">
          <p className="font-semibold">预览生成失败（未产生可下载产物）</p>
          <pre className="mt-1 whitespace-pre-wrap font-sans">{state.error}</pre>
          {canEdit && (
            <Button variant="outline" size="xs" className="mt-1" onClick={onRetry}>重试</Button>
          )}
        </div>
      )}

      <div className="max-h-[calc(100dvh-11rem)] overflow-auto p-2">
        {state.phase === 'done' && state.pdfUrl ? (
          <Suspense fallback={<Loader2 className="mx-auto my-6 size-5 animate-spin text-fg-muted" aria-label="加载中" />}>
            <Pdf url={state.pdfUrl} width={560} />
          </Suspense>
        ) : (
          <div className="grid min-h-40 place-items-center text-xs text-fg-muted" data-testid="struct-preview-placeholder">
            {state.phase === 'idle' && (canEdit ? '输入内容停顿约 2.5 秒后自动生成；也可点右上「导出 PDF」。' : '仅编辑者可生成预览。')}
            {state.phase === 'queued' && '已有预览任务进行中，排队等待…'}
            {state.phase === 'running' && '正在按导出链路生成投稿版 PDF…'}
            {state.phase === 'error' && '—'}
          </div>
        )}
      </div>
    </aside>
  )
}

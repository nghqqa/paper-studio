import { useRef } from 'react'
import { FileUp, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { RebuttalItem, RebuttalMode, RebuttalState, RebuttalStatus } from '@/lib/api/rebuttal'
import { cn } from '@/lib/utils'
import { RebuttalPill, StatusBadge } from './RebuttalArchiveView'
import { CATEGORY_ZH, FIELD_CLS, STATUSES, STATUS_ZH } from './rebuttalHelpers'

export function RebuttalImportList({
  state,
  items,
  visible,
  reviewers,
  canEdit,
  importing,
  loadFailed,
  importText,
  importMode,
  reviewer,
  status,
  onImportText,
  onImportMode,
  onImportPasted,
  onImportFile,
  onReviewer,
  onStatus,
  onRetry,
  onSelectItem,
}: {
  state: RebuttalState | null
  items: RebuttalItem[]
  visible: RebuttalItem[]
  reviewers: string[]
  canEdit: boolean
  importing: boolean
  loadFailed: boolean
  importText: string
  importMode: RebuttalMode
  reviewer: string
  status: RebuttalStatus | ''
  onImportText: (v: string) => void
  onImportMode: (m: RebuttalMode) => void
  onImportPasted: () => void
  onImportFile: (f: File | undefined) => void
  onReviewer: (r: string) => void
  onStatus: (s: RebuttalStatus | '') => void
  onRetry: () => void
  onSelectItem: (id: string) => void
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  return (
    <div className="space-y-2">
      <div className="space-y-1 rounded-md border border-line p-2" data-testid="rebuttal-import">
        <textarea
          className={cn(FIELD_CLS, 'min-h-20 resize-y')}
          value={importText}
          disabled={!canEdit || importing}
          placeholder="粘贴审稿意见全文（识别 Reviewer #/Comment N/1. 等结构，多审稿人自动分组）…"
          onChange={(e) => onImportText(e.target.value)}
          data-testid="rebuttal-import-text"
        />
        <div className="flex items-center gap-1">
          <RebuttalPill active={importMode === 'replace'} onClick={() => onImportMode('replace')} testid="rebuttal-mode-replace" title="替换现有条目并进入下一轮">
            替换
          </RebuttalPill>
          <RebuttalPill active={importMode === 'append'} onClick={() => onImportMode('append')} testid="rebuttal-mode-append" title="保留现有条目，追加导入">
            追加
          </RebuttalPill>
          <span className="flex-1" />
          <Button
            variant="ghost"
            size="xs"
            disabled={!canEdit || importing}
            onClick={() => fileInputRef.current?.click()}
            title="上传 .txt / .md / .pdf（扫描件无文字层将明确报错）"
            data-testid="rebuttal-import-file"
          >
            <FileUp aria-hidden className="size-3.5" />
            上传
          </Button>
          <Button
            variant="primary"
            size="xs"
            disabled={!canEdit || importing || !importText.trim()}
            onClick={onImportPasted}
            data-testid="rebuttal-import-submit"
          >
            {importing ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : null}
            拆条导入
          </Button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".txt,.md,.markdown,.pdf"
          className="hidden"
          onChange={(e) => {
            onImportFile(e.target.files?.[0])
            e.target.value = ''
          }}
          data-testid="rebuttal-file-input"
        />
      </div>

      {state?.warnings && state.warnings.length > 0 && (
        <p className="rounded-md bg-info-bg px-2 py-1.5 text-2xs text-info-fg">{state.warnings.join('；')}</p>
      )}

      {items.length > 0 && (
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="筛选">
          <RebuttalPill active={reviewer === ''} onClick={() => onReviewer('')} testid="rebuttal-reviewer-all">
            全部审稿人
          </RebuttalPill>
          {reviewers.map((r) => (
            <RebuttalPill key={r} active={reviewer === r} onClick={() => onReviewer(r)}>
              {r}
            </RebuttalPill>
          ))}
          <span className="mx-0.5 h-4 w-px bg-line" aria-hidden />
          <RebuttalPill active={status === ''} onClick={() => onStatus('')} testid="rebuttal-status-all">
            全部状态
          </RebuttalPill>
          {STATUSES.map((st) => (
            <RebuttalPill key={st} active={status === st} onClick={() => onStatus(st)} testid={`rebuttal-filter-${st}`}>
              {STATUS_ZH[st]}
            </RebuttalPill>
          ))}
        </div>
      )}

      {state === null && !loadFailed && <p className="p-2 text-fg-muted">加载中…</p>}
      {loadFailed && items.length === 0 && (
        <div className="flex items-center gap-2 p-2">
          <span className="text-fg-muted">加载失败。</span>
          <Button variant="outline" size="xs" onClick={onRetry} data-testid="rebuttal-retry">
            重试
          </Button>
        </div>
      )}
      {items.length === 0 && state !== null && (
        <div className="px-2 py-6 text-center text-fg-muted" data-testid="rebuttal-empty">
          暂无审稿意见条目——粘贴或上传评审意见开始。
        </div>
      )}

      <ul className="space-y-1.5">
        {visible.map((it) => (
          <li key={it.id}>
            <button
              type="button"
              className="w-full rounded-lg border border-line bg-panel p-2 text-left transition-colors hover:border-border-strong"
              onClick={() => onSelectItem(it.id)}
              data-testid={`rebuttal-item-${it.id}`}
            >
              <span className="mb-1 flex items-center gap-1.5">
                <span className="rounded bg-primary-soft px-1.5 py-0.5 text-2xs text-primary">{it.reviewer}</span>
                <span className="rounded bg-sunken px-1.5 py-0.5 text-2xs text-fg-muted">
                  {CATEGORY_ZH[it.category] ?? it.category}
                </span>
                <span className="ml-auto">
                  <StatusBadge status={it.status} />
                </span>
              </span>
              <span className="line-clamp-2 text-fg-muted">{it.text}</span>
              {it.response && <span className="mt-1 block line-clamp-1 text-fg">回复：{it.response}</span>}
            </button>
          </li>
        ))}
      </ul>
      {items.length > 0 && visible.length === 0 && (
        <p className="px-2 py-4 text-center text-fg-muted" data-testid="rebuttal-filter-empty">
          当前筛选下暂无条目。
        </p>
      )}
    </div>
  )
}

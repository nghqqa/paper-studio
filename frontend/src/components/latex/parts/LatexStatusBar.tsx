import { Button } from '@/components/ui/button'
import type { LatexBuildInfo } from '@/lib/api/latex'
import { shortId } from '../hooks/useLatexSession'

export function LatexStatusBar({
  active,
  dirty,
  building,
  latest,
  staleNow,
  onJumpToLine,
}: {
  active: string | null
  dirty: boolean
  building: boolean
  latest: LatexBuildInfo | undefined
  staleNow: boolean
  onJumpToLine: (line: number) => void
}) {
  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-line px-3 text-xs text-fg-muted" data-testid="latex-statusbar">
      <span className="min-w-0 truncate">
        {active ?? '—'}
        {dirty && <span className="text-warning"> · 未保存</span>}
        {building && ' · 编译中'}
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="h-5 px-1.5 text-xs"
        data-testid="latex-goto-line"
        onClick={() => {
          const raw = window.prompt('跳转到行：')
          if (raw == null) return
          const n = Number.parseInt(raw, 10)
          if (Number.isFinite(n)) onJumpToLine(n)
        }}
      >
        转到行
      </Button>
      <span className="ml-auto shrink-0">
        {latest ? (
          <>
            最近构建 {shortId(latest.build_id)} · {latest.status === 'ok' ? '成功' : '失败'}
            {latest.status === 'ok' ? ` · ${latest.duration_ms}ms` : ''}
            {staleNow && ' · 源码已变化，预览可能过期'}
          </>
        ) : (
          '尚未编译'
        )}
      </span>
    </footer>
  )
}

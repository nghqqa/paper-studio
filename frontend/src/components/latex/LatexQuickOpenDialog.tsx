import { useEffect, useMemo, useState } from 'react'
import { FileCode2, Search } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { LatexFileInfo } from '@/lib/api/latex'
import { cn } from '@/lib/utils'

/** Ctrl/Cmd+P 快速切换工程文件弹窗 */
export function LatexQuickOpenDialog({
  open,
  files,
  active,
  onOpenChange,
  onPick,
}: {
  open: boolean
  files: LatexFileInfo[]
  active: string | null
  onOpenChange: (open: boolean) => void
  onPick: (path: string) => void
}) {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)

  useEffect(() => {
    if (open) {
      setQuery('')
      setCursor(0)
    }
  }, [open])

  const candidates = useMemo(() => {
    const editable = files.filter((f) => f.editable)
    const q = query.trim().toLowerCase()
    if (!q) return editable
    return editable.filter((f) => f.path.toLowerCase().includes(q))
  }, [files, query])

  useEffect(() => {
    setCursor(0)
  }, [query])

  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, candidates.length - 1)))
  }, [candidates.length])

  const pick = (path: string) => {
    onOpenChange(false)
    onPick(path)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg p-3" data-testid="latex-quick-open">
        <DialogHeader className="sr-only">
          <DialogTitle>快速切换文件</DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-2 border-b border-line pb-2">
          <Search aria-hidden className="size-4 text-fg-muted" />
          <input
            autoFocus
            className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none"
            placeholder="输入文件名或路径快速跳转（如 chapters/intro.tex）…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setCursor((c) => Math.min(Math.max(0, candidates.length - 1), c + 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setCursor((c) => Math.max(0, c - 1))
              } else if (e.key === 'Enter' && !e.nativeEvent.isComposing && candidates[cursor]) {
                e.preventDefault()
                pick(candidates[cursor].path)
              }
            }}
            data-testid="latex-quick-open-input"
          />
          <kbd className="rounded border border-line bg-sunken px-1.5 py-0.5 text-2xs text-fg-muted">Esc</kbd>
        </div>
        <ul className="max-h-72 overflow-auto py-1 text-xs">
          {candidates.length === 0 && (
            <li className="px-2 py-4 text-center text-fg-muted">没有匹配的源码文件</li>
          )}
          {candidates.map((f, idx) => (
            <li key={f.path}>
              <button
                type="button"
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
                  idx === cursor ? 'bg-primary-soft text-primary' : 'text-fg hover:bg-hover',
                )}
                onMouseEnter={() => setCursor(idx)}
                onClick={() => pick(f.path)}
                data-testid={`quick-open-item-${f.path}`}
              >
                <FileCode2 aria-hidden className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{f.path}</span>
                {f.path === active && (
                  <span className="shrink-0 rounded bg-sunken px-1 text-2xs text-fg-muted">当前</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  )
}

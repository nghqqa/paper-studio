import { useMemo, useState } from 'react'
import { SYMBOL_GROUPS, symbolPreviewHtml } from './symbolsCatalog'

/**
 * 符号面板（三件套之三的 UI）：分组网格 + 命令名过滤 + KaTeX 真字形预览。
 * 点击 → onInsert(cmd)（工作台插到光标处）；Esc 关闭（onClose）。
 * 预览 HTML 静态目录的一次性 useMemo——每次打开不重复渲染。
 */
export function SymbolPanel({ onInsert, onClose }: {
  onInsert(cmd: string): void
  onClose?(): void
}) {
  const [query, setQuery] = useState('')
  const previewCache = useMemo(() => {
    const cache = new Map<string, string | null>()
    for (const group of SYMBOL_GROUPS) {
      for (const item of group.items) {
        cache.set(item.cmd, symbolPreviewHtml(group, item))
      }
    }
    return cache
  }, [])

  const q = query.trim().toLowerCase()
  const groups = useMemo(
    () =>
      SYMBOL_GROUPS.map((group) => ({
        ...group,
        items: q ? group.items.filter((it) => it.cmd.toLowerCase().includes(q)) : group.items,
      })).filter((group) => group.items.length > 0),
    [q],
  )

  return (
    <div className="flex flex-col" data-testid="latex-symbols-panel">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-line px-2 py-1">
        <input
          className="h-6 w-full rounded border border-line bg-app px-1.5 text-xs outline-none placeholder:text-placeholder focus:border-border-strong"
          placeholder="按命令名过滤（如 alpha、sqrt、ref）…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation()
              onClose?.()
            }
          }}
          autoFocus
          data-testid="latex-symbols-filter"
        />
        <span className="shrink-0 text-2xs text-fg-muted" data-testid="latex-symbols-count">
          {groups.reduce((n, g) => n + g.items.length, 0)} 个
        </span>
      </div>
      <div className="max-h-64 shrink-0 overflow-auto px-2 py-1.5">
        {groups.length === 0 && (
          <p className="py-4 text-center text-xs text-fg-muted" data-testid="latex-symbols-empty">
            没有匹配的符号
          </p>
        )}
        {groups.map((g) => (
          <div key={g.label} className="mb-2 last:mb-0">
            <div className="mb-0.5 text-2xs text-fg-muted">{g.label}</div>
            <div className="flex flex-wrap gap-0.5">
              {g.items.map((sym) => {
                const html = previewCache.get(sym.cmd) ?? null
                return (
                  <button
                    key={sym.cmd}
                    type="button"
                    className="flex h-7 min-w-9 items-center justify-center rounded border border-line bg-app px-1 text-fg transition-colors hover:border-border-strong hover:bg-hover"
                    title={`${sym.cmd}（点击插入到光标处）`}
                    onClick={() => onInsert(sym.cmd)}
                    data-testid={`latex-symbol-${sym.cmd.replace(/\\|\{\}| /g, '')}`}
                  >
                    {html ? (
                      <span className="pointer-events-none text-base leading-none" dangerouslySetInnerHTML={{ __html: html }} />
                    ) : (
                      <span className="font-mono text-2xs">{sym.cmd}</span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

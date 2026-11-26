import { X } from 'lucide-react'
import type { OutlineNode } from './pdfTypes'

function FlatOutlineList({
  items,
  depth = 0,
  onSelect,
}: {
  items: OutlineNode[]
  depth?: number
  onSelect: (item: OutlineNode) => void
}) {
  return (
    <ul className="space-y-0.5">
      {items.map((item, idx) => (
        <li key={`${depth}-${idx}-${item.title}`}>
          <button
            type="button"
            className="w-full truncate rounded px-2 py-1 text-left text-xs text-fg hover:bg-hover hover:text-fg-strong"
            style={{ paddingLeft: `${8 + depth * 12}px` }}
            onClick={() => onSelect(item)}
            title={item.title}
          >
            {item.title || '（无标题）'}
          </button>
          {item.items && item.items.length > 0 && (
            <FlatOutlineList items={item.items} depth={depth + 1} onSelect={onSelect} />
          )}
        </li>
      ))}
    </ul>
  )
}

export interface PdfOutlineDrawerProps {
  items: OutlineNode[]
  onSelect: (item: OutlineNode) => void
  onClose: () => void
}

/** PDF 文档书签大纲浮层抽屉 */
export default function PdfOutlineDrawer({ items, onSelect, onClose }: PdfOutlineDrawerProps) {
  return (
    <aside
      aria-label="PDF 书签大纲"
      data-testid="latex-pdf-outline"
      className="absolute right-2 top-9 z-popover max-h-72 w-64 overflow-y-auto rounded-md border border-line bg-panel p-2 shadow-md"
    >
      <div className="mb-1 flex items-center justify-between px-1 text-2xs font-medium text-fg-muted">
        <span>PDF 书签</span>
        <button type="button" className="hover:text-fg" onClick={onClose} aria-label="关闭书签">
          <X className="size-3.5" />
        </button>
      </div>
      <FlatOutlineList items={items} onSelect={onSelect} />
    </aside>
  )
}

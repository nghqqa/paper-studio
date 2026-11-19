import { useEffect, useMemo, useRef, useState } from 'react'
import { FileText } from 'lucide-react'
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { ProjectContentIndex, type SearchHit, MAX_HITS } from './editorSearch'

/**
 * 跨文件搜索（三件套之三）：工程内容索引上的全文件文本搜索弹层。
 * - 检索由 ProjectContentIndex.searchAll 完成，cmdk 只做列表与键盘导航（shouldFilter=false）；
 * - 结果按文件分组（每文件最多展示 5 条），Enter/点击 → onPick(path, line) 由工作台跳转；
 * - partial 索引（大文件跳过）在底部如实提示，不装作全量。
 */
const PER_FILE_LIMIT = 5

interface Props {
  index: ProjectContentIndex
  /** 递增以打开弹层（顶栏按钮 / Ctrl+Shift+F）。 */
  openSignal: number
  onPick: (path: string, line: number) => void
}

export function CrossFileSearch({ index, openSignal, onPick }: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [loading, setLoading] = useState(false)
  const [partial, setPartial] = useState(false)
  const debounceRef = useRef<number | null>(null)

  useEffect(() => {
    if (openSignal <= 0) return
    setOpen(true)
    if (index.ready) {
      setPartial(index.isPartial)
      return
    }
    setLoading(true)
    void index
      .ensure()
      .then(() => setPartial(index.isPartial))
      .catch(() => setPartial(false))
      .finally(() => setLoading(false))
  }, [openSignal, index])

  useEffect(() => {
    if (!open) return
    if (debounceRef.current) window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => {
      setHits(index.searchAll(query))
    }, 120)
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current)
    }
  }, [query, open, index])

  const groups = useMemo(() => {
    const byFile = new Map<string, SearchHit[]>()
    for (const h of hits) {
      const arr = byFile.get(h.path)
      if (arr) {
        if (arr.length < PER_FILE_LIMIT) arr.push(h)
      } else {
        byFile.set(h.path, [h])
      }
    }
    return [...byFile.entries()]
  }, [hits])

  const pick = (h: SearchHit) => {
    setOpen(false)
    onPick(h.path, h.line)
  }

  return (
    <CommandDialog open={open} onOpenChange={setOpen} title="跨文件搜索">
      <Command shouldFilter={false}>
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder="搜索整个工程（全部源文件内容）…"
          data-testid="crossfile-input"
        />
        <CommandList data-testid="crossfile-list">
          {loading && (
            <div className="py-6 text-center text-sm text-muted-foreground" data-testid="crossfile-loading">
              正在索引工程文件…
            </div>
          )}
          {!loading && query.trim() !== '' && hits.length === 0 && (
            <CommandEmpty data-testid="crossfile-empty">没有匹配结果</CommandEmpty>
          )}
          {!loading && query.trim() === '' && (
            <div className="py-6 text-center text-sm text-muted-foreground" data-testid="crossfile-hint">
              输入关键词搜索全部源文件；Enter 跳到命中行
            </div>
          )}
          {groups.map(([path, list]) => (
            <CommandGroup key={path} heading={path}>
              {list.map((h) => (
                <CommandItem
                  key={`${h.line}:${h.col}`}
                  value={`${h.path}:${h.line}:${h.col}`}
                  onSelect={() => pick(h)}
                  data-testid={`crossfile-hit-${h.line}`}
                >
                  <FileText aria-hidden className="size-3.5 shrink-0 opacity-50" />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">
                    <span className="opacity-50">{h.line}: </span>
                    {h.text.trim()}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
        <div
          className="border-t px-3 py-1.5 text-2xs text-muted-foreground"
          data-testid="crossfile-footer"
        >
          {partial ? '大文件已跳过（>1MB）· ' : ''}命中 {hits.length}
          {hits.length >= MAX_HITS ? '+' : ''} 条 · Enter 跳转 · Esc 关闭
        </div>
      </Command>
    </CommandDialog>
  )
}

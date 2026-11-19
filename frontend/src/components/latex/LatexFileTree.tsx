import { useMemo, useState } from 'react'
import {
  ChevronDown, ChevronRight, FileText, Folder, FolderOpen, Image as ImageIcon,
  Pencil, Trash2,
} from 'lucide-react'
import { cn } from '@/lib/utils'

export interface FlatFile {
  path: string
  size: number
  editable: boolean
}

interface DirNode {
  type: 'dir'
  name: string
  path: string
  children: TreeNode[]
}
interface FileNode {
  type: 'file'
  name: string
  path: string
  file: FlatFile
}
type TreeNode = DirNode | FileNode

function buildTree(files: FlatFile[]): TreeNode[] {
  const dirs = new Map<string, DirNode>()
  const root: TreeNode[] = []
  const ensureDir = (path: string, name: string, parent: TreeNode[]): DirNode => {
    let d = dirs.get(path)
    if (!d) {
      d = { type: 'dir', name, path, children: [] }
      dirs.set(path, d)
      parent.push(d)
    }
    return d
  }
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const parts = f.path.split('/')
    let children = root
    let acc = ''
    for (let i = 0; i < parts.length - 1; i += 1) {
      acc = acc ? `${acc}/${parts[i]}` : parts[i]
      const d = ensureDir(acc, parts[i], children)
      children = d.children
    }
    children.push({ type: 'file', name: parts[parts.length - 1], path: f.path, file: f })
  }
  const sortRec = (nodes: TreeNode[]): TreeNode[] => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name, 'zh-Hans-CN')
    })
    for (const n of nodes) if (n.type === 'dir') sortRec(n.children)
    return nodes
  }
  return sortRec(root)
}

function extIcon(name: string) {
  const lower = name.toLowerCase()
  if (lower.endsWith('.pdf')) {
    return (
      <span className="inline-flex shrink-0 items-center rounded-sm bg-danger/10 px-0.5 text-2xs font-semibold leading-3 text-danger">
        PDF
      </span>
    )
  }
  if (/\.(png|jpe?g|gif|svg)$/i.test(lower)) {
    return <ImageIcon aria-hidden className="size-3.5 shrink-0 text-fg-muted" />
  }
  if (lower.endsWith('.bib')) {
    return (
      <span className="inline-flex shrink-0 items-center rounded-sm bg-primary/10 px-0.5 text-2xs font-semibold leading-3 text-primary">
        bib
      </span>
    )
  }
  return <FileText aria-hidden className="size-3.5 shrink-0 text-fg-muted" />
}

export function LatexFileTree({ files, active, dirty, onOpen, onPreview, onRenameFile, onDeleteFile }: {
  files: FlatFile[]
  active: string | null
  dirty: boolean
  onOpen(path: string): void
  /** 图片/PDF 等只读文件点击预览（CoCraft 式）；未传则维持旧的禁用行为。 */
  onPreview?(path: string): void
  /** 文本源文件重命名（工作台内 prompt+确认后调 API）。 */
  onRenameFile?(path: string): void
  /** 文本源文件删除（工作台内确认后调 API）。 */
  onDeleteFile?(path: string): void
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const tree = useMemo(() => buildTree(files), [files])

  const toggle = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const renderNodes = (nodes: TreeNode[], depth: number): React.ReactNode =>
    nodes.map((n) => {
      if (n.type === 'dir') {
        const open = !collapsed.has(n.path)
        return (
          <div key={`d:${n.path}`}>
            <button
              type="button"
              className="flex h-7 w-full items-center gap-1.5 rounded-md px-1.5 text-left text-xs text-fg transition-colors hover:bg-hover"
              style={{ paddingLeft: 6 + depth * 12 }}
              onClick={() => toggle(n.path)}
              aria-expanded={open}
              data-testid={`latex-dir-${n.path}`}
            >
              {open
                ? <ChevronDown aria-hidden className="size-3 shrink-0 text-fg-muted" />
                : <ChevronRight aria-hidden className="size-3 shrink-0 text-fg-muted" />}
              {open
                ? <FolderOpen aria-hidden className="size-3.5 shrink-0 text-primary/80" />
                : <Folder aria-hidden className="size-3.5 shrink-0 text-primary/80" />}
              <span className="truncate">{n.name}</span>
            </button>
            {open && renderNodes(n.children, depth + 1)}
          </div>
        )
      }
      const isActive = n.path === active
      const previewable = !n.file.editable && !!onPreview && /\.(png|jpe?g|gif|webp|bmp|svg|pdf)$/i.test(n.name)
      const renamable = n.file.editable && !!onRenameFile
      const deletable = n.file.editable && !!onDeleteFile
      return (
        <div key={`f:${n.path}`} className="group/file relative">
          <button
            type="button"
            className={cn(
              'flex h-7 w-full items-center gap-1.5 rounded-md px-1.5 text-left text-xs transition-colors',
              isActive ? 'bg-primary-soft font-medium text-primary' : 'text-fg-muted hover:bg-hover hover:text-fg',
              !n.file.editable && !previewable && 'cursor-not-allowed opacity-50',
            )}
            style={{ paddingLeft: 6 + depth * 12, paddingRight: (renamable || deletable) ? 44 : 6 }}
            onClick={() => {
              if (n.file.editable) onOpen(n.path)
              else if (previewable) onPreview!(n.path)
            }}
            disabled={!n.file.editable && !previewable}
            title={
              n.file.editable ? n.path
                : previewable ? `${n.path}（点击预览）`
                  : `${n.path}（只读）`
            }
            data-testid={`latex-file-${n.path}`}
          >
            {extIcon(n.name)}
            <span className="min-w-0 flex-1 truncate">{n.name}</span>
            {isActive && dirty && <span className="shrink-0 text-warning">*</span>}
          </button>
          {(renamable || deletable) && (
            <span className="absolute right-1 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 rounded bg-app/95 px-0.5 group-hover/file:flex">
              {renamable && (
                <button
                  type="button"
                  className="rounded p-0.5 text-fg-muted hover:text-fg"
                  onClick={(e) => { e.stopPropagation(); onRenameFile!(n.path) }}
                  aria-label={`重命名 ${n.name}`}
                  data-testid={`latex-rename-${n.path}`}
                >
                  <Pencil aria-hidden className="size-3" />
                </button>
              )}
              {deletable && (
                <button
                  type="button"
                  className="rounded p-0.5 text-fg-muted hover:text-danger-fg"
                  onClick={(e) => { e.stopPropagation(); onDeleteFile!(n.path) }}
                  aria-label={`删除 ${n.name}`}
                  data-testid={`latex-delete-${n.path}`}
                >
                  <Trash2 aria-hidden className="size-3" />
                </button>
              )}
            </span>
          )}
        </div>
      )
    })

  return (
    <div data-testid="latex-file-tree">
      {renderNodes(tree, 0)}
    </div>
  )
}

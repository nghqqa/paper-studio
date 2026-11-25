import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { hotkeyLabel, type HotkeyAction } from '@/lib/hotkeys'
import { useStudio } from '@/store'

interface Row {
  action: HotkeyAction
  label: string
}

const GENERAL: Row[] = [
  { action: 'palette', label: '命令面板（跳项目 / 页面 / 动作）' },
  { action: 'save', label: '保存' },
  { action: 'find', label: '查找' },
  { action: 'escape', label: '关闭菜单 / 对话框' },
  { action: 'help', label: '本快捷键列表' },
]

function Rows({ rows }: { rows: Row[] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
      {rows.map(({ action, label }) => (
        <div key={action} className="contents">
          <dt>
            <kbd className="inline-block min-w-[4.5rem] rounded-sm border bg-sunken px-1.5 py-0.5 text-center font-mono text-xs text-fg">
              {hotkeyLabel(action)}
            </kbd>
          </dt>
          <dd className="self-center text-fg-muted">{label}</dd>
        </div>
      ))}
    </dl>
  )
}

export function ShortcutsDialog() {
  const open = useStudio((s) => s.dialog === 'shortcuts')
  const closeDialog = useStudio((s) => s.closeDialog)
  const openDialog = useStudio((s) => s.openDialog)
  return (
    <Dialog open={open} onOpenChange={(v) => (v ? openDialog('shortcuts') : closeDialog())}>
      <DialogContent data-slot="ShortcutsDialog" data-testid="shortcuts-dialog" className="max-w-md">
        <DialogHeader>
          <DialogTitle>快捷键</DialogTitle>
          <DialogDescription>全局生效（编辑器内外一致）。macOS 上 Ctrl 读作 ⌘。</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 text-sm text-fg-muted" data-testid="paper-shortcuts">
          <Rows rows={GENERAL} />
          <p>Word 公式：在文档中按 Alt+=；输入公式并在末尾添加 #(2)，回车后生成居中公式与右侧编号。</p>
          <p>LaTeX：在源码中编辑公式，保存后通过「编译」查看 PDF。编辑器内的快捷键以当前写作模式为准。</p>
        </div>
      </DialogContent>
    </Dialog>
  )
}

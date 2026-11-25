import { useEffect } from 'react'
import { Building2, FilePlus2, FolderOpen, Keyboard, LayoutGrid, ScrollText, UserRound } from 'lucide-react'
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from '@/components/ui/command'
import { useIsDesktop } from '@/hooks/useMisc'
import { goAccount, goAdmin, goAudit, goDashboard, goWorkbench } from '@/lib/hash'
import { useStudio } from '@/store'

/** ⌘K 全局命令面板：搜索论文项目、页面导航与快捷动作 */
export function CommandPalette() {
  const open = useStudio((s) => s.dialog === 'palette')
  const projects = useStudio((s) => s.projects)
  const superuser = useStudio((s) => s.user?.is_superuser)
  const closeDialog = useStudio((s) => s.closeDialog)
  const isDesktop = useIsDesktop()

  useEffect(() => {
    if (open && projects.length === 0) void useStudio.getState().loadProjects()
  }, [open, projects.length])

  const run = (fn: () => void) => () => {
    closeDialog()
    fn()
  }

  return (
    <CommandDialog open={open} onOpenChange={(v) => (v ? undefined : closeDialog())} title="命令面板" data-testid="command-palette">
      <CommandInput placeholder="搜索项目、页面或动作…" aria-label="命令面板搜索" />
      <CommandList>
        <CommandEmpty>没有匹配项</CommandEmpty>
        <CommandGroup heading="论文项目">
          {projects.map((p) => (
            <CommandItem
              key={p.id}
              value={`case:${p.id}`}
              keywords={[p.title, p.submission?.venue ?? '', p.id]}
              onSelect={run(() => goWorkbench(p.id))}
              data-testid={`palette-case-${p.id}`}
            >
              <FolderOpen aria-hidden />
              <span className="truncate">{p.title || p.id}</span>
              <span className="ml-auto truncate text-xs text-muted-foreground">
                {p.submission?.venue}
              </span>
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="页面">
          <CommandItem value="page:dashboard" keywords={['项目', '论文', '工作台', '首页']} onSelect={run(() => goDashboard())} data-testid="palette-dashboard">
            <LayoutGrid aria-hidden />
            <span>项目列表</span>
          </CommandItem>
          <CommandItem
            value="page:account"
            keywords={['个人资料', '账号', 'account']}
            onSelect={run(() => goAccount())}
            data-testid="palette-account"
          >
            <UserRound aria-hidden />
            <span>个人资料</span>
          </CommandItem>
          {superuser && (
            <CommandItem
              value="page:admin"
              keywords={['平台', '管理', 'admin']}
              onSelect={run(() => goAdmin())}
              data-testid="palette-admin"
            >
              <Building2 aria-hidden />
              <span>平台管理</span>
            </CommandItem>
          )}
          {superuser && (
            <CommandItem
              value="page:audit"
              keywords={['审计日志', 'audit', '留痕', '操作记录']}
              onSelect={run(() => goAudit())}
              data-testid="palette-audit"
            >
              <ScrollText aria-hidden />
              <span>审计日志</span>
            </CommandItem>
          )}
        </CommandGroup>
        <CommandGroup heading="动作">
          <CommandItem value="act:create" keywords={['新建论文', '创建项目', 'create']} onSelect={run(() => useStudio.getState().openDialog('create'))} data-testid="palette-create">
            <FilePlus2 aria-hidden />
            <span>新建论文项目</span>
          </CommandItem>
          {isDesktop && (
            <CommandItem value="act:shortcuts" keywords={['快捷键', 'help', '帮助']} onSelect={run(() => useStudio.getState().openDialog('shortcuts'))} data-testid="palette-shortcuts">
              <Keyboard aria-hidden />
              <span>快捷键速查</span>
              <CommandShortcut>?</CommandShortcut>
            </CommandItem>
          )}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}

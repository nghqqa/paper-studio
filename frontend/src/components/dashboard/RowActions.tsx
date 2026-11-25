import { useState } from 'react'
import { Archive, ArchiveRestore, LogOut, MoreHorizontal, Trash2, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown'
import { MenuContent, MenuRow, MenuSeparator } from '@/components/ui/menu-bits'
import type { ProjectSummary } from '@/lib/types'
import { FOCUS_RING, cn, touchHit } from '@/lib/utils'
import { useStudio } from '@/store'

/** 行尾 ⋯：归档 / 回收站 / 恢复 / 永久删除（owner）/ 退出（非 owner）。 */
export function RowActions({ row, canEdit, touch, iconStates }: { row: ProjectSummary; canEdit: boolean; touch?: boolean; iconStates?: boolean }) {
  const setListState = useStudio((s) => s.setListState)
  const deleteProject = useStudio((s) => s.deleteProject)
  const leaveProject = useStudio((s) => s.leaveProject)
  const authOff = useStudio((s) => s.authStatus === 'off')
  const [confirmDel, setConfirmDel] = useState(false)
  const [delBusy, setDelBusy] = useState(false)
  const state = row.list_state ?? 'active'
  const isOwner = authOff || row.my_role === 'owner'
  const hasMenuItems = !isOwner || !iconStates
  if (!hasMenuItems) return null
  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              'inline-flex size-sm-control items-center justify-center rounded-sm text-fg-muted hover:bg-hover hover:text-fg-strong data-[state=open]:bg-active',
              touch ? touchHit : 'max-lg:size-touch',
              FOCUS_RING,
            )}
            aria-label={`${row.title || row.id} 的更多操作`}
            title="更多操作"
            data-testid={`row-actions-${row.id}`}
          >
            <MoreHorizontal className="size-4" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <MenuContent align="end" className="min-w-[200px]">
          {state === 'active' && !iconStates && (
            <>
              <MenuRow icon={<Archive />} disabled={!canEdit} onSelect={() => void setListState(row.id, 'archived')}>归档</MenuRow>
              <MenuRow icon={<Trash2 />} disabled={!canEdit} onSelect={() => void setListState(row.id, 'trashed')}>移到回收站</MenuRow>
            </>
          )}
          {state === 'archived' && !iconStates && (
            <MenuRow icon={<ArchiveRestore />} disabled={!canEdit} onSelect={() => void setListState(row.id, 'active')}>取消归档</MenuRow>
          )}
          {state === 'trashed' && !iconStates && (
            <>
              <MenuRow icon={<Undo2 />} disabled={!canEdit} onSelect={() => void setListState(row.id, 'active')}>恢复</MenuRow>
              {isOwner && (
                <>
                  <MenuSeparator />
                  <MenuRow icon={<Trash2 />} className="text-danger-fg" disabled={!canEdit} onSelect={() => setConfirmDel(true)}>
                    永久删除…
                  </MenuRow>
                </>
              )}
            </>
          )}
          {!isOwner && (
            <>
              {!iconStates && <MenuSeparator />}
              <MenuRow icon={<LogOut />} onSelect={() => void leaveProject(row.id)}>退出此项目</MenuRow>
            </>
          )}
        </MenuContent>
      </DropdownMenu>
      <Dialog open={confirmDel} onOpenChange={(o) => { if (!delBusy) setConfirmDel(o) }}>
        <DialogContent size="sm" data-testid={`case-delete-dialog-${row.id}`}>
          <DialogHeader>
            <DialogTitle>永久删除项目</DialogTitle>
            <DialogDescription>「{row.title || row.id}」及其中全部文件、历史与批注将从服务器删除，不可恢复。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDel(false)}>取消</Button>
            <Button
              variant="danger"
              disabled={delBusy}
              data-testid={`case-delete-confirm-${row.id}`}
              onClick={async () => {
                if (delBusy) return
                setDelBusy(true)
                const ok = await deleteProject(row.id)
                setDelBusy(false)
                if (ok) setConfirmDel(false)
              }}
            >
              永久删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

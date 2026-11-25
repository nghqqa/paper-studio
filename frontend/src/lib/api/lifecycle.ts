import { P, req } from './net'
import type { ListState } from '@/types/case'

export const lifecycleApi = {
  /** 当前用户视角的归档 / 回收站 / 恢复 */
  setListState: (id: string, state: ListState) =>
    req<{ pid: string; list_state: ListState }>(`${P(id)}/list-state`, { method: 'POST', body: JSON.stringify({ state }) }),
  /** 永久删除（owner；须先在回收站） */
  deleteProject: (id: string) => req<void>(P(id), { method: 'DELETE' }),
  /** 退出共享给我的项目（非 owner） */
  leaveProject: (id: string) => req<void>(`${P(id)}/leave`, { method: 'POST' }),
}

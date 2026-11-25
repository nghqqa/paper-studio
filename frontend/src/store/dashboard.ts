import { api } from '@/lib/api'
import type { ProjectSummary } from '@/lib/types'
import type { ListState } from '@/types/case'
import type { Slice } from './types'

export type DashScope = 'all' | 'mine' | 'shared' | 'archived' | 'trash'

export interface DashboardSlice {
  dashScope: DashScope
  dashLoading: boolean

  loadDashboard(): Promise<void>
  setDashScope(scope: DashScope): void
  setListState(pid: string, state: ListState): Promise<boolean>
  deleteProject(pid: string): Promise<boolean>
  leaveProject(pid: string): Promise<boolean>
  resetDashboard(): void
}

export const dashboardSlice: Slice<DashboardSlice> = (set, get) => {
  const fail = (e: unknown): false => {
    get().toast((e as Error).message, 'error')
    return false
  }
  const patchRow = (pid: string, f: (row: ProjectSummary) => ProjectSummary) =>
    set({ projects: get().projects.map((p) => (p.id === pid ? f(p) : p)) })

  return {
    dashScope: 'all',
    dashLoading: false,

    loadDashboard: async () => {
      set({ dashLoading: true })
      try {
        await get().loadProjects()
      } catch (e) {
        get().toast(`后端不可用：${(e as Error).message}`, 'error')
      } finally {
        set({ dashLoading: false })
      }
    },

    setDashScope: (dashScope) => set({ dashScope }),

    setListState: async (pid, state) => {
      try {
        const r = await api.setListState(pid, state)
        patchRow(pid, (p) => ({ ...p, list_state: r.list_state }))
        return true
      } catch (e) {
        return fail(e)
      }
    },

    deleteProject: async (pid) => {
      try {
        await api.deleteProject(pid)
        set({ projects: get().projects.filter((p) => p.id !== pid) })
        return true
      } catch (e) {
        return fail(e)
      }
    },

    leaveProject: async (pid) => {
      try {
        await api.leaveProject(pid)
        set({ projects: get().projects.filter((p) => p.id !== pid) })
        return true
      } catch (e) {
        return fail(e)
      }
    },

    resetDashboard: () => set({ dashScope: 'all', dashLoading: false }),
  }
}

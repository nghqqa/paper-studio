import { api, ApiError } from '@/lib/api'
import { writeHashPid } from '@/lib/hash'
import type { Health, ProjectDetail, ProjectSummary, Settings } from '@/lib/types'
import type { Slice } from './types'

export interface ProjectSlice {
  projects: ProjectSummary[]
  /** 当前项目 id（hash 路由）；与 project 分开是为了在详情加载前就能高亮 */
  pid: string | null
  project: ProjectDetail | null
  settings: Settings | null
  health: Health | null
  /** 打开项目时的网络/404 错误（toast 之外也留一份给 shell 展示） */
  projectError: string | null
  /** 项目列表拉取失败（成功清 null）——空态区分「真没项目」与「加载失败」 */
  projectsError: string | null
  /** openProject 已发 GET /api/projects/{pid} 但未返回：角色未知 */
  projectLoading: boolean

  loadProjects(): Promise<void>
  /** 轻量重取项目元（role 等）——不重置各数据 slice */
  refreshProjectMeta(pid: string): Promise<void>
  /** projects + health 一次拉齐（StoreBootstrap 调用，可重入） */
  loadBootstrap(): Promise<void>
  refreshHealth(): Promise<void>
  /** 切项目：写 hash → 拉详情 */
  openProject(pid: string): Promise<void>
  /** 登出 / 换用户：清空当前项目的全部工作区状态 */
  closeWorkspace(): void
}

export const projectSlice: Slice<ProjectSlice> = (set, get) => ({
  projects: [],
  pid: null,
  project: null,
  settings: null,
  health: null,
  projectError: null,
  projectLoading: false,
  projectsError: null,

  loadProjects: async () => {
    try {
      set({ projects: await api.projects(), projectsError: null })
    } catch (e) {
      set({ projectsError: e instanceof Error ? e.message : String(e) })
      throw e
    }
  },

  loadBootstrap: async () => {
    const projectsReq = get().authStatus === 'anon' ? Promise.resolve(get().projects) : api.projects()
    const [projects, health] = await Promise.allSettled([projectsReq, api.health()])
    set({
      projects: projects.status === 'fulfilled' ? projects.value : get().projects,
      projectsError: projects.status === 'rejected' ? (projects.reason instanceof Error ? projects.reason.message : String(projects.reason)) : null,
      health: health.status === 'fulfilled' ? health.value : { ok: false, soffice: false, soffice_bin: '', projects_dir: '' },
    })
  },

  refreshProjectMeta: async (pid) => {
    if (get().pid !== pid) return
    try {
      set({ project: await api.project(pid) })
    } catch (e) {
      if (e instanceof ApiError && (e.status === 403 || e.status === 404) && get().pid === pid) {
        set({ project: null, projectError: e.message, projectLoading: false })
      }
    }
  },

  refreshHealth: async () => {
    try {
      set({ health: await api.health() })
    } catch {
      set({ health: { ok: false, soffice: false, soffice_bin: '', projects_dir: '' } })
    }
  },

  openProject: async (pid) => {
    writeHashPid(pid)
    if (get().pid === pid && get().project?.id === pid) return
    set({
      pid,
      projectError: null,
      projectLoading: true,
      members: [],
      membersLoading: false,
      membersError: null,
      shareLinks: [],
      shareLinksLoading: false,
      shareLinksError: null,
      publicLinks: [],
      publicLinksLoading: false,
      publicLinksUnavailable: false,
      publicLinksError: null,
      dupTabOther: false,
    })
    get().resetCollabCenter()
    try {
      const p = await api.project(pid)
      if (get().pid !== pid) return
      set({
        projectLoading: false,
        project: p,
        settings: p.settings,
      })
    } catch (e) {
      const msg = e instanceof ApiError && e.status === 404 ? `项目「${pid}」不存在` : (e as Error).message
      if (get().pid === pid) set({ project: null, projectError: msg, projectLoading: false })
      get().toast(msg, 'error')
    }
  },

  closeWorkspace: () => {
    get().resetCollabCenter()
    set({
      projects: [],
      pid: null,
      project: null,
      settings: null,
      projectError: null,
      projectLoading: false,
      projectsError: null,
      members: [],
      membersLoading: false,
      membersError: null,
      shareLinks: [],
      shareLinksLoading: false,
      shareLinksError: null,
      publicLinks: [],
      publicLinksLoading: false,
      publicLinksUnavailable: false,
      publicLinksError: null,
      dupTabOther: false,
    })
  },
})

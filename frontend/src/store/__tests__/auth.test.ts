// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import type { ProjectDetail, User } from '@/lib/types'
import { useStudio } from '@/store'

const user = (id: string, role: ProjectDetail['role']): { u: User; p: ProjectDetail } => ({
  u: { id, email: `${id}@x.test`, display_name: id, is_superuser: false },
  p: {
    id: 'method',
    title: '方法',
    mtime: 1,
    role,
    settings: {} as ProjectDetail['settings'],
  },
})

afterEach(() => {
  vi.restoreAllMocks()
  useStudio.getState().closeWorkspace()
})

describe('auth · logout 清工作区', () => {
  it('登出后 pid/project/projects 清空，同 pid 再登录会重新拉详情并拿到新用户的角色', async () => {
    const a = user('alice', 'owner')
    const b = user('bob', 'viewer')
    vi.spyOn(api, 'project').mockResolvedValueOnce(a.p).mockResolvedValueOnce(b.p)
    vi.spyOn(api, 'logout').mockResolvedValue(undefined)
    useStudio.setState({ user: a.u, authStatus: 'authed' })
    await useStudio.getState().openProject('method')
    expect(useStudio.getState().project?.role).toBe('owner')

    await useStudio.getState().logout()
    const s = useStudio.getState()
    expect(s.authStatus).toBe('anon')
    expect(s.user).toBeNull()
    expect(s.pid).toBeNull()
    expect(s.project).toBeNull()
    expect(s.projects).toEqual([])

    useStudio.setState({ user: b.u, authStatus: 'authed' })
    await useStudio.getState().openProject('method')
    expect(api.project).toHaveBeenCalledTimes(2)
    expect(useStudio.getState().project?.role).toBe('viewer')
  })
})

describe('R115-批25 · 会话边界清场', () => {
  it('logout 清空账号/机构与工作台范围：dashScope、orgSettings、orgAiUsage、aiDisabledByOrg、members、publicLinks', async () => {
    vi.spyOn(api, 'logout').mockResolvedValue(undefined)
    useStudio.setState({
      user: { id: 'u1', email: 'a@x', display_name: 'A', is_superuser: false },
      authStatus: 'authed',
      projects: [{ id: 'm1', title: '甲文', mtime: 1 }],
      dashScope: 'mine',
      orgSettings: { ai_enabled: true } as never,
      orgAiUsage: { today_tokens: 1 } as never,
      aiDisabledByOrg: true,
      members: [{ user_id: 'u1', email: 'a@x', display_name: 'A', role: 'owner' }],
      publicLinks: [{ token: 't1' } as never],
    })

    await useStudio.getState().logout()
    const s = useStudio.getState()
    expect(s.projects).toEqual([])
    expect(s.dashScope).toBe('all')
    expect(s.orgSettings).toBeNull()
    expect(s.orgAiUsage).toBeNull()
    expect(s.aiDisabledByOrg).toBe(false)
    expect(s.members).toEqual([])
    expect(s.publicLinks).toEqual([])
  })

  it('expireSession 同样清账号面且额外清 projects；工作区 pid/project 保留以便 returnPid', () => {
    useStudio.setState({
      user: { id: 'u1' } as never,
      authStatus: 'authed',
      pid: 'method',
      project: { id: 'method', title: 'Paper' } as never,
      projects: [{ id: 'm1', title: '甲文' } as never],
      members: [{ user_id: 'u1', email: 'a@x', display_name: 'A', role: 'owner' }],
    })
    useStudio.getState().expireSession()
    const s = useStudio.getState()
    expect(s.authStatus).toBe('anon')
    expect(s.pid).toBe('method')
    expect(s.project?.id).toBe('method')
    expect(s.projects).toEqual([])
    expect(s.members).toEqual([])
  })

  it('closeWorkspace 只清项目工作区，不丢已登录用户态', () => {
    useStudio.setState({
      user: { id: 'u1', email: 'a@x', display_name: 'A', is_superuser: false },
      authStatus: 'authed',
      pid: 'method',
      project: { id: 'method', title: 'Paper' } as never,
    })
    useStudio.getState().closeWorkspace()
    const s = useStudio.getState()
    expect(s.pid).toBeNull()
    expect(s.project).toBeNull()
    expect(s.user?.id).toBe('u1')
  })
})

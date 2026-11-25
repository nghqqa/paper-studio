// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { atDashboard, atPageRoute, clearProjectQuery, clientHash, goDashboard, goWorkbench, parseHash, projectHash, readHashClientToken, readHashPid, readHashProjectQuery, readHashShareToken, writeHashPid } from '../hash'

describe('W4-A 路由（13 §5）：#/ 面板 · #/p/<pid> 规范工作台 · 旧 #/<pid> 兼容', () => {
  it('空 / #/ → dashboard', () => {
    window.location.hash = ''
    expect(parseHash()).toEqual({ kind: 'dashboard' })
    expect(atDashboard()).toBe(true)
    window.location.hash = '#/'
    expect(parseHash()).toEqual({ kind: 'dashboard' })
  })
  it('#/p/<pid> 规范路径；含中文/斜杠编码', () => {
    window.location.hash = '#/p/method'
    expect(parseHash()).toEqual({ kind: 'project', pid: 'method', legacy: false, query: {} })
    window.location.hash = `#${projectHash('案 a/b')}`
    expect(readHashPid()).toBe('案 a/b')
  })
  it('旧 #/<pid> → legacy project，writeHashPid 原地改写为 #/p/<pid>', () => {
    window.location.hash = '#/method'
    expect(parseHash()).toEqual({ kind: 'project', pid: 'method', legacy: true, query: {} })
    writeHashPid('method')
    expect(window.location.hash).toBe('#/p/method')
    writeHashPid('method')
    expect(window.location.hash).toBe('#/p/method')
  })
  it('目录名恰为 p 不被当成规范前缀', () => {
    window.location.hash = '#/p'
    expect(parseHash()).toEqual({ kind: 'project', pid: 'p', legacy: true, query: {} })
  })
  it('goDashboard 写 #/；login / share 不受影响', () => {
    window.location.hash = '#/p/method'
    goDashboard()
    expect(parseHash().kind).toBe('dashboard')
    window.location.hash = '#/login?return=x'
    expect(parseHash().kind).toBe('login')
    window.location.hash = '#/share/tok'
    expect(parseHash()).toEqual({ kind: 'share', token: 'tok' })
  })
})

describe('hash 路由（R6：#/login 与 #/share/<token> 不是案卷 id）', () => {
  it('#/<pid> 仍解析为 pid', () => {
    window.location.hash = '#/method'
    expect(readHashPid()).toBe('method')
    expect(readHashShareToken()).toBeNull()
  })
  it('#/login → 无 pid', () => {
    window.location.hash = '#/login'
    expect(readHashPid()).toBeNull()
  })
  it('#/share/<token> → 无 pid，取 token', () => {
    window.location.hash = '#/share/abc-123'
    expect(readHashPid()).toBeNull()
    expect(readHashShareToken()).toBe('abc-123')
  })
  it('空 hash → null', () => {
    window.location.hash = ''
    expect(readHashPid()).toBeNull()
  })
})

describe('atPageRoute', () => {
  it('login / share / changelog 为页面路由；pid 与空 hash 不是', () => {
    window.location.hash = '#/login'
    expect(atPageRoute()).toBe(true)
    window.location.hash = '#/share/t'
    expect(atPageRoute()).toBe(true)
    window.location.hash = '#/changelog'
    expect(parseHash()).toEqual({ kind: 'changelog' })
    expect(atPageRoute()).toBe(true)
    expect(readHashPid()).toBeNull()
    window.location.hash = '#/changelog?from=home'
    expect(parseHash()).toEqual({ kind: 'changelog' })
    window.location.hash = '#/method'
    expect(atPageRoute()).toBe(false)
    window.location.hash = ''
    expect(atPageRoute()).toBe(false)
  })
})

describe('页面路由：#/account · #/admin · #/c/<token>', () => {
  it('#/account · #/admin 不带 pid；readHashPid 为 null', () => {
    window.location.hash = '#/account'
    expect(parseHash()).toEqual({ kind: 'account' })
    expect(readHashPid()).toBeNull()
    window.location.hash = '#/admin'
    expect(parseHash()).toEqual({ kind: 'admin', tab: null })
    expect(atPageRoute()).toBe(true)
  })
  it('#/c/<token> 外部审阅页；与 #/share 区分', () => {
    window.location.hash = `#${clientHash('tok/x')}`
    expect(parseHash()).toEqual({ kind: 'client', token: 'tok/x' })
    expect(readHashClientToken()).toBe('tok/x')
    expect(readHashShareToken()).toBeNull()
    expect(readHashPid()).toBeNull()
    expect(atPageRoute()).toBe(true)
  })
  it('#/p/<pid>?c=<cid> 携带 query；goWorkbench(pid, query) 写入；clearProjectQuery 原地清掉', () => {
    goWorkbench('method', { c: 'c1' })
    expect(parseHash()).toEqual({ kind: 'project', pid: 'method', legacy: false, query: { c: 'c1' } })
    expect(readHashProjectQuery()).toEqual({ c: 'c1' })
    expect(readHashPid()).toBe('method')
    writeHashPid('method')
    expect(window.location.hash).toBe('#/p/method?c=c1')
    clearProjectQuery()
    expect(window.location.hash).toBe('#/p/method')
    expect(readHashProjectQuery()).toEqual({})
  })
  it('未保留的旧 query 参数不污染解析结果；#/admin?tab=audit 取 tab，非法 tab → null', () => {
    window.location.hash = '#/p/method?panel=deadlines&c=c2'
    expect(readHashProjectQuery()).toEqual({ c: 'c2' })
    expect(projectHash('method', { c: 'c2' })).toBe('/p/method?c=c2')
    clearProjectQuery()
    expect(window.location.hash).toBe('#/p/method')
    window.location.hash = '#/method?c=c3'
    expect(parseHash()).toEqual({ kind: 'project', pid: 'method', legacy: true, query: { c: 'c3' } })
    window.location.hash = '#/admin?tab=audit'
    expect(parseHash()).toEqual({ kind: 'admin', tab: 'audit' })
    window.location.hash = '#/admin?tab=zzz'
    expect(parseHash()).toEqual({ kind: 'admin', tab: null })
  })
  it('名为 administrator / inboxes 的旧 pid 不被当成页面路由', () => {
    window.location.hash = '#/administrator'
    expect(atPageRoute()).toBe(false)
    expect(readHashPid()).toBe('administrator')
  })
})

describe('R91：畸形 hash 不崩', () => {
  it('非法 % 序列原样留作 pid/token，不抛 URIError', () => {
    expect(parseHash('#/p/%')).toEqual({ kind: 'project', pid: '%', legacy: false, query: {} })
    expect(parseHash('#/%E0%A4')).toEqual({ kind: 'project', pid: '%E0%A4', legacy: true, query: {} })
    expect(parseHash('#/share/%zz').kind).toBe('share')
    expect(parseHash('#/c/%zz').kind).toBe('client')
  })
})

describe('纯 Paper 路由收敛：已下线遗留路由解析为 unsupported', () => {
  it('deadlines / inbox / workbench / figlib / __ds / edit / deliver / board / novelty → unsupported', () => {
    for (const h of ['#/deadlines', '#/inbox', '#/workbench', '#/figlib', '#/__ds', '#/edit/c-1/d-2', '#/p/method/deliver', '#/p/method/board', '#/p/method/novelty']) {
      expect(parseHash(h)).toEqual({ kind: 'unsupported' })
    }
    window.location.hash = '#/edit/c-1/d-2'
    expect(atPageRoute()).toBe(true)
    expect(readHashPid()).toBeNull()
    window.location.hash = '#/edit/仅一段'
    expect(parseHash().kind).toBe('project')
  })
})

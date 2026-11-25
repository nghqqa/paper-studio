/**
 * hash 路由（纯 Paper Studio）：
 *   #/                    论文项目列表（首页）
 *   #/p/<pid>             论文工作台（规范路径）
 *   #/<pid>               旧工作台路径 → 解析为 pid；StoreBootstrap 打开后 writeHashPid 会改写成 #/p/<pid>
 *   #/login               登录页；#/share/<token> 分享领取页
 *   #/c/<token>           外部公开审阅页（免登录）
 *   #/account             个人资料；#/admin 平台管理（超管）
 *   #/legal/*             协议与声明；#/manual 在线手册
 *   已下线遗留路由（deadlines / figlib / inbox / workbench / edit / __ds / deliver / board / novelty）→ unsupported 提示页
 */
export interface ProjectQuery {
  /** 打开批注 id */
  c?: string
}

export type AdminTab = 'members' | 'org' | 'audit' | 'ai' | 'templates' | 'doctor'
const ADMIN_TABS: readonly AdminTab[] = ['members', 'org', 'audit', 'ai', 'templates', 'doctor']

export type HashRoute =
  | { kind: 'dashboard' }
  | { kind: 'unsupported' }
  | { kind: 'legal'; page: string }
  | { kind: 'manual' }
  | { kind: 'changelog' }
  | { kind: 'project'; pid: string; legacy: boolean; query: ProjectQuery }
  | { kind: 'login' }
  | { kind: 'share'; token: string }
  | { kind: 'client'; token: string }
  | { kind: 'account' }
  | { kind: 'admin'; tab: AdminTab | null }

const PAGE_ROUTES = /^(share|c|edit)\/|^(login|account|admin|deadlines|inbox|workbench|figlib|__ds|legal|manual|changelog)(\?|$|\/)/

function parseQuery(q: string | undefined): ProjectQuery {
  if (!q) return {}
  const sp = new URLSearchParams(q)
  const out: ProjectQuery = {}
  const c = sp.get('c')
  if (c) out.c = c
  return out
}

const _decode = (s: string) => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s // 畸形 % 序列不崩路由——原样留作 pid/token，由后端 404 兜底
  }
}

export function parseHash(hash: string = window.location.hash): HashRoute {
  const h = hash.replace(/^#\/?/, '')
  if (!h) return { kind: 'dashboard' }
  if (h === 'login' || h.startsWith('login?')) return { kind: 'login' }
  if (h === 'account' || h.startsWith('account?')) return { kind: 'account' }
  if (h === 'admin' || h.startsWith('admin?')) {
    const tab = new URLSearchParams(h.split('?')[1] ?? '').get('tab')
    return { kind: 'admin', tab: ADMIN_TABS.includes(tab as AdminTab) ? (tab as AdminTab) : null }
  }
  if (/^(deadlines|inbox|workbench|figlib|__ds)(\?|$|\/)/.test(h) || /^edit\/[^/?#]+\/[^/?#]+/.test(h)) {
    return { kind: 'unsupported' }
  }
  const legal = h.match(/^legal\/(terms|privacy|copyright)/)
  if (legal) return { kind: 'legal', page: legal[1] }
  if (h === 'manual' || h.startsWith('manual?')) return { kind: 'manual' }
  if (h === 'changelog' || h.startsWith('changelog?')) return { kind: 'changelog' }
  const share = h.match(/^share\/([^/?#]+)/)
  if (share) return { kind: 'share', token: _decode(share[1]) }
  const client = h.match(/^c\/([^/?#]+)/)
  if (client) return { kind: 'client', token: _decode(client[1]) }
  const p = h.match(/^p\/([^/?#]+)(\/(?:deliver|board|novelty))?(?:\?(.*))?$/)
  if (p) {
    if (p[2]) return { kind: 'unsupported' }
    const pid = _decode(p[1])
    return { kind: 'project', pid, legacy: false, query: parseQuery(p[3]) }
  }
  return { kind: 'project', pid: _decode(h.split('?')[0]), legacy: true, query: parseQuery(h.split('?')[1]) }
}

/** 当前 hash 指向的项目 id；面板 / 页面路由 ⇒ null */
export function readHashPid(): string | null {
  const r = parseHash()
  return r.kind === 'project' ? r.pid : null
}

/** 当前 hash 是页面路由而非项目 id / 面板 */
export function atPageRoute(): boolean {
  return PAGE_ROUTES.test(window.location.hash.replace(/^#\/?/, ''))
}

export function atDashboard(): boolean {
  return parseHash().kind === 'dashboard'
}

export function readHashShareToken(): string | null {
  const r = parseHash()
  return r.kind === 'share' ? r.token : null
}

const SHARE_RETURN_KEY = 'patent-studio:share-return'

export function stashShareToken(token: string): void {
  try {
    sessionStorage.setItem(SHARE_RETURN_KEY, token)
  } catch {
    /* private mode 等 */
  }
}

export function takeShareToken(): string | null {
  try {
    const t = sessionStorage.getItem(SHARE_RETURN_KEY)
    if (t) sessionStorage.removeItem(SHARE_RETURN_KEY)
    return t
  } catch {
    return null
  }
}

export function readHashClientToken(): string | null {
  const r = parseHash()
  return r.kind === 'client' ? r.token : null
}

export function readHashProjectQuery(): ProjectQuery {
  const r = parseHash()
  return r.kind === 'project' ? r.query : {}
}

export const projectHash = (pid: string, query?: ProjectQuery) => {
  const base = `/p/${encodeURIComponent(pid)}`
  const sp = new URLSearchParams()
  if (query?.c) sp.set('c', query.c)
  const q = sp.toString()
  return q ? `${base}?${q}` : base
}

export const clientHash = (token: string) => `/c/${encodeURIComponent(token)}`

/** 写规范路径；旧 #/<pid> 打开同一项目时原地改写为 #/p/<pid> */
export function writeHashPid(pid: string) {
  const r = parseHash()
  if (r.kind === 'project' && r.pid === pid && !r.legacy) return
  if (r.kind === 'project' && r.pid === pid) window.location.replace(`#${projectHash(pid)}`)
  else window.location.hash = projectHash(pid)
}

export function goDashboard() {
  if (!atDashboard()) window.location.hash = '/'
}

export function goWorkbench(pid: string, query?: ProjectQuery) {
  const r = parseHash()
  if (query?.c) {
    window.location.hash = projectHash(pid, query)
    return
  }
  if (!(r.kind === 'project' && r.pid === pid && !r.legacy)) window.location.hash = projectHash(pid)
}

export function clearProjectQuery() {
  const r = parseHash()
  if (r.kind === 'project' && r.query.c) window.location.replace(`#${projectHash(r.pid)}`)
}

export function goAccount() {
  if (parseHash().kind !== 'account') window.location.hash = '/account'
}

export function goAdmin() {
  if (parseHash().kind !== 'admin') window.location.hash = '/admin'
}

export function goAudit() {
  window.location.hash = '/admin?tab=audit'
}

import { api, isNotImplemented, isShareExpired, isShareNotFound } from '@/lib/api'
import type { PublicComment, PublicCommentIn, PublicShareLink, PublicShareLinkIn, PublicShareMeta } from '@/types/public-share'
import type { Slice } from './types'

export const GUEST_NAME_KEY = 'patent-studio:guest-name'

export interface PublicShareSlice {
  publicLinks: PublicShareLink[]
  publicLinksLoading: boolean
  publicLinksUnavailable: boolean
  /** GET /public-links 非 501 失败：段内显示，不 toast（与 loadShareLinks 一致） */
  publicLinksError: string | null

  publicToken: string | null
  publicMeta: PublicShareMeta | null
  publicComments: PublicComment[]
  publicLoading: boolean
  /** 410 share.expired / share.revoked ⇒ 页面显示「链接已过期」 */
  publicExpired: boolean
  /** 404 not_found（token 不存在 / 已删除）⇒ 页面显示「链接失效」 */
  publicInvalid: boolean
  publicUnavailable: boolean
  publicError: string | null
  guestName: string

  loadPublicLinks(pid: string): Promise<void>
  createPublicLink(pid: string, body: PublicShareLinkIn): Promise<PublicShareLink | null>
  revokePublicLink(pid: string, token: string): Promise<boolean>

  openPublic(token: string): Promise<void>
  setGuestName(name: string): void
  addPublicComment(body: Omit<PublicCommentIn, 'guest_name'>): Promise<boolean>
  confirmPublic(note?: string): Promise<boolean>
  resetPublic(): void
}

const readGuestName = () => {
  try {
    return localStorage.getItem(GUEST_NAME_KEY) ?? ''
  } catch {
    return ''
  }
}

interface PublicPayload {
  meta: PublicShareMeta
  comments: PublicComment[]
}

/** 同一 token 进行中的整批加载（meta → comments）；settle 后清除 */
const inflight = new Map<string, Promise<PublicPayload>>()

function loadPublic(token: string): Promise<PublicPayload> {
  const cached = inflight.get(token)
  if (cached) return cached
  const p = (async () => {
    const meta = await api.publicMeta(token)
    const comments = meta.scope === 'read' ? [] : await api.publicComments(token)
    return { meta, comments }
  })()
  inflight.set(token, p)
  const settle = () => {
    if (inflight.get(token) === p) inflight.delete(token)
  }
  p.then(settle, settle)
  return p
}

export const publicShareSlice: Slice<PublicShareSlice> = (set, get) => {
  const fail = (e: unknown, key: 'publicLinksUnavailable' | 'publicUnavailable') => {
    const msg = e instanceof Error ? e.message : String(e)
    if (isNotImplemented(e)) set({ [key]: true, publicError: msg })
    else if (isShareExpired(e)) set({ publicExpired: true, publicError: msg })
    else if (key === 'publicUnavailable' && isShareNotFound(e)) set({ publicInvalid: true, publicError: msg })
    else get().toast(msg, 'error')
    return false
  }

  return {
    publicLinks: [],
    publicLinksLoading: false,
    publicLinksUnavailable: false,
    publicLinksError: null,

    publicToken: null,
    publicMeta: null,
    publicComments: [],
    publicLoading: false,
    publicExpired: false,
    publicInvalid: false,
    publicUnavailable: false,
    publicError: null,
    guestName: readGuestName(),

    loadPublicLinks: async (pid) => {
      set({ publicLinksLoading: true, publicLinksError: null })
      try {
        const publicLinks = await api.publicLinks(pid)
        if (!get().pid || get().pid === pid) set({ publicLinks, publicLinksUnavailable: false })
      } catch (e) {
        if (isNotImplemented(e)) set({ publicLinksUnavailable: true })
        else set({ publicLinksError: e instanceof Error ? e.message : String(e) })
      } finally {
        set({ publicLinksLoading: false })
      }
    },

    createPublicLink: async (pid, body) => {
      try {
        const link = await api.createPublicLink(pid, body)
        if (!get().pid || get().pid === pid) set((s) => ({ publicLinks: [link, ...s.publicLinks] }))
        return link
      } catch (e) {
        fail(e, 'publicLinksUnavailable')
        return null
      }
    },

    revokePublicLink: async (pid, token) => {
      try {
        await api.revokePublicLink(pid, token)
        if (!get().pid || get().pid === pid) set((s) => ({ publicLinks: s.publicLinks.map((l) => (l.token === token ? { ...l, revoked: true } : l)) }))
        return true
      } catch (e) {
        return fail(e, 'publicLinksUnavailable')
      }
    },

    openPublic: async (token) => {
      set({ publicToken: token, publicLoading: true, publicExpired: false, publicInvalid: false, publicUnavailable: false, publicError: null })
      try {
        const { meta, comments } = await loadPublic(token)
        if (get().publicToken !== token) return
        set({ publicMeta: meta, publicComments: comments })
      } catch (e) {
        if (get().publicToken !== token) return
        const msg = e instanceof Error ? e.message : String(e)
        set({ publicError: msg, publicUnavailable: isNotImplemented(e), publicExpired: isShareExpired(e), publicInvalid: isShareNotFound(e) })
      } finally {
        if (get().publicToken === token) set({ publicLoading: false })
      }
    },

    setGuestName: (name) => {
      set({ guestName: name })
      try {
        localStorage.setItem(GUEST_NAME_KEY, name)
      } catch {
        /* ignore */
      }
    },

    addPublicComment: async (body) => {
      const { publicToken, guestName } = get()
      if (!publicToken) return false
      try {
        const c = await api.addPublicComment(publicToken, { ...body, guest_name: guestName })
        set((s) => ({ publicComments: [...s.publicComments, c] }))
        return true
      } catch (e) {
        return fail(e, 'publicUnavailable')
      }
    },

    confirmPublic: async (note) => {
      const { publicToken, guestName } = get()
      if (!publicToken) return false
      try {
        const confirmation = await api.publicConfirm(publicToken, { name: guestName, note })
        set((s) => ({ publicMeta: s.publicMeta ? { ...s.publicMeta, confirmation } : s.publicMeta }))
        return true
      } catch (e) {
        return fail(e, 'publicUnavailable')
      }
    },

    resetPublic: () =>
      set({
        publicToken: null,
        publicMeta: null,
        publicComments: [],
        publicLoading: false,
        publicExpired: false,
        publicInvalid: false,
        publicUnavailable: false,
        publicError: null,
      }),
  }
}

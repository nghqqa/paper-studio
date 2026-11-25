import { P, PUB, req } from './net'
import type { Confirmation, PublicComment, PublicCommentIn, PublicConfirmIn, PublicShareLink, PublicShareLinkIn, PublicShareMeta } from '@/types/public-share'

export const publicShareApi = {
  publicLinks: (id: string) => req<PublicShareLink[]>(`${P(id)}/public-links`),
  createPublicLink: (id: string, body: PublicShareLinkIn) =>
    req<PublicShareLink>(`${P(id)}/public-links`, { method: 'POST', body: JSON.stringify(body) }),
  revokePublicLink: (id: string, token: string) =>
    req<void>(`${P(id)}/public-links/${encodeURIComponent(token)}`, { method: 'DELETE' }),
  /** 免登录公开审阅 `/api/public/{token}/*` */
  publicMeta: (token: string, signal?: AbortSignal) => req<PublicShareMeta>(`${PUB(token)}/meta`, { signal }),
  publicPdfUrl: (token: string) => `${PUB(token)}/pdf`,
  publicComments: (token: string, signal?: AbortSignal) => req<PublicComment[]>(`${PUB(token)}/comments`, { signal }),
  addPublicComment: (token: string, body: PublicCommentIn) =>
    req<PublicComment>(`${PUB(token)}/comments`, { method: 'POST', body: JSON.stringify(body) }),
  publicConfirm: (token: string, body: PublicConfirmIn) =>
    req<Confirmation>(`${PUB(token)}/confirm`, { method: 'POST', body: JSON.stringify(body) }),
}

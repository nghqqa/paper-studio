import { P, req } from './net'
import type { Comment, CommentAnchor } from '../types'

export const commentsApi = {
  comments: (id: string) => req<Comment[]>(`${P(id)}/comments`),
  addComment: (id: string, anchor: CommentAnchor, body: string) =>
    req<Comment>(`${P(id)}/comments`, { method: 'POST', body: JSON.stringify({ anchor, body }) }),
  updateComment: (id: string, cid: string, patch: { body?: string; anchor?: CommentAnchor }) =>
    req<Comment>(`${P(id)}/comments/${encodeURIComponent(cid)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteComment: (id: string, cid: string) =>
    req<void>(`${P(id)}/comments/${encodeURIComponent(cid)}`, { method: 'DELETE' }),
  replyComment: (id: string, cid: string, body: string) =>
    req<Comment>(`${P(id)}/comments/${encodeURIComponent(cid)}/replies`, { method: 'POST', body: JSON.stringify({ body }) }),
  resolveComment: (id: string, cid: string, resolved = true) =>
    req<Comment>(`${P(id)}/comments/${encodeURIComponent(cid)}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ resolved }),
    }),
  promoteToIssue: (id: string, cid: string) =>
    req<{ comment: Comment; issue?: { id: string }; issue_id?: string; already_linked: boolean }>(
      `${P(id)}/comments/${encodeURIComponent(cid)}/promote-to-issue`,
      { method: 'POST' },
    ),
  promoteToRebuttal: (id: string, cid: string) =>
    req<{ comment: Comment; item?: { id: string }; item_id?: string; already_linked: boolean }>(
      `${P(id)}/comments/${encodeURIComponent(cid)}/promote-to-rebuttal`,
      { method: 'POST' },
    ),
}

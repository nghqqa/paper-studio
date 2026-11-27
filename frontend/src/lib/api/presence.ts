import { req } from './net'

export interface PresencePeer {
  client_id: string
  user_id: string
  name: string
  file?: string | null
  line?: number | null
  mode?: string
  updated_at: number
}

const P = (pid: string) => `/projects/${encodeURIComponent(pid)}`

export const presenceApi = {
  heartbeat: (
    pid: string,
    payload: { client_id: string; file?: string | null; line?: number | null; mode?: string },
  ) =>
    req<{ peers: PresencePeer[]; ttl_sec: number }>(`${P(pid)}/presence`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  list: (pid: string) => req<{ peers: PresencePeer[]; ttl_sec: number }>(`${P(pid)}/presence`),
  leave: (pid: string, clientId: string) =>
    req<void>(`${P(pid)}/presence?client_id=${encodeURIComponent(clientId)}`, { method: 'DELETE' }),
}

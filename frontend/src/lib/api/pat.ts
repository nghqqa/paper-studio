import { req } from './net'

export interface PatTokenInfo {
  id: string
  name: string
  prefix: string
  scopes: string[]
  created_at: number
  last_used_at: number | null
  expires_at: number | null
  revoked_at: number | null
}

export interface CreatedPatToken extends PatTokenInfo {
  token: string
}

export const patApi = {
  list: () => req<{ tokens: PatTokenInfo[] }>('/api/tokens'),
  create: (name: string, expiresDays?: number | null) =>
    req<{ token: CreatedPatToken }>('/api/tokens', {
      method: 'POST',
      body: JSON.stringify({ name, ...(expiresDays ? { expires_days: expiresDays } : {}) }),
    }),
  revoke: (id: string) => req<{ ok: boolean }>(`/api/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }),
}

import { req } from './net'

export interface AiStatus {
  provider: string
  key_present: boolean
  models: { interactive: string; heavy: string; fallback: string }
  reachable: boolean | null
  checked_at: number | null
  error: string | null
  org_ai_enabled?: boolean
}

export interface MyProviderIn {
  base_url: string
  /** 保存时留空 = 保留已存值（首配必填）；任何响应都不回传明文。 */
  api_key: string
  model_interactive: string
  model_heavy?: string
  model_fallback?: string
}

export interface MyProviderMasked {
  base_url: string
  model_interactive: string
  model_heavy: string
  model_fallback: string
  has_api_key: boolean
  api_key_hint: string
}

export const aiApi = {
  aiPolish: (id: string, body: { text: string; mode: string }) =>
    req<{ text: string; model: string }>('/api/ai/polish', { method: 'POST', body: JSON.stringify({ ...body, project_id: id }) }),
  aiStatus: (probe = false) => req<AiStatus>(`/api/ai/status${probe ? '?probe=1' : ''}`),
  myProvider: () =>
    req<{ provider: MyProviderMasked | null; org_fallback: MyProviderMasked | null; effective: 'user' | 'org' | 'none' }>(
      '/api/ai/my-provider',
    ),
  saveMyProvider: (body: MyProviderIn) =>
    req<{ ok: true; provider: MyProviderMasked }>('/api/ai/my-provider', { method: 'PUT', body: JSON.stringify(body) }),
  clearMyProvider: () => req<{ ok: true; removed: boolean }>('/api/ai/my-provider', { method: 'DELETE' }),
}

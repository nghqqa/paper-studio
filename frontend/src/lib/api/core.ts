import { req } from './net'
import type { Health, ProjectDetail, ProjectSummary, Settings } from '../types'

export const coreApi = {
  health: () => req<Health>('/api/health'),
  projects: () => req<ProjectSummary[]>('/api/projects'),
  project: (id: string) => req<ProjectDetail>(`/api/projects/${encodeURIComponent(id)}`),
  saveSettings: (id: string, settings: Partial<Settings>) =>
    req<{ settings: Settings }>(
      `/api/projects/${encodeURIComponent(id)}/settings`,
      { method: 'PUT', body: JSON.stringify(settings) },
    ),
}

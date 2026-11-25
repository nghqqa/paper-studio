import { create } from 'zustand'
import { persist, subscribeWithSelector } from 'zustand/middleware'
import type { Studio } from './types'
import { accountSlice } from './account'
import { adminSlice } from './admin'
import { authSlice } from './auth'
import { collabCenterSlice } from './collabCenter'
import { dashboardSlice } from './dashboard'
import { projectSlice } from './project'
import { publicShareSlice } from './publicShare'
import { UI_PERSIST_KEYS, uiSlice, type UiPersisted } from './ui'

export const UI_STORAGE_KEY = 'patent-studio:ui:v2'
export const UI_STORAGE_VERSION = 5

type Persisted = UiPersisted
const PERSIST_KEYS = UI_PERSIST_KEYS

export const useStudio = create<Studio>()(
  subscribeWithSelector(
    persist(
      (...a) => ({
        ...projectSlice(...a),
        ...uiSlice(...a),
        ...authSlice(...a),
        ...dashboardSlice(...a),
        ...collabCenterSlice(...a),
        ...accountSlice(...a),
        ...publicShareSlice(...a),
        ...adminSlice(...a),
      }),
      {
        name: UI_STORAGE_KEY,
        version: UI_STORAGE_VERSION,
        migrate: (persisted) => persisted as Partial<Persisted>,
        partialize: (s): Persisted =>
          Object.fromEntries(PERSIST_KEYS.map((k) => [k, s[k]])) as unknown as Persisted,
        merge: (persisted, current) => ({ ...current, ...(persisted as Partial<Persisted>) }),
      },
    ),
  ),
)

export type { Studio } from './types'
export type { ProjectSlice } from './project'
export type { UiSlice, UiPersisted, Theme, DialogId, Density, Toast, ProductMode } from './ui'
export { DESKTOP_QUERY, isDesktopViewport, UI_PERSIST_KEYS } from './ui'
export type { AuthSlice, AuthStatus } from './auth'
export type { DashboardSlice, DashScope } from './dashboard'
export type { CollabCenterSlice } from './collabCenter'
export { selectCanManage, peerNameOf } from './collabCenter'
export type { AccountSlice } from './account'
export type { PublicShareSlice } from './publicShare'
export { GUEST_NAME_KEY } from './publicShare'
export type { AdminSlice } from './admin'

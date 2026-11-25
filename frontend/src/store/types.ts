import type { StateCreator } from 'zustand'
import type { AccountSlice } from './account'
import type { AdminSlice } from './admin'
import type { AuthSlice } from './auth'
import type { CollabCenterSlice } from './collabCenter'
import type { DashboardSlice } from './dashboard'
import type { ProjectSlice } from './project'
import type { PublicShareSlice } from './publicShare'
import type { UiSlice } from './ui'

export type Studio =
  & ProjectSlice
  & UiSlice
  & AuthSlice
  & DashboardSlice
  & CollabCenterSlice
  & AccountSlice
  & PublicShareSlice
  & AdminSlice

/** 所有 slice 共用的 creator 类型（中间件顺序：subscribeWithSelector → persist） */
export type Slice<T> = StateCreator<
  Studio,
  [['zustand/subscribeWithSelector', never], ['zustand/persist', unknown]],
  [],
  T
>

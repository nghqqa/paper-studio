import { req } from './net'

export interface DeadlineItem {
  pid: string
  title: string
  source_format: string
  venue: string
  stage: string
  deadline: string
  days_left: number | null
  status: 'overdue' | 'soon' | 'upcoming' | 'unscheduled'
  url?: string
  notes?: string
}

export const deadlinesApi = {
  list: () => req<{ items: DeadlineItem[]; today: string }>('/deadlines'),
  icsUrl: () => '/api/deadlines/calendar.ics',
  remindCheck: () => req<{ checked: number; due_soon: DeadlineItem[]; notified: number }>('/deadlines/remind-check', { method: 'POST' }),
}

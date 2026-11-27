import { useMemo, useState } from 'react'
import { BellRing, CalendarDays, ChevronLeft, ChevronRight, Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { deadlinesApi } from '@/lib/api/deadlines'
import { downloadFile } from '@/lib/download'
import { projectHash } from '@/lib/hash'
import type { ProjectSummary } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useStudio } from '@/store'
import { deadlineDays, stageLabel, paperStage } from './paperProjects'

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

function monthKey(y: number, m: number, d: number): string {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

export function DeadlineCalendar({ projects }: { projects: ProjectSummary[] }) {
  const now = useMemo(() => new Date(), [])
  const [cursor, setCursor] = useState(() => ({ year: now.getFullYear(), month: now.getMonth() }))
  const [reminding, setReminding] = useState(false)
  const [exporting, setExporting] = useState(false)

  const scheduled = useMemo(() => {
    const byDay = new Map<string, ProjectSummary[]>()
    const unscheduled: ProjectSummary[] = []
    for (const p of projects) {
      const dl = (p.submission?.deadline || '').trim().slice(0, 10)
      if (/^\d{4}-\d{2}-\d{2}$/.test(dl)) {
        const list = byDay.get(dl) ?? []
        list.push(p)
        byDay.set(dl, list)
      } else {
        unscheduled.push(p)
      }
    }
    return { byDay, unscheduled }
  }, [projects])

  const cells = useMemo(() => {
    const { year, month } = cursor
    const firstWeekday = new Date(year, month, 1).getDay()
    const daysInMonth = new Date(year, month + 1, 0).getDate()
    const out: Array<{ dateKey: string | null; day: number | null }> = []
    for (let i = 0; i < firstWeekday; i++) out.push({ dateKey: null, day: null })
    for (let d = 1; d <= daysInMonth; d++) {
      out.push({ dateKey: monthKey(year, month, d), day: d })
    }
    while (out.length % 7 !== 0) out.push({ dateKey: null, day: null })
    return out
  }, [cursor])

  const todayKey = monthKey(now.getFullYear(), now.getMonth(), now.getDate())

  const stepMonth = (delta: number) => {
    setCursor((prev) => {
      const d = new Date(prev.year, prev.month + delta, 1)
      return { year: d.getFullYear(), month: d.getMonth() }
    })
  }

  const handleRemind = async () => {
    if (reminding) return
    setReminding(true)
    try {
      const res = await deadlinesApi.remindCheck()
      if (res.due_soon.length === 0) {
        useStudio.getState().toast('未来 7 天内暂无临近投稿截稿日期', 'info')
      } else {
        useStudio.getState().toast(`发现 ${res.due_soon.length} 篇临近/逾期截稿论文（新推送 ${res.notified} 条站内提醒）`, 'success')
      }
    } catch (e) {
      useStudio.getState().toast(e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setReminding(false)
    }
  }

  const handleExportIcs = async () => {
    if (exporting) return
    setExporting(true)
    try {
      await downloadFile(deadlinesApi.icsUrl(), 'paper-deadlines.ics')
    } catch (e) {
      useStudio.getState().toast(e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="space-y-4 px-6 py-4" data-testid="deadline-calendar">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <CalendarDays aria-hidden className="size-4 text-primary" />
          <h2 className="text-sm font-semibold text-fg-strong" data-testid="deadline-calendar-month">
            {cursor.year} 年 {cursor.month + 1} 月
          </h2>
          <div className="flex items-center gap-1">
            <Button size="xs" variant="outline" onClick={() => stepMonth(-1)} aria-label="上个月" data-testid="deadline-prev-month">
              <ChevronLeft aria-hidden className="size-3.5" />
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => setCursor({ year: now.getFullYear(), month: now.getMonth() })}
              data-testid="deadline-today"
            >
              本月
            </Button>
            <Button size="xs" variant="outline" onClick={() => stepMonth(1)} aria-label="下个月" data-testid="deadline-next-month">
              <ChevronRight aria-hidden className="size-3.5" />
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="xs"
            variant="outline"
            disabled={reminding}
            onClick={() => void handleRemind()}
            data-testid="deadline-remind-btn"
          >
            <BellRing aria-hidden className="size-3.5" />
            {reminding ? '检查中…' : '检查截稿提醒'}
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={exporting}
            onClick={() => void handleExportIcs()}
            data-testid="deadline-calendar-ics"
          >
            <Download aria-hidden className="size-3.5" />
            {exporting ? '导出中…' : '导出 .ics 订阅日历'}
          </Button>
        </div>
      </div>

      <div className="overflow-hidden rounded border border-border bg-panel">
        <div className="grid grid-cols-7 border-b border-border bg-sunken text-center text-xs font-medium text-fg-muted">
          {WEEKDAYS.map((w) => (
            <div key={w} className="py-1.5">
              周{w}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7 divide-x divide-y divide-border">
          {cells.map((cell, idx) => {
            const list = cell.dateKey ? scheduled.byDay.get(cell.dateKey) ?? [] : []
            const isToday = cell.dateKey === todayKey
            return (
              <div
                key={cell.dateKey ?? `pad-${idx}`}
                className={cn(
                  'min-h-24 p-1.5 text-xs',
                  cell.day == null && 'bg-sunken/50 text-fg-muted',
                  isToday && 'bg-primary/5',
                )}
                data-date={cell.dateKey ?? undefined}
              >
                {cell.day != null && (
                  <>
                    <div className={cn('mb-1 flex items-center justify-between text-2xs', isToday ? 'font-bold text-primary' : 'text-fg-muted')}>
                      <span>{cell.day}</span>
                      {isToday && <span>今天</span>}
                    </div>
                    <div className="space-y-1">
                      {list.map((p) => {
                        const left = deadlineDays(p.submission?.deadline)
                        const toneClass =
                          left !== null && left < 0
                            ? 'border-danger/40 bg-danger/10 text-danger-fg'
                            : left !== null && left <= 7
                              ? 'border-warning/40 bg-warning/10 text-warning'
                              : 'border-primary/30 bg-primary/10 text-primary'
                        return (
                          <a
                            key={p.id}
                            href={`#${projectHash(p.id)}`}
                            className={cn('block truncate rounded border px-1 py-0.5 text-2xs hover:underline', toneClass)}
                            title={`${p.title || p.id}${p.submission?.venue ? ` · ${p.submission.venue}` : ''}（${stageLabel(paperStage(p))}）`}
                            data-testid={`deadline-pill-${p.id}`}
                          >
                            {p.submission?.venue ? `[${p.submission.venue}] ` : ''}
                            {p.title || p.id}
                          </a>
                        )
                      })}
                    </div>
                  </>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {scheduled.unscheduled.length > 0 && (
        <div className="rounded border border-border bg-panel p-3" data-testid="deadline-unscheduled">
          <div className="mb-1.5 text-xs font-medium text-fg-strong">待设截稿日期的项目（{scheduled.unscheduled.length} 篇）</div>
          <div className="flex flex-wrap gap-1.5">
            {scheduled.unscheduled.map((p) => (
              <a
                key={p.id}
                href={`#${projectHash(p.id)}`}
                className="rounded border border-border bg-app px-2 py-0.5 text-xs text-fg hover:bg-hover"
              >
                {p.title || p.id}
                {p.submission?.venue ? ` · ${p.submission.venue}` : ''}
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

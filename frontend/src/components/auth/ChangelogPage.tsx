import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, ArrowRight, History } from 'lucide-react'
import { BrandMark } from '@/components/auth/AuthFrame'
import {
  CHANGELOG_RELEASES,
  CHANGE_CATEGORY_META,
  LATEST_RELEASE_VERSION,
  type ChangeCategory,
} from '@/components/auth/changelogData'
import { Badge } from '@/components/ui/badge'
import { BRAND_NAME } from '@/lib/brand'
import { cn } from '@/lib/utils'

type FilterValue = 'all' | ChangeCategory

const FILTER_OPTIONS: { value: FilterValue; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'feature', label: CHANGE_CATEGORY_META.feature.label },
  { value: 'improvement', label: CHANGE_CATEGORY_META.improvement.label },
  { value: 'fix', label: CHANGE_CATEGORY_META.fix.label },
]

/**
 * 官网更新日志页（#/changelog）：匿名与登录态均可达，展示版本演进历史。
 */
export function ChangelogPage() {
  const [filter, setFilter] = useState<FilterValue>('all')

  useEffect(() => {
    const prevTitle = document.title
    document.title = `更新日志 — ${BRAND_NAME}`
    return () => {
      document.title = prevTitle
    }
  }, [])

  const categoryCounts = useMemo(() => {
    const counts: Record<FilterValue, number> = { all: 0, feature: 0, improvement: 0, fix: 0 }
    for (const rel of CHANGELOG_RELEASES) {
      for (const item of rel.changes) {
        counts.all += 1
        counts[item.category] += 1
      }
    }
    return counts
  }, [])

  const visibleReleases = useMemo(
    () =>
      CHANGELOG_RELEASES.map((rel) => ({
        ...rel,
        changes: filter === 'all' ? rel.changes : rel.changes.filter((c) => c.category === filter),
      })).filter((rel) => rel.changes.length > 0),
    [filter],
  )

  return (
    <main id="main-content" tabIndex={-1} className="min-h-dvh bg-app text-fg" data-testid="changelog-page">
      <header className="sticky top-0 z-sticky border-b border-border bg-panel/90 backdrop-blur">
        <div className="mx-auto flex h-12 max-w-4xl items-center justify-between px-4">
          <a href="#/" className="flex items-center gap-2 text-sm font-semibold text-fg-strong">
            <BrandMark size="sm" className="size-6" />
            {BRAND_NAME}
          </a>
          <div className="flex items-center gap-4 text-xs">
            <a href="#/manual" className="text-fg-muted hover:text-fg transition-colors">
              使用手册
            </a>
            <a
              href="https://github.com/nghqqa/paper-studio/releases"
              target="_blank"
              rel="noreferrer"
              className="text-fg-muted hover:text-fg transition-colors max-sm:hidden"
            >
              GitHub Releases
            </a>
            <a href="#/" className="inline-flex items-center gap-1 text-fg-muted hover:text-fg transition-colors">
              <ArrowLeft className="size-3.5" aria-hidden />
              返回
            </a>
          </div>
        </div>
      </header>

      <article className="mx-auto max-w-4xl px-4 py-10">
        <div className="flex items-center gap-2.5">
          <History className="size-6 text-primary" aria-hidden />
          <h1 className="text-2xl font-semibold text-fg-strong">更新日志</h1>
        </div>
        <p className="mt-2 text-xs text-fg-muted">
          当前最新 <span className="font-mono text-fg">{LATEST_RELEASE_VERSION}</span> · 记录研稿（Paper Studio）功能演进与体验优化
        </p>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <div role="group" aria-label="按变更类型筛选" className="flex flex-wrap items-center gap-2">
            {FILTER_OPTIONS.map((opt) => {
              const active = filter === opt.value
              return (
                <button
                  key={opt.value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setFilter(opt.value)}
                  data-testid={`changelog-filter-${opt.value}`}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors',
                    active
                      ? 'border-primary bg-primary-soft font-medium text-link'
                      : 'border-border bg-panel text-fg-muted hover:text-fg',
                  )}
                >
                  <span>{opt.label}</span>
                  <span className="tabular-nums opacity-80">{categoryCounts[opt.value]}</span>
                </button>
              )
            })}
          </div>
        </div>

        <nav aria-label="版本目录" className="mt-4 flex flex-wrap gap-2">
          {visibleReleases.map((rel) => (
            <a
              key={rel.id}
              href={`#release-${rel.id}`}
              onClick={(e) => {
                e.preventDefault()
                document.getElementById(`release-${rel.id}`)?.scrollIntoView({ behavior: 'smooth' })
              }}
              className="rounded-md border border-border bg-panel px-2.5 py-1 font-mono text-xs text-fg-muted hover:text-fg transition-colors"
            >
              {rel.version}
            </a>
          ))}
        </nav>

        <div className="mt-8 space-y-6">
          {visibleReleases.map((rel) => (
            <section
              key={rel.id}
              id={`release-${rel.id}`}
              data-testid={`release-${rel.id}`}
              className="scroll-mt-16 rounded-xl border border-border bg-panel p-5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-semibold text-fg-strong">{rel.version}</span>
                  {rel.badge && <Badge tone="brand">{rel.badge}</Badge>}
                </div>
                <time className="text-xs tabular-nums text-fg-muted">{rel.date}</time>
              </div>

              <h2 className="mt-2 text-base font-semibold text-fg-strong">{rel.title}</h2>
              <p className="mt-1 text-sm text-fg-muted">{rel.summary}</p>

              <ul className="mt-4 space-y-2.5 border-t border-border pt-3.5">
                {rel.changes.map((item, idx) => {
                  const meta = CHANGE_CATEGORY_META[item.category]
                  return (
                    <li key={`${rel.id}-${idx}`} className="flex items-start gap-2.5 text-sm leading-6 text-fg">
                      <Badge tone={meta.tone} className="mt-0.5 shrink-0">
                        {meta.label}
                      </Badge>
                      <span className="text-fg-muted">{item.text}</span>
                    </li>
                  )
                })}
              </ul>
            </section>
          ))}
        </div>

        <footer className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4 text-xs text-fg-muted">
          <span>
            想了解各模块详细操作步骤？查看{' '}
            <a href="#/manual" className="text-link hover:underline">
              在线用户手册
            </a>
            。
          </span>
          <a href="#/login" className="inline-flex items-center gap-1 font-medium text-link hover:underline">
            进入工作台 <ArrowRight className="size-3.5" aria-hidden />
          </a>
        </footer>
      </article>
    </main>
  )
}

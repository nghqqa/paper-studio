import { useSyncExternalStore } from 'react'

export type Locale = 'zh-CN' | 'en'

const STORAGE_KEY = 'paper-studio-locale'

const DICT = {
  'zh-CN': {
    'brand.caption': '科研工作空间',
    'nav.projects': '论文项目',
    'nav.venues': '投稿计划',
    'nav.figures': '科研图表',
    'nav.assets': '跨项目资产',
    'nav.templates': '模板管理',
    'dash.search_placeholder': '搜索论文、投稿目标或标签…',
    'dash.workspace': '项目空间',
    'dash.new_project': '新建项目',
    'dash.import_archive': '导入整档',
    'dash.import_archive_success': '已从归档恢复论文项目',
    'dash.view_list': '列表',
    'dash.view_board': '看板',
    'dash.empty_title': '从第一篇论文开始',
    'locale.switch_label': 'EN',
    'locale.menu_item': '界面语言：中文 / English',
  },
  en: {
    'brand.caption': 'Research Workspace',
    'nav.projects': 'Papers',
    'nav.venues': 'Submissions',
    'nav.figures': 'Figures',
    'nav.assets': 'Shared Assets',
    'nav.templates': 'Templates',
    'dash.search_placeholder': 'Search papers, venues, or tags…',
    'dash.workspace': 'Workspace',
    'dash.new_project': 'New Paper',
    'dash.import_archive': 'Import Archive',
    'dash.import_archive_success': 'Restored paper project from archive',
    'dash.view_list': 'List',
    'nav.board': 'Board',
    'dash.view_board': 'Board',
    'dash.empty_title': 'Start Your First Paper',
    'locale.switch_label': '中文',
    'locale.menu_item': 'Language: English / 中文',
  },
} as const

export type MessageKey = keyof (typeof DICT)['zh-CN']

const listeners = new Set<() => void>()

function readInitial(): Locale {
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage?.getItem(STORAGE_KEY) : null
    if (raw === 'en' || raw === 'zh-CN') return raw
  } catch {
    /* ignore */
  }
  return 'zh-CN'
}

let currentLocale: Locale = readInitial()

export function getLocale(): Locale {
  return currentLocale
}

export function setLocale(next: Locale): void {
  if (currentLocale === next) return
  currentLocale = next
  try {
    if (typeof window !== 'undefined') {
      window.localStorage?.setItem(STORAGE_KEY, next)
    }
    if (typeof document !== 'undefined') {
      document.documentElement.lang = next
    }
  } catch {
    /* ignore */
  }
  listeners.forEach((fn) => fn())
}

export function toggleLocale(): void {
  setLocale(currentLocale === 'zh-CN' ? 'en' : 'zh-CN')
}

export function t(key: MessageKey, locale: Locale = currentLocale): string {
  const table = DICT[locale] as Record<string, string>
  return table[key] ?? (DICT['zh-CN'] as Record<string, string>)[key] ?? key
}

export function useI18n() {
  const locale = useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    () => currentLocale,
    () => 'zh-CN' as Locale,
  )
  return {
    locale,
    setLocale,
    toggleLocale,
    t: (key: MessageKey) => t(key, locale),
  }
}

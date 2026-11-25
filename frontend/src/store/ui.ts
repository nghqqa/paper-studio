import type { Slice } from './types'

export type Theme = 'light' | 'dark' | 'system'
export type Density = 'compact' | 'comfortable'
export type DialogId = 'create' | 'shortcuts' | 'palette'
export type ProductMode = 'unknown' | 'paper'

export const DESKTOP_QUERY = '(min-width: 1024px)'
export const isDesktopViewport = () => typeof window !== 'undefined' && window.matchMedia(DESKTOP_QUERY).matches

export interface Toast {
  id: number
  text: string
  kind: 'info' | 'error' | 'success' | 'warning'
}

export interface UiPersisted {
  theme: Theme
  density: Density
}

export const UI_PERSIST_KEYS = ['theme', 'density'] as const

export interface UiSlice extends UiPersisted {
  product: ProductMode
  metaError: string | null
  docxExportEnabled: boolean | null
  structWriterEnabled: boolean | null
  wordEditorEnabled: boolean | null
  wordEditorReady: boolean | null
  demoMode: boolean
  siteContact: { email: string; wechat: string; note: string }
  dialog: DialogId | null
  toasts: Toast[]
  dupTabOther: boolean

  fetchMeta(): Promise<void>
  setTheme(t: Theme): void
  toggleTheme(): void
  setDensity(d: Density): void
  setDupTabOther(dup: boolean): void
  openDialog(id: DialogId): void
  closeDialog(): void
  toast(text: string, kind?: Toast['kind']): void
  dismissToast(id: number): void
}

let toastSeq = 0

export const uiSlice: Slice<UiSlice> = (set, get) => ({
  product: 'unknown',
  metaError: null,
  docxExportEnabled: null,
  structWriterEnabled: null,
  wordEditorEnabled: null,
  wordEditorReady: null,
  demoMode: false,
  siteContact: { email: '', wechat: '', note: '' },
  theme: 'system',
  density: 'comfortable',
  dialog: null,
  toasts: [],
  dupTabOther: false,

  async fetchMeta() {
    set({ metaError: null })
    try {
      const r = await fetch('/api/meta', { cache: 'no-store' })
      if (!r.ok) throw new Error('工作区配置加载失败')
      const m = (await r.json()) as {
        product: string
        docx_export: boolean
        struct_writer?: boolean
        word_editor?: boolean
        word_editor_ready?: boolean
        demo_mode?: boolean
        contact?: { email?: string; wechat?: string; note?: string }
      }
      if (m.product !== 'paper') throw new Error('工作区配置不完整')
      set({
        product: 'paper',
        docxExportEnabled: Boolean(m.docx_export),
        structWriterEnabled: Boolean(m.struct_writer),
        wordEditorEnabled: Boolean(m.word_editor),
        wordEditorReady: Boolean(m.word_editor_ready),
        demoMode: Boolean(m.demo_mode),
        siteContact: {
          email: (m.contact?.email || '').trim(),
          wechat: (m.contact?.wechat || '').trim(),
          note: (m.contact?.note || '').trim(),
        },
      })
    } catch {
      set({ metaError: '暂时无法连接工作区，请检查服务后重试。' })
    }
  },

  setTheme: (theme) => set({ theme }),
  toggleTheme: () => {
    const cur = get().theme
    const dark =
      cur === 'dark' || (cur === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    set({ theme: dark ? 'light' : 'dark' })
  },
  setDensity: (density) => set({ density }),
  setDupTabOther: (dupTabOther) => set({ dupTabOther }),
  openDialog: (dialog) => set({ dialog }),
  closeDialog: () => set({ dialog: null }),

  toast: (text, kind = 'info') => {
    if (kind === 'error' && /Failed to fetch|NetworkError|Load failed|fetch failed/i.test(text)) return
    const id = ++toastSeq
    set((s) => ({ toasts: [...s.toasts, { id, text, kind }] }))
    window.setTimeout(() => get().dismissToast(id), kind === 'error' ? 5000 : 2500)
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
})

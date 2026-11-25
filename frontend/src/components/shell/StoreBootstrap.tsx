import { useEffect } from 'react'
import { useStudio } from '@/store'
import { goDashboard, parseHash, readHashPid, writeHashPid } from '@/lib/hash'
import { dispatchHotkey, matchHotkey, registerHotkeys } from '@/lib/hotkeys'
import { BRAND_NAME, pageTitle } from '@/lib/brand'

/** 部署能力开关：任何路由挂载即拉取一次 */
export function MetaBootstrap() {
  useEffect(() => {
    void useStudio.getState().fetchMeta()
  }, [])
  return null
}

/** 焦点在 Radix 弹层（菜单/对话框/抽屉）内时，Esc 由弹层自行处理 */
function inOverlay(el: Element | null): boolean {
  return !!el?.closest('[role="dialog"],[role="menu"],[role="alertdialog"]')
}

/** 深链接指向不存在 / 无权的项目 ⇒ 回项目列表 */
async function openFromHash(pid: string) {
  await useStudio.getState().openProject(pid)
  const s = useStudio.getState()
  if (s.pid === pid && s.projectError && readHashPid() === pid) goDashboard()
}

function onHashChange() {
  const pid = readHashPid()
  if (!pid) return
  const s = useStudio.getState()
  if (s.authStatus === 'anon') return
  if (pid !== s.pid || (!s.project && s.projectError)) void openFromHash(pid)
  else writeHashPid(pid)
}

/** 无 UI 的启动器：拉取 me/projects/health、同步 hash 路由、document.title、主题与全局快捷键 */
export function StoreBootstrap() {
  useEffect(() => {
    let alive = true
    void (async () => {
      if (parseHash(window.location.hash).kind === 'client') return
      const st = useStudio.getState()
      await st.loadMe()
      try {
        await st.loadBootstrap()
      } catch (e) {
        st.toast(`后端不可用：${(e as Error).message}`, 'error')
      }
      if (!alive) return
      const s = useStudio.getState()
      if (!s.health?.ok && !s.projects.length) s.toast('后端不可用，请确认 :8000 已启动', 'error')
      if (s.authStatus === 'anon') return
      const pid = readHashPid()
      if (pid) void openFromHash(pid)
    })()

    window.addEventListener('hashchange', onHashChange)

    const applyTitle = () => {
      const r = parseHash()
      if (r.kind === 'project') {
        const p = useStudio.getState().project
        document.title = p ? pageTitle(p.title || p.id) : BRAND_NAME
      } else if (r.kind === 'dashboard') {
        document.title = BRAND_NAME
      }
    }
    const unsubTitle = useStudio.subscribe((s) => s.project, applyTitle, { fireImmediately: true })
    window.addEventListener('hashchange', applyTitle)

    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const applyTheme = () => {
      const t = useStudio.getState().theme
      document.documentElement.classList.toggle('dark', t === 'dark' || (t === 'system' && mq.matches))
    }
    const unsubTheme = useStudio.subscribe((s) => s.theme, applyTheme, { fireImmediately: true })
    mq.addEventListener('change', applyTheme)

    const unregHotkeys = registerHotkeys({
      palette: () => {
        const s = useStudio.getState()
        if (!s.dialog && s.authStatus !== 'anon') s.openDialog('palette')
      },
      escape: () => {
        const s = useStudio.getState()
        if (s.dialog) s.closeDialog()
      },
      help: () => {
        const s = useStudio.getState()
        if (!s.dialog) s.openDialog('shortcuts')
      },
    })

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return
      if (useStudio.getState().project?.settings?.source_format === 'docx') {
        if (matchHotkey(e, 'save')) {
          e.preventDefault()
          window.dispatchEvent(new Event('paper-word-save'))
        }
        return
      }
      const target = e.target as Element | null
      const editing = !!target?.closest('input,textarea,select,[contenteditable="true"],.cm-content')
      const plainField = !!target?.closest('input,textarea,select')
      if (e.key === 'Escape' && inOverlay(target)) return
      if (editing && e.key === '?') return
      if (plainField && e.key !== 'Escape' && !matchHotkey(e, 'palette')) return
      dispatchHotkey(e)
    }
    window.addEventListener('keydown', onKeyDown)

    return () => {
      alive = false
      window.removeEventListener('hashchange', onHashChange)
      window.removeEventListener('hashchange', applyTitle)
      window.removeEventListener('keydown', onKeyDown)
      mq.removeEventListener('change', applyTheme)
      unsubTitle()
      unsubTheme()
      unregHotkeys()
    }
  }, [])
  return null
}

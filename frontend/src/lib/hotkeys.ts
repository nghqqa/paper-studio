/**
 * 页面级快捷键注册表。
 * 键位写法沿用 CodeMirror：`Mod` = Ctrl（Windows/Linux）/ ⌘（macOS）。
 */
export const HOTKEYS = {
  save: 'Mod-s',
  find: 'Mod-f',
  escape: 'Escape',
  help: '?',
  palette: 'Mod-k',
} as const

export type HotkeyAction = keyof typeof HOTKEYS
export type HotkeyMap = Partial<Record<HotkeyAction, () => void>>

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

/** 用于 tooltip 的可读写法：Mod-s → Ctrl+S / ⌘S */
export function hotkeyLabel(action: HotkeyAction): string {
  const parts = HOTKEYS[action].split('-')
  return parts
    .map((p) => {
      if (p === 'Mod') return IS_MAC ? '⌘' : 'Ctrl'
      if (IS_MAC && p === 'Shift') return '⇧'
      if (IS_MAC && p === 'Alt') return '⌥'
      return p.length === 1 ? p.toUpperCase() : p
    })
    .join(IS_MAC ? '' : '+')
}

/** 判断一次 keydown 是否命中某键位 */
export function matchHotkey(e: KeyboardEvent, action: HotkeyAction): boolean {
  const parts = HOTKEYS[action].split('-')
  const key = parts[parts.length - 1]
  const mods = new Set(parts.slice(0, -1))
  const wantMod = mods.has('Mod')
  const hasMod = IS_MAC ? e.metaKey : e.ctrlKey
  if (wantMod !== hasMod) return false
  if (mods.has('Shift') !== e.shiftKey && key !== '?') return false
  if (mods.has('Alt') !== e.altKey) return false
  return e.key === key || e.key.toLowerCase() === key.toLowerCase()
}

const registry: HotkeyMap[] = []

export function registerHotkeys(map: HotkeyMap): () => void {
  registry.push(map)
  return () => {
    const i = registry.indexOf(map)
    if (i >= 0) registry.splice(i, 1)
  }
}

export function dispatchHotkey(e: KeyboardEvent): boolean {
  for (let i = registry.length - 1; i >= 0; i--) {
    for (const action of Object.keys(registry[i]) as HotkeyAction[]) {
      const fn = registry[i][action]
      if (fn && matchHotkey(e, action)) {
        e.preventDefault()
        fn()
        return true
      }
    }
  }
  return false
}

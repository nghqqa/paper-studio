import { type RefObject, useEffect, useRef } from 'react'
import type { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

/** CodeMirror 挂载：state 变化（换文件/冲突重载）时整体重建视图。 */
export function CodeMirrorHost({
  state,
  viewRef,
}: {
  state: EditorState
  viewRef: RefObject<EditorView | null>
}) {
  const host = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!host.current) return
    const view = new EditorView({ state, parent: host.current })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [state, viewRef])
  return <div ref={host} className="h-full" />
}

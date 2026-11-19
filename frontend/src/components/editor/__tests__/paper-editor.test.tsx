// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { useStudio } from '@/store'
import { Editor } from '../Editor'

it('空白 Markdown 论文展示论文写作提示，旧版面偏好不会打开专利编辑器', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = (q) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList
  Range.prototype.getClientRects ??= () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList
  Range.prototype.getBoundingClientRect ??= () => new DOMRect()
  useStudio.setState({ ...useStudio.getInitialState(), product: 'paper', editorView: 'layout', content: '' }, true)
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<Editor chrome={false} />))
    expect(host.querySelector('.cm-content')).not.toBeNull()
    expect(host.textContent).toContain('论文标题')
    expect(host.textContent).not.toMatch(/专利|发明|案卷|权利要求|说明书/)
    expect(host.querySelector('[data-slot="LayoutView"]')).toBeNull()
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})

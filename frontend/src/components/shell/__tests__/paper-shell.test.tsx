// @vitest-environment jsdom
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DESKTOP_QUERY, useStudio } from '@/store'

const SOURCES = import.meta.glob('/src/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const EXT = ['', '.ts', '.tsx', '/index.ts', '/index.tsx']

function normalize(path: string): string {
  const out: string[] = []
  for (const seg of path.split('/')) {
    if (seg === '..') out.pop()
    else if (seg !== '.' && seg !== '') out.push(seg)
  }
  return '/' + out.join('/')
}

function resolveLocal(from: string, spec: string): string | null {
  const base = spec.startsWith('@/')
    ? '/src/' + spec.slice(2)
    : spec.startsWith('.')
      ? normalize(from.slice(0, from.lastIndexOf('/')) + '/' + spec)
      : null
  if (!base) return null
  for (const e of EXT) if (base + e in SOURCES) return base + e
  return null
}

function importGraph(entry: string) {
  const seen = new Set<string>()
  const packages = new Set<string>()
  const walk = (file: string) => {
    if (seen.has(file) || !(file in SOURCES)) return
    seen.add(file)
    for (const m of SOURCES[file].matchAll(/^\s*import\s+(?!type\s)[^'"]*?from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm)) {
      const spec = m[1] ?? m[2]
      const local = resolveLocal(file, spec)
      if (local) walk(local)
      else if (!spec.startsWith('.') && !spec.startsWith('@/')) {
        packages.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0])
      }
    }
  }
  walk(entry)
  return { files: [...seen].map((f) => f.slice('/src/'.length)), packages }
}

vi.mock('@/components/latex/LatexWorkbench', () => ({ LatexWorkbench: () => <div data-testid="mock-latex-workbench" /> }))
vi.mock('@/components/word/WordWorkbench', () => ({ WordWorkbench: () => <div data-testid="mock-word-workbench" /> }))
vi.mock('@/components/paper/MarkdownPaperWorkbench', () => ({ MarkdownPaperWorkbench: () => <div data-testid="mock-markdown-workbench" /> }))
vi.mock('@/components/collab-center', () => ({ CollabDrawer: () => null }))
vi.mock('../Toasts', () => ({ Toasts: () => null }))

import { PaperShell } from '../PaperShell'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

let root: Root | null = null
let host: HTMLElement

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = (q: string) =>
    ({ matches: q === DESKTOP_QUERY, media: q, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList
  Element.prototype.scrollIntoView ??= () => {}
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
})

const initial = useStudio.getInitialState()
const proj = (id: string, source_format: string, document_type: 'paper' | 'patent' = 'paper') =>
  ({ id, title: id, settings: { source_format, document_type } }) as never

beforeEach(() => {
  useStudio.setState(initial, true)
  useStudio.setState({ product: 'paper', authStatus: 'authed' })
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  host?.remove()
})

async function mount(el: ReactElement) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root!.render(el))
  await act(async () => {})
  return host
}

describe('PaperShell 隔离与工作台分流', () => {
  it('静态 import 图不含 dockview / prosemirror / yjs / 旧壳与具体工作台', () => {
    const g = importGraph('/src/components/shell/PaperShell.tsx')
    for (const pkg of ['dockview-react', 'dockview-core', 'prosemirror-state', 'prosemirror-view', 'yjs', 'y-websocket']) {
      expect(g.packages.has(pkg)).toBe(false)
    }
    for (const f of [
      'components/shell/DesktopShell.tsx',
      'components/mobile/MobileShell.tsx',
      'components/latex/LatexWorkbench.tsx',
      'components/word/WordWorkbench.tsx',
    ]) {
      expect(g.files).not.toContain(f)
    }
  })

  it('跨源切换期（pid 已变但旧 project 残留）显示正在加载项目，不挂错误工作台', async () => {
    useStudio.setState({ pid: 'word-pid', project: proj('latex-pid', 'latex'), projectLoading: true, projectError: null })
    const el = await mount(<PaperShell />)
    expect(el.querySelector('[role="status"]')?.textContent).toContain('正在加载项目')
    expect(el.querySelector('[data-testid="mock-latex-workbench"]')).toBeNull()
    expect(el.querySelector('[data-testid="mock-word-workbench"]')).toBeNull()
  })

  it('纯专利旧档案在论文工作区给出不可用提示', async () => {
    useStudio.setState({ pid: 'pat-1', project: proj('pat-1', 'markdown', 'patent'), projectLoading: false, projectError: null })
    const el = await mount(<PaperShell />)
    expect(el.querySelector('[data-testid="patent-project-unavailable"]')).not.toBeNull()
  })

  it('docx 与 latex 工程分别渲染对应懒加载工作台', async () => {
    useStudio.setState({ pid: 'doc-1', project: proj('doc-1', 'docx'), projectLoading: false, projectError: null })
    const el = await mount(<PaperShell />)
    await act(async () => {
      await vi.waitFor(() => expect(el.querySelector('[data-testid="mock-word-workbench"]')).not.toBeNull())
    })
    await act(async () => useStudio.setState({ pid: 'tex-1', project: proj('tex-1', 'latex'), projectLoading: false }))
    await act(async () => {
      await vi.waitFor(() => expect(el.querySelector('[data-testid="mock-latex-workbench"]')).not.toBeNull())
    })
  })
})

import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { makeCiteSource, makeRefSource, type CiteCandidate, type LabelCandidate } from '../citeCompletions'

function ctxAt(doc: string): CompletionContext {
  const state = EditorState.create({ doc })
  return new CompletionContext(state, doc.length, false)
}

function optionsOf(r: CompletionResult | null): { label: string; detail: string }[] {
  if (!r || !Array.isArray((r as { options?: unknown }).options)) return []
  return (r as unknown as { options: { label: string; detail: string }[] }).options
}

const ENTRIES: CiteCandidate[] = [
  { citation_key: 'einstein1905', title: 'Ist die Tragheit eines Korpers', authors: ['Einstein, A.', 'Others'], year: '1905' },
  { citation_key: 'knuth1984', title: 'The TeXbook', authors: ['Knuth, D. E.'], year: '1984' },
  { citation_key: 'einstein1920', title: 'Relativity', authors: ['Einstein, A.'], year: '1920' },
]

const LABELS: LabelCandidate[] = [
  { name: 'sec:intro', file: 'main.tex', line: 3 },
  { name: 'eq:main', file: 'main.tex', line: 7 },
  { name: 'eq:appendix', file: 'sections/app.tex', line: 12 },
]

describe('\\cite 补全源', () => {
  it('敲 \\cite{ 触发：列出全部条目，from 指向键起始', () => {
    const r = makeCiteSource(ENTRIES)(ctxAt('见 \\cite{'))
    expect(r).not.toBeNull()
    expect(r!.from).toBe(8) // \cite{ 之后
    const opts = optionsOf(r)
    expect(opts.map((o) => o.label)).toEqual(['einstein1905', 'knuth1984', 'einstein1920'])
  })

  it('已敲前缀过滤：键前缀命中优先排序，仅标题命中排后', () => {
    const r = makeCiteSource(ENTRIES)(ctxAt('\\cite{ein'))
    const opts = optionsOf(r)
    expect(opts[0].label).toBe('einstein1905')
    expect(opts.map((o) => o.label)).toContain('einstein1920')
    expect(opts.map((o) => o.label)).not.toContain('knuth1984')
    expect(r!.from).toBe(6)
  })

  it('多键场景：\\cite{a,knu} 继续补第二个键', () => {
    const r = makeCiteSource(ENTRIES)(ctxAt('\\cite{einstein1905,knu'))
    const opts = optionsOf(r)
    expect(opts.map((o) => o.label)).toEqual(['knuth1984'])
  })

  it('detail 含 标题 · 首作者 et al. (年份)', () => {
    const r = makeCiteSource(ENTRIES)(ctxAt('\\cite{'))
    const opts = optionsOf(r)
    expect(opts[0].detail).toBe('Ist die Tragheit eines Korpers · Einstein, A. et al. (1905)')
  })

  it('非 cite 上下文不触发；空库不触发', () => {
    expect(makeCiteSource(ENTRIES)(ctxAt('普通文字 ref{'))).toBeNull()
    expect(makeCiteSource([])(ctxAt('\\cite{'))).toBeNull()
  })
})

describe('\\ref 补全源', () => {
  it('\\ref{ 与 \\eqref{ 都触发，detail=文件:行，重名去重', () => {
    const src = makeRefSource([...LABELS, { name: 'eq:main', file: 'other.tex', line: 99 }])
    const r = src(ctxAt('如 \\eqref{'))
    expect(r).not.toBeNull()
    const opts = optionsOf(r)
    expect(opts).toHaveLength(3)
    expect(opts[0].detail).toBe('main.tex:3')
    expect(src(ctxAt('\\ref{eq:a'))).not.toBeNull() // 光标在括号内（before 文本不含闭括号）
  })

  it('前缀过滤 + 非引用命令不触发', () => {
    const src = makeRefSource(LABELS)
    expect(optionsOf(src(ctxAt('\\ref{eq:'))).map((o) => o.label)).toEqual(['eq:main', 'eq:appendix'])
    expect(src(ctxAt('\\label{'))).toBeNull()
    expect(src(ctxAt('\\cite{'))).toBeNull()
  })
})

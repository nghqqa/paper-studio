// @vitest-environment jsdom
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { extractMathAtCursor, extractRefContext, wrapSelectionCommand } from '../editorEnhancements'

describe('extractMathAtCursor', () => {
  it('detects inline $...$ without requiring selection', () => {
    const doc = 'Let $E = mc^2$ denote energy.'
    const pos = doc.indexOf('mc^2') + 2
    expect(extractMathAtCursor(doc, pos, pos)).toEqual({ tex: 'E = mc^2', displayMode: false })
  })

  it('detects inline \\(...\\) and ignores escaped \\$', () => {
    const escaped = 'Price is \\$10 and \\$20 total.'
    expect(extractMathAtCursor(escaped, 12, 12)).toBeNull()

    const paren = 'Compute \\(\\alpha + \\beta\\) now.'
    const p = paren.indexOf('alpha')
    expect(extractMathAtCursor(paren, p, p)).toEqual({ tex: '\\alpha + \\beta', displayMode: false })
  })

  it('detects $$...$$ and \\[...\\] display math', () => {
    const doc = 'Before\n$$\n\\sum_{i=1}^n x_i\n$$\nAfter'
    const p = doc.indexOf('x_i')
    expect(extractMathAtCursor(doc, p, p)).toEqual({ tex: '\\sum_{i=1}^n x_i', displayMode: true })

    const br = 'Eq:\n\\[a^2 + b^2 = c^2\\]'
    const q = br.indexOf('b^2')
    expect(extractMathAtCursor(br, q, q)).toEqual({ tex: 'a^2 + b^2 = c^2', displayMode: true })
  })

  it('detects align and equation environments and normalizes aligned body', () => {
    const doc = '\\begin{align}\n\\label{eq:one}\ny &= ax + b \\\\\nz &= cx\n\\end{align}'
    const pos = doc.indexOf('ax + b')
    expect(extractMathAtCursor(doc, pos, pos)).toEqual({
      tex: '\\begin{aligned}y &= ax + b \\\\\nz &= cx\\end{aligned}',
      displayMode: true,
    })
  })

  it('ignores comment lines and returns null outside math', () => {
    const doc = '% $x + y$\nPlain prose here.'
    expect(extractMathAtCursor(doc, 5, 5)).toBeNull()
    expect(extractMathAtCursor(doc, doc.indexOf('prose'), doc.indexOf('prose'))).toBeNull()
  })
})

describe('wrapSelectionCommand', () => {
  it('wraps selected text or inserts centered placeholders', () => {
    const st1 = EditorState.create({ doc: 'hello world', selection: { anchor: 0, head: 5 } })
    const view1 = new EditorView({ state: st1 })
    expect(wrapSelectionCommand('\\textbf{', '}')(view1)).toBe(true)
    expect(view1.state.doc.toString()).toBe('\\textbf{hello} world')
    view1.destroy()

    const st2 = EditorState.create({ doc: 'abc', selection: { anchor: 3 } })
    const view2 = new EditorView({ state: st2 })
    expect(wrapSelectionCommand('\\textit{', '}')(view2)).toBe(true)
    expect(view2.state.doc.toString()).toBe('abc\\textit{}')
    expect(view2.state.selection.main.head).toBe('abc\\textit{'.length)
    view2.destroy()
  })
})

describe('extractRefContext', () => {
  it('returns enclosing figure caption even right after an equation block', () => {
    const doc = [
      '\\begin{equation}',
      '  L(\\theta) = \\sum_i x_i',
      '  \\label{eq:loss}',
      '\\end{equation}',
      '\\begin{figure}[htbp]',
      '  \\centering',
      '  \\includegraphics{figures/sample.png}',
      '  \\caption{Result of \\textbf{Ours}}',
      '  \\label{fig:sample}',
      '\\end{figure}',
    ].join('\n')

    expect(extractRefContext(doc, 9)).toEqual({
      kind: 'caption',
      text: 'Result of \\textbf{Ours}',
    })
    expect(extractRefContext(doc, 3)).toEqual({
      kind: 'math',
      text: 'L(\\theta) = \\sum_i x_i',
    })
  })
})

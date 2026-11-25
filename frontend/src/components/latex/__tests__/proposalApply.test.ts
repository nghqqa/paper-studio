import { describe, expect, it, beforeAll } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { history, historyKeymap, defaultKeymap, undo } from '@codemirror/commands'
import { keymap } from '@codemirror/view'
import { applyToView, locateAnchor, revertInView, selectionPayload, sectionRange } from '@/components/paper/proposalApply'

// @vitest-environment jsdom

beforeAll(() => {
  // jsdom 无 Range 客户端矩形 API——CM scrollIntoView 需要它（不补桩会有未捕获异常）
  if (typeof Range !== 'undefined' && !Range.prototype.getClientRects) {
    ;(Range.prototype as unknown as { getClientRects: () => unknown }).getClientRects = () => ({
      length: 0,
      item: () => null,
      [Symbol.iterator]: function* () { /* empty */ },
    })
    ;(Range.prototype as unknown as { getBoundingClientRect: () => unknown }).getBoundingClientRect = () => ({
      left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() { /* noop */ },
    })
  }
  Element.prototype.scrollIntoView ??= () => {}
})

function makeView(doc: string) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [keymap.of([...defaultKeymap, ...historyKeymap]), history()],
    }),
    parent: host,
  })
  return view
}

const ANCHOR = {
  original_text: '目标句子',
  context_before: '前文。',
  context_after: '后文。',
}

describe('locateAnchor', () => {
  it('唯一命中', () => {
    const r = locateAnchor('前文。目标句子后文。', ANCHOR)
    expect(r.ok).toBe(true)
    expect(r.start).toBe(3)
    expect(r.reason).toBe('unique')
  })
  it('多处 + 上下文消歧唯一', () => {
    const r = locateAnchor('目标句子前文。目标句子后文。目标句子', ANCHOR)
    expect(r.ok).toBe(true)
    expect(r.start).toBe(7)
    expect(r.reason).toBe('context')
  })
  it('多处 + 上下文相同 ⇒ 歧义拒绝', () => {
    const r = locateAnchor('前文。目标句子后文。前文。目标句子后文。', ANCHOR)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('ambiguous')
  })
  it('找不到 ⇒ not_found（绝不找相似句替换）', () => {
    const r = locateAnchor('完全不同的一段文本。', ANCHOR)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('not_found')
  })
})

describe('applyToView / revertInView', () => {
  it('采纳 = 原位替换 + 可撤销（undo 恢复原文）', () => {
    const doc = '开头\n\n前文。目标句子后文。\n\n结尾'
    const view = makeView(doc)
    const out = applyToView(view, ANCHOR, '改后的句子', 'main.tex', 'main.tex')
    expect(out.ok).toBe(true)
    expect(view.state.doc.toString()).toBe('开头\n\n前文。改后的句子后文。\n\n结尾')
    // 可撤销：undo 恢复原文
    undo(view)
    expect(view.state.doc.toString()).toBe(doc)
  })
  it('文件不匹配拒绝写入', () => {
    const view = makeView('前文。目标句子后文。')
    const out = applyToView(view, ANCHOR, '改', 'other.tex', 'main.tex')
    expect(out.ok).toBe(false)
    expect(out.reason).toBe('file_mismatch')
    expect(view.state.doc.toString()).toBe('前文。目标句子后文。')
  })
  it('原文失配不写入（stale 语义）', () => {
    const view = makeView('内容已完全变化。')
    const out = applyToView(view, ANCHOR, '改', 'main.tex', 'main.tex')
    expect(out.ok).toBe(false)
    expect(out.reason).toBe('not_found')
  })
  it('歧义不写入', () => {
    const view = makeView('前文。目标句子后文。前文。目标句子后文。')
    const out = applyToView(view, ANCHOR, '改', 'main.tex', 'main.tex')
    expect(out.ok).toBe(false)
    expect(out.reason).toBe('ambiguous')
  })
  it('撤销采纳：把已写入的建议文本换回原文', () => {
    const view = makeView('前文。目标句子后文。')
    applyToView(view, ANCHOR, '改后的句子', 'main.tex', 'main.tex')
    const out = revertInView(view, { original_text: '目标句子', context_before: '', context_after: '' }, '改后的句子', 'main.tex', 'main.tex')
    expect(out.ok).toBe(true)
    expect(view.state.doc.toString()).toBe('前文。目标句子后文。')
  })
  it('应用后选区收拢到插入文本末尾（不依赖面板打开时的选区）', () => {
    const view = makeView('前文。目标句子后文。')
    // 用户光标停在文档中部（打开面板前的位置）
    view.dispatch({ selection: { anchor: 2 } })
    const out = applyToView(view, ANCHOR, '改后的句子', 'main.tex', 'main.tex')
    expect(out.ok).toBe(true)
    expect(view.state.selection.main.head).toBe(3 + '改后的句子'.length)
  })
})

describe('selectionPayload / sectionRange', () => {
  it('上下文各截 400 字', () => {
    const doc = '甲'.repeat(500) + '目标' + '乙'.repeat(500)
    const p = selectionPayload(doc, 500, 502)
    expect(p.original_text).toBe('目标')
    expect(p.context_before.length).toBe(400)
    expect(p.context_after.length).toBe(400)
  })
  it('section 边界', () => {
    const doc = '\\section{A}\nAAA\n\\subsection{A1}\nA1A1\n\\section{B}\nBBB\n'
    const r = sectionRange(doc, doc.indexOf('A1A1'))
    expect(r).not.toBeNull()
    expect(doc.slice(r!.from, r!.to)).toContain('A1A1')
    expect(doc.slice(r!.from, r!.to)).not.toContain('BBB')
    const whole = sectionRange(doc, doc.indexOf('AAA'))
    expect(doc.slice(whole!.from, whole!.to)).toContain('AAA')
    expect(doc.slice(whole!.from, whole!.to)).toContain('A1A1')
    expect(doc.slice(whole!.from, whole!.to)).not.toContain('BBB')
  })
})

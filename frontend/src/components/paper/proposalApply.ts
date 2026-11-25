import type { EditorView } from '@codemirror/view'

/**
 * 论文提案 → CodeMirror 事务的落地核心（headless，可脱离 DOM 测试）。
 *
 * 安全规则：
 * - 定位只认「原文精确匹配」；多处命中时用生成时上下文消歧——消歧后仍不唯一 ⇒ 拒绝（歧义）；
 * - 绝不「找相似句子」替换：找不到就 ok:false（前端据此置 stale 并阻止采纳）；
 * - 应用 = 一次普通 dispatch（进入 CM history，Ctrl+Z 可撤销）；选区在事务后收拢到插入文本末尾；
 * - 中文输入法组合期间（view.composing）不写入——排队到 composition 结束后执行。
 */

export interface LocateResult {
  ok: boolean
  start: number
  end: number
  reason: 'unique' | 'context' | 'not_found' | 'ambiguous' | 'empty'
}

export function locateAnchor(text: string, anchor: AnchorLike): LocateResult {
  const orig = anchor.original_text
  if (!orig) return { ok: false, start: -1, end: -1, reason: 'empty' }
  const positions: number[] = []
  let idx = text.indexOf(orig)
  while (idx !== -1 && positions.length < 1000) {
    positions.push(idx)
    idx = text.indexOf(orig, idx + 1)
  }
  if (positions.length === 1) {
    return { ok: true, start: positions[0], end: positions[0] + orig.length, reason: 'unique' }
  }
  if (positions.length > 1) {
    const matched: number[] = []
    for (const s of positions) {
      const before = text.slice(Math.max(0, s - anchor.context_before.length), s)
      const after = text.slice(s + orig.length, s + orig.length + anchor.context_after.length)
      if (before.endsWith(anchor.context_before) && after.startsWith(anchor.context_after)) matched.push(s)
    }
    if (matched.length === 1) {
      return { ok: true, start: matched[0], end: matched[0] + orig.length, reason: 'context' }
    }
    return { ok: false, start: -1, end: -1, reason: 'ambiguous' }
  }
  return { ok: false, start: -1, end: -1, reason: 'not_found' }
}

export interface AnchorLike {
  original_text: string
  context_before: string
  context_after: string
}

export interface ApplyOutcome {
  ok: boolean
  reason: LocateResult['reason'] | 'composing' | 'readonly' | 'no_view' | 'file_mismatch'
}

/** 把建议文本写入编辑器（可撤销事务）。原文定位失败一律不写。 */
export function applyToView(view: EditorView | null, anchor: AnchorLike, suggestedText: string, activePath: string | null, file: string): ApplyOutcome {
  if (!view) return { ok: false, reason: 'no_view' }
  if (activePath !== file) return { ok: false, reason: 'file_mismatch' }
  if (view.composing) return { ok: false, reason: 'composing' }
  const doc = view.state.doc.toString()
  const loc = locateAnchor(doc, anchor)
  if (!loc.ok) return { ok: false, reason: loc.reason }
  if (view.state.readOnly) return { ok: false, reason: 'readonly' }
  view.dispatch({
    changes: { from: loc.start, to: loc.end, insert: suggestedText },
    selection: { anchor: loc.start + suggestedText.length },
    scrollIntoView: true,
    userEvent: 'input.proposal',
  })
  return { ok: true, reason: 'unique' }
}

/** 撤销采纳：把（应用后的）建议文本换回原文。定位不到时 ok:false（提示用编辑器 Ctrl+Z）。 */
export function revertInView(view: EditorView | null, anchor: AnchorLike, appliedText: string, activePath: string | null, file: string): ApplyOutcome {
  if (!view) return { ok: false, reason: 'no_view' }
  if (activePath !== file) return { ok: false, reason: 'file_mismatch' }
  if (view.composing) return { ok: false, reason: 'composing' }
  const doc = view.state.doc.toString()
  const loc = locateAnchor(doc, { original_text: appliedText, context_before: '', context_after: '' })
  if (!loc.ok) return { ok: false, reason: loc.reason }
  view.dispatch({
    changes: { from: loc.start, to: loc.end, insert: anchor.original_text },
    selection: { anchor: loc.start + anchor.original_text.length },
    scrollIntoView: true,
    userEvent: 'undo.proposal',
  })
  return { ok: true, reason: 'unique' }
}

/** 生成请求的选区载荷：选区文本 + 前后各 ≤400 字上下文。 */
export function selectionPayload(
  doc: string,
  from: number,
  to: number,
): { original_text: string; context_before: string; context_after: string } {
  const original = doc.slice(from, to)
  return {
    original_text: original,
    context_before: doc.slice(Math.max(0, from - 400), from),
    context_after: doc.slice(to, to + 400),
  }
}

/** 当前章节范围（\section/\subsection 边界，供「按节生成」）：返回该行所在 section 的起止偏移。 */
export function sectionRange(doc: string, pos: number): { from: number; to: number } | null {
  const lines = doc.split('\n')
  let offset = 0
  let start = -1
  let startOffset = 0
  let endOffset = doc.length
  let level = -1
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const m = /^\\(section|subsection|section\*)\{/.exec(line)
    if (m) {
      const lvl = m[1] === 'subsection' ? 2 : 1
      if (start === -1 && offset <= pos) {
        start = i
        startOffset = offset
        level = lvl
      } else if (start !== -1 && lvl <= level) {
        endOffset = i
        endOffset = offset
        break
      }
    }
    offset += line.length + 1
  }
  if (start === -1) return null
  return { from: startOffset, to: endOffset }
}

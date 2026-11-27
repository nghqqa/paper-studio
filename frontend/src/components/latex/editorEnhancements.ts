import type { MutableRefObject } from 'react'
import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { defaultHighlightStyle, foldService, HighlightStyle } from '@codemirror/language'
import { EditorSelection, StateEffect, StateField, type ChangeSpec, type Range } from '@codemirror/state'
import { Decoration, EditorView, hoverTooltip, type DecorationSet } from '@codemirror/view'
import katex from 'katex'
import type { GlossaryEntry } from '@/lib/api/glossary'
import type { LatexDiagnostic, LatexFileInfo } from '@/lib/api/latex'
import type { CiteCandidate } from './citeCompletions'
import type { ProjectContentIndex } from './editorSearch'

export interface MathPreview {
  tex: string
  displayMode: boolean
}

const MATH_ENV_RE = /\\begin\{(equation\*?|align\*?|gather\*?|multline\*?)\}/g
const CMD_LABEL_TAG_RE = /\\(?:label|tag\*?)\{[^}]*\}/g

function normalizeEnvMath(env: string, inner: string): string {
  const clean = inner.replace(CMD_LABEL_TAG_RE, '').trim()
  if (env === 'align' || env === 'align*') return `\\begin{aligned}${clean}\\end{aligned}`
  if (env === 'gather' || env === 'gather*' || env === 'multline' || env === 'multline*') {
    return `\\begin{gathered}${clean}\\end{gathered}`
  }
  return clean
}

function isEscaped(src: string, idx: number): boolean {
  let bs = 0
  for (let i = idx - 1; i >= 0 && src[i] === '\\'; i--) bs++
  return bs % 2 === 1
}

function stripCommentInLine(line: string): string {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '%' && !isEscaped(line, i)) return line.slice(0, i)
  }
  return line
}

/** 提取光标或选区所在的 TeX 数学公式用于 KaTeX 实时预览；无则返回 null。 */
export function extractMathAtCursor(doc: string, from: number, to: number): MathPreview | null {
  if (!doc) return null

  if (from !== to) {
    const sel = doc.slice(from, to).trim()
    const envM = sel.match(/^\\begin\{(equation\*?|align\*?|gather\*?|multline\*?)\}([\s\S]+)\\end\{\1\}$/)
    if (envM) {
      const tex = normalizeEnvMath(envM[1], envM[2])
      return tex ? { tex, displayMode: true } : null
    }
    if (sel.startsWith('$$') && sel.endsWith('$$') && sel.length > 4) {
      const tex = sel.slice(2, -2).replace(CMD_LABEL_TAG_RE, '').trim()
      return tex ? { tex, displayMode: true } : null
    }
    if (sel.startsWith('\\[') && sel.endsWith('\\]') && sel.length > 4) {
      const tex = sel.slice(2, -2).replace(CMD_LABEL_TAG_RE, '').trim()
      return tex ? { tex, displayMode: true } : null
    }
    if (sel.startsWith('\\(') && sel.endsWith('\\)') && sel.length > 4) {
      const tex = sel.slice(2, -2).trim()
      return tex ? { tex, displayMode: false } : null
    }
    if (/^\$[^$\n]+\$$/.test(sel)) {
      const tex = sel.slice(1, -1).trim()
      return tex ? { tex, displayMode: false } : null
    }
    return null
  }

  const wStart = Math.max(0, from - 4000)
  const wEnd = Math.min(doc.length, from + 4000)
  const slice = doc.slice(wStart, wEnd)
  const pos = from - wStart

  // 1) \begin{equation/align/gather/multline}...\end{...}
  MATH_ENV_RE.lastIndex = 0
  let em: RegExpExecArray | null
  while ((em = MATH_ENV_RE.exec(slice)) !== null) {
    if (em.index > pos) break
    const env = em[1]
    const endToken = `\\end{${env}}`
    const endIdx = slice.indexOf(endToken, em.index + em[0].length)
    if (endIdx !== -1 && pos <= endIdx + endToken.length) {
      const tex = normalizeEnvMath(env, slice.slice(em.index + em[0].length, endIdx))
      return tex ? { tex, displayMode: true } : null
    }
  }

  // 2) $$...$$ 与 \[...\]
  let i = 0
  while (i < slice.length) {
    if (slice[i] === '%' && !isEscaped(slice, i)) {
      const nl = slice.indexOf('\n', i)
      i = nl === -1 ? slice.length : nl + 1
      continue
    }
    if (slice[i] === '$' && slice[i + 1] === '$' && !isEscaped(slice, i)) {
      let end = i + 2
      while (end < slice.length - 1) {
        if (slice[end] === '$' && slice[end + 1] === '$' && !isEscaped(slice, end)) break
        end++
      }
      if (end < slice.length - 1 && slice[end] === '$' && slice[end + 1] === '$') {
        if (pos >= i && pos <= end + 2) {
          const tex = slice.slice(i + 2, end).replace(CMD_LABEL_TAG_RE, '').trim()
          return tex ? { tex, displayMode: true } : null
        }
        i = end + 2
        continue
      }
    }
    if (slice[i] === '\\' && slice[i + 1] === '[' && !isEscaped(slice, i)) {
      let end = i + 2
      while (end < slice.length - 1) {
        if (slice[end] === '\\' && slice[end + 1] === ']' && !isEscaped(slice, end)) break
        end++
      }
      if (end < slice.length - 1 && slice[end] === '\\' && slice[end + 1] === ']') {
        if (pos >= i && pos <= end + 2) {
          const tex = slice.slice(i + 2, end).replace(CMD_LABEL_TAG_RE, '').trim()
          return tex ? { tex, displayMode: true } : null
        }
        i = end + 2
        continue
      }
    }
    i++
  }

  // 3) 单行行内公式 \(...\) 或 $...$（忽略 \% 与 \$）
  const lineStart = doc.lastIndexOf('\n', Math.max(0, from - 1)) + 1
  const nextNl = doc.indexOf('\n', from)
  const rawLineEnd = nextNl === -1 ? doc.length : nextNl
  const activeLine = stripCommentInLine(doc.slice(lineStart, rawLineEnd))
  const col = from - lineStart
  if (col > activeLine.length) return null

  let j = 0
  while (j < activeLine.length) {
    if (activeLine[j] === '\\' && activeLine[j + 1] === '(' && !isEscaped(activeLine, j)) {
      let end = j + 2
      while (end < activeLine.length - 1) {
        if (activeLine[end] === '\\' && activeLine[end + 1] === ')' && !isEscaped(activeLine, end)) break
        end++
      }
      if (end < activeLine.length - 1 && activeLine[end] === '\\' && activeLine[end + 1] === ')') {
        if (col >= j && col <= end + 2) {
          const tex = activeLine.slice(j + 2, end).trim()
          return tex ? { tex, displayMode: false } : null
        }
        j = end + 2
        continue
      }
    }
    if (activeLine[j] === '$' && activeLine[j + 1] !== '$' && !isEscaped(activeLine, j)) {
      let end = j + 1
      while (end < activeLine.length) {
        if (activeLine[end] === '$' && activeLine[end + 1] !== '$' && !isEscaped(activeLine, end)) break
        end++
      }
      if (end < activeLine.length && activeLine[end] === '$') {
        if (col >= j && col <= end + 1) {
          const tex = activeLine.slice(j + 1, end).trim()
          return tex ? { tex, displayMode: false } : null
        }
        j = end + 1
        continue
      }
    }
    j++
  }

  return null
}

/** 包装当前选区（或插入前后缀并将光标停在中央），用于 Ctrl/Cmd+B 与 Ctrl/Cmd+I。 */
export function wrapSelectionCommand(prefix: string, suffix: string) {
  return (view: EditorView): boolean => {
    if (view.state.readOnly) return false
    const tr = view.state.changeByRange((range) => {
      const selected = view.state.sliceDoc(range.from, range.to)
      const insert = `${prefix}${selected}${suffix}`
      return {
        changes: { from: range.from, to: range.to, insert },
        range: selected
          ? EditorSelection.range(range.from + prefix.length, range.to + prefix.length)
          : EditorSelection.cursor(range.from + prefix.length),
      }
    })
    view.dispatch(tr)
    return true
  }
}

/** 切换所选行（或当前行）的 LaTeX `% ` 行注释（Mod-/）。 */
export function toggleLatexComment(view: EditorView): boolean {
  if (view.state.readOnly) return false
  const doc = view.state.doc
  const lineNums = new Set<number>()
  for (const range of view.state.selection.ranges) {
    const startLine = doc.lineAt(range.from).number
    const endPos = range.to > range.from && doc.lineAt(range.to).from === range.to ? range.to - 1 : range.to
    const endLine = doc.lineAt(endPos).number
    for (let ln = startLine; ln <= endLine; ln++) lineNums.add(ln)
  }
  const ordered = [...lineNums].sort((a, b) => a - b)
  const nonBlank = ordered.map((ln) => doc.line(ln)).filter((l) => l.text.trim().length > 0)
  if (nonBlank.length === 0) return false
  const allCommented = nonBlank.every((l) => /^\s*%/.test(l.text))
  const changes: ChangeSpec[] = []
  if (allCommented) {
    for (const l of nonBlank) {
      const m = /^(\s*)%\s?/.exec(l.text)
      if (m) {
        const delFrom = l.from + m[1].length
        changes.push({ from: delFrom, to: l.from + m[0].length, insert: '' })
      }
    }
  } else {
    for (const l of ordered.map((ln) => doc.line(ln))) {
      const indent = /^\s*/.exec(l.text)?.[0] ?? ''
      if (l.text.trim().length === 0 && nonBlank.length > 1) continue
      changes.push({ from: l.from + indent.length, to: l.from + indent.length, insert: '% ' })
    }
  }
  if (!changes.length) return false
  view.dispatch({ changes })
  return true
}

const FOLD_HEADING_RANK: Record<string, number> = {
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
}

/** LaTeX 结构折叠：\begin{env}...\end{env} 与 \chapter/\section/\subsection 区块折叠。 */
export const latexFoldService = foldService.of((state, lineStart) => {
  const doc = state.doc
  const startLine = doc.lineAt(lineStart)
  const text = stripCommentInLine(startLine.text)

  const beginMatch = /^\s*\\begin\{([A-Za-z0-9_*]+)\}/.exec(text)
  if (beginMatch && beginMatch[1] !== 'document') {
    const env = beginMatch[1]
    const esc = env.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const bRe = new RegExp(`\\\\begin\\{${esc}\\}`, 'g')
    const eRe = new RegExp(`\\\\end\\{${esc}\\}`, 'g')
    let depth = 0
    for (let ln = startLine.number; ln <= doc.lines; ln++) {
      const clean = stripCommentInLine(doc.line(ln).text)
      depth += (clean.match(bRe) ?? []).length
      depth -= (clean.match(eRe) ?? []).length
      if (depth <= 0 && ln > startLine.number) {
        return { from: startLine.to, to: doc.line(ln).to }
      }
    }
    return null
  }

  const secMatch = /^\s*\\(part|chapter|section|subsection|subsubsection)\*?[\[{]/.exec(text)
  if (secMatch) {
    const rank = FOLD_HEADING_RANK[secMatch[1]] ?? 2
    let lastLine = doc.lines
    for (let ln = startLine.number + 1; ln <= doc.lines; ln++) {
      const clean = stripCommentInLine(doc.line(ln).text)
      if (/^\s*\\end\{document\}/.test(clean)) {
        lastLine = ln - 1
        break
      }
      const nextSec = /^\s*\\(part|chapter|section|subsection|subsubsection)\*?[\[{]/.exec(clean)
      if (nextSec && (FOLD_HEADING_RANK[nextSec[1]] ?? 2) <= rank) {
        lastLine = ln - 1
        break
      }
    }
    while (lastLine > startLine.number && !doc.line(lastLine).text.trim()) lastLine--
    if (lastLine > startLine.number) {
      return { from: startLine.to, to: doc.line(lastLine).to }
    }
  }
  return null
})

interface TexCmdSpec {
  label: string
  detail: string
  insert: string
  cursorOffset: number
}

const TEX_COMMANDS: TexCmdSpec[] = [
  { label: '\\section', detail: '一级节标题', insert: '\\section{}', cursorOffset: 9 },
  { label: '\\subsection', detail: '二级小节', insert: '\\subsection{}', cursorOffset: 12 },
  { label: '\\subsubsection', detail: '三级小节', insert: '\\subsubsection{}', cursorOffset: 15 },
  { label: '\\textbf', detail: '粗体', insert: '\\textbf{}', cursorOffset: 8 },
  { label: '\\textit', detail: '斜体', insert: '\\textit{}', cursorOffset: 8 },
  { label: '\\emph', detail: '强调', insert: '\\emph{}', cursorOffset: 6 },
  { label: '\\cite', detail: '文献引用', insert: '\\cite{}', cursorOffset: 6 },
  { label: '\\citep', detail: '括号引用', insert: '\\citep{}', cursorOffset: 7 },
  { label: '\\citet', detail: '作者主语引用', insert: '\\citet{}', cursorOffset: 7 },
  { label: '\\ref', detail: '交叉引用', insert: '\\ref{}', cursorOffset: 5 },
  { label: '\\eqref', detail: '公式编号引用', insert: '\\eqref{}', cursorOffset: 7 },
  { label: '\\label', detail: '定义锚点标签', insert: '\\label{}', cursorOffset: 7 },
  { label: '\\footnote', detail: '脚注', insert: '\\footnote{}', cursorOffset: 10 },
  { label: '\\includegraphics', detail: '插入图片', insert: '\\includegraphics[width=0.8\\linewidth]{}', cursorOffset: 38 },
  { label: '\\frac', detail: '分式', insert: '\\frac{}{}', cursorOffset: 6 },
  { label: '\\sum', detail: '求和', insert: '\\sum_{i=1}^{n} ', cursorOffset: 15 },
  { label: '\\begin{equation}', detail: '编号公式环境', insert: '\\begin{equation}\n  \n\\end{equation}', cursorOffset: 19 },
  { label: '\\begin{align}', detail: '多行对齐公式', insert: '\\begin{align}\n  \n\\end{align}', cursorOffset: 16 },
  { label: '\\begin{figure}', detail: '浮动图环境', insert: '\\begin{figure}[htbp]\n  \\centering\n  \n  \\caption{}\n  \\label{fig:}\n\\end{figure}', cursorOffset: 36 },
  { label: '\\begin{table}', detail: '浮动表环境', insert: '\\begin{table}[htbp]\n  \\centering\n  \\caption{}\n  \\label{tab:}\n  \n\\end{table}', cursorOffset: 63 },
  { label: '\\begin{itemize}', detail: '无序列表', insert: '\\begin{itemize}\n  \\item \n\\end{itemize}', cursorOffset: 24 },
  { label: '\\begin{enumerate}', detail: '有序列表', insert: '\\begin{enumerate}\n  \\item \n\\end{enumerate}', cursorOffset: 26 },
]

/** 通用 LaTeX 命令与常用环境补全源（\begin{...} 自动闭合 \end{...}）。 */
export function makeLatexCommandSource() {
  return (ctx: CompletionContext): CompletionResult | null => {
    const m = ctx.matchBefore(/\\[A-Za-z{}]*$/)
    if (!m || m.text.startsWith('\\cite') && m.text.includes('{')) return null
    if (m.text.includes('{') && !m.text.startsWith('\\begin{')) return null
    const typed = m.text.toLowerCase()
    if (typed.length < 2 && !ctx.explicit) return null
    const opts = TEX_COMMANDS.filter((c) => c.label.toLowerCase().startsWith(typed)).map((c) => ({
      label: c.label,
      detail: c.detail,
      type: 'keyword',
      apply: (view: EditorView, _comp: unknown, from: number, to: number) => {
        view.dispatch({
          changes: { from, to, insert: c.insert },
          selection: EditorSelection.cursor(from + c.cursorOffset),
        })
      },
    }))
    if (!opts.length) return null
    return { from: m.from, options: opts, validFor: /^\\[A-Za-z{}]*$/ }
  }
}

/** 项目术语表与自定义符号补全源（匹配 term / symbol / 别名提示规范写法）。 */
export function makeGlossarySource(glossaryRef: MutableRefObject<GlossaryEntry[]>) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const entries = glossaryRef.current
    if (!entries.length) return null
    const m = ctx.matchBefore(/(?:\\[A-Za-z@]+(?:\{[A-Za-z0-9_]*\}?)?|[\u4e00-\u9fff]{1,}|[A-Za-z0-9_-]{2,})$/)
    if (!m) return null
    const typed = m.text.toLowerCase()
    const opts = entries
      .filter(
        (e) =>
          e.term.toLowerCase().includes(typed) ||
          e.symbol.toLowerCase().includes(typed) ||
          e.aliases.some((a) => a.toLowerCase().includes(typed)),
      )
      .slice(0, 20)
      .map((e) => {
        const insert = e.symbol || e.term
        return {
          label: insert,
          detail: e.symbol && e.symbol !== e.term ? `${e.term}（术语表）` : '术语表规范',
          info: e.definition || undefined,
          type: 'variable',
          apply: insert,
        }
      })
    if (!opts.length) return null
    return { from: m.from, options: opts }
  }
}

const HL_CLASSES: Record<number, string> = {
  0: 'cm-tok-meta',
  6: 'cm-tok-keyword',
  7: 'cm-tok-atom',
  8: 'cm-tok-literal',
  9: 'cm-tok-string',
  10: 'cm-tok-escape',
  11: 'cm-tok-var',
  12: 'cm-tok-var',
  13: 'cm-tok-type',
  14: 'cm-tok-type',
  15: 'cm-tok-macro',
  16: 'cm-tok-var',
  17: 'cm-tok-comment',
  18: 'cm-tok-invalid',
}

/** 适配亮/暗源码主题的 CodeMirror 语法高亮（颜色由 CSS 变量控制）。 */
export const latexHighlightStyle = HighlightStyle.define(
  defaultHighlightStyle.specs.map((spec, idx) =>
    HL_CLASSES[idx] ? { tag: spec.tag, class: HL_CLASSES[idx] } : spec,
  ),
)

/** 沿主文件 \input / \include 递归统计整篇论文的字数与文件数（去重防环）。 */
export function computeWholeDocStats(
  mainPath: string,
  contentIndex: ProjectContentIndex,
  activePath: string | null,
  activeContent: string,
): { cjk: number; words: number; fileCount: number } | null {
  if (!mainPath || !contentIndex.ready) return null
  const getText = (p: string): string | undefined => {
    if (activePath && p === activePath) return activeContent
    return contentIndex.getFileContent(p)
  }
  const resolveInclude = (fromPath: string, rawTarget: string): string | null => {
    const clean = rawTarget.trim().replace(/^\.\//, '')
    if (!clean) return null
    const dir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/') + 1) : ''
    for (const c of [clean, clean.endsWith('.tex') ? clean : `${clean}.tex`, `${dir}${clean}`, `${dir}${clean.endsWith('.tex') ? clean : `${clean}.tex`}`]) {
      if (getText(c) !== undefined) return c
    }
    return null
  }
  const visited = new Set<string>()
  const incRe = /\\(?:input|include)\{([^}]+)\}/g
  let cjk = 0
  let words = 0
  const walk = (p: string) => {
    if (visited.has(p)) return
    const text = getText(p)
    if (text === undefined) return
    visited.add(p)
    cjk += (text.match(/[\u4e00-\u9fff]/g) ?? []).length
    words += (text.match(/[A-Za-z0-9]+/g) ?? []).length
    for (const line of text.split('\n')) {
      const noComment = stripCommentInLine(line)
      incRe.lastIndex = 0
      let im: RegExpExecArray | null
      while ((im = incRe.exec(noComment)) !== null) {
        const tgt = resolveInclude(p, im[1])
        if (tgt) walk(tgt)
      }
    }
  }
  walk(mainPath)
  if (visited.size === 0) return null
  return { cjk, words, fileCount: visited.size }
}

export const setDiagnosticsEffect = StateEffect.define<LatexDiagnostic[]>()

interface DiagnosticsState {
  items: LatexDiagnostic[]
  decos: DecorationSet
}

function buildDiagDecorations(items: LatexDiagnostic[], doc: EditorView['state']['doc']): DecorationSet {
  const byLine = new Set<number>()
  for (const d of items) {
    if (d.line == null) continue
    byLine.add(Math.min(Math.max(1, d.line), doc.lines))
  }
  const sorted = [...byLine].sort((a, b) => a - b)
  const ranges: Range<Decoration>[] = []
  for (const ln of sorted) {
    const lineObj = doc.line(ln)
    if (lineObj.to > lineObj.from) {
      ranges.push(Decoration.mark({ class: 'cm-latex-diag-line' }).range(lineObj.from, lineObj.to))
    } else {
      ranges.push(Decoration.line({ attributes: { class: 'cm-latex-diag-line-empty' } }).range(lineObj.from))
    }
  }
  return Decoration.set(ranges, true)
}

export const diagnosticsField = StateField.define<DiagnosticsState>({
  create() {
    return { items: [], decos: Decoration.none }
  },
  update(val, tr) {
    for (const eff of tr.effects) {
      if (eff.is(setDiagnosticsEffect)) {
        return { items: eff.value, decos: buildDiagDecorations(eff.value, tr.state.doc) }
      }
    }
    if (tr.docChanged && val.items.length > 0) {
      return { items: val.items, decos: val.decos.map(tr.changes) }
    }
    return val
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decos),
})

export function diagnosticsHoverExtension(
  canEdit: boolean,
  onProposeFixRef: MutableRefObject<((diag: LatexDiagnostic) => void) | undefined>,
) {
  return hoverTooltip((view, pos) => {
    const diagState = view.state.field(diagnosticsField, false)
    if (!diagState || !diagState.items.length) return null
    const lineObj = view.state.doc.lineAt(pos)
    const hits = diagState.items.filter((d) => d.line === lineObj.number)
    if (!hits.length) return null
    return {
      pos: lineObj.from,
      end: Math.max(lineObj.to, lineObj.from),
      above: true,
      create() {
        const dom = document.createElement('div')
        dom.className = 'cm-latex-tooltip cm-latex-tooltip-diag'
        const title = document.createElement('div')
        title.className = 'cm-latex-tooltip-title'
        title.textContent = `编译诊断 · 第 ${lineObj.number} 行`
        dom.appendChild(title)
        for (const h of hits.slice(0, 3)) {
          const p = document.createElement('p')
          p.className = 'cm-latex-tooltip-meta'
          p.textContent = h.message
          dom.appendChild(p)
        }
        if (canEdit && onProposeFixRef.current) {
          const btn = document.createElement('button')
          btn.type = 'button'
          btn.className = 'cm-latex-tooltip-btn'
          btn.textContent = 'AI 修复提案'
          btn.onclick = () => onProposeFixRef.current?.(hits[0])
          dom.appendChild(btn)
        }
        return { dom }
      },
    }
  })
}

function findCommaTokenAt(body: string, relCol: number): string | null {
  let cursor = 0
  for (const part of body.split(',')) {
    const start = cursor
    const end = cursor + part.length
    if (relCol >= start && relCol <= end) {
      const k = part.trim()
      return k || null
    }
    cursor = end + 1
  }
  return null
}

function lineNumberAt(src: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < src.length; i++) {
    if (src[i] === '\n') line++
  }
  return line
}

function extractBalancedBraced(src: string, openBraceIdx: number): string | null {
  if (src[openBraceIdx] !== '{') return null
  let depth = 0
  for (let i = openBraceIdx; i < src.length; i++) {
    const ch = src[i]
    if (ch === '\\') {
      i++
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return src.slice(openBraceIdx + 1, i)
    }
  }
  return null
}

function findCaptionText(src: string): string | null {
  const m = /\\caption(?:\s*\[[^\]]*\])?\s*\{/.exec(src)
  if (!m) return null
  const inner = extractBalancedBraced(src, m.index + m[0].length - 1)
  return inner ? inner.replace(/\s+/g, ' ').trim() : null
}

export function extractRefContext(content: string, hitLine: number): { kind: 'caption' | 'math' | 'snippet'; text: string } {
  const lines = content.split('\n')
  if (hitLine < 1 || hitLine > lines.length) return { kind: 'snippet', text: '' }

  // 1) 仅当 \label 真正位于公式环境内部时，才按公式渲染预览
  const mathEnvRe = /\\begin\{(equation\*?|align\*?|gather\*?|multline\*?)\}([\s\S]*?)\\end\{\1\}/g
  let mm: RegExpExecArray | null
  while ((mm = mathEnvRe.exec(content)) !== null) {
    const startLine = lineNumberAt(content, mm.index)
    const endLine = lineNumberAt(content, mm.index + mm[0].length)
    if (hitLine >= startLine && hitLine <= endLine) {
      const tex = normalizeEnvMath(mm[1], mm[2])
      if (tex) return { kind: 'math', text: tex }
    }
  }

  // 2) 当 \label 位于 figure / table 浮动体内时，仅从该浮动体提取 \caption
  const floatRe = /\\begin\{((?:figure|table)\*?)\}([\s\S]*?)\\end\{\1\}/g
  let fm: RegExpExecArray | null
  while ((fm = floatRe.exec(content)) !== null) {
    const startLine = lineNumberAt(content, fm.index)
    const endLine = lineNumberAt(content, fm.index + fm[0].length)
    if (hitLine >= startLine && hitLine <= endLine) {
      const cap = findCaptionText(fm[2])
      if (cap) return { kind: 'caption', text: cap }
    }
  }

  // 3) 兜底：同/前一行若为章节标题或裸 caption 则提取之，否则返回目标行源码
  const nearLines = lines.slice(Math.max(0, hitLine - 2), Math.min(lines.length, hitLine + 1)).join('\n')
  const capNear = findCaptionText(nearLines)
  if (capNear) return { kind: 'caption', text: capNear }

  return { kind: 'snippet', text: (lines[hitLine - 1] ?? '').trim() }
}

function resolveGraphicsFile(target: string, activePath: string | null, files: LatexFileInfo[]): string | null {
  const clean = target.trim().replace(/^\.\//, '')
  if (!clean) return null
  const all = new Set(files.map((f) => f.path))
  const dir = activePath && activePath.includes('/') ? activePath.slice(0, activePath.lastIndexOf('/') + 1) : ''
  const bases = [clean, `figures/${clean}`, dir ? `${dir}${clean}` : ''].filter(Boolean)
  const exts = ['', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.pdf']
  for (const base of bases) {
    for (const ext of exts) {
      const cand = `${base}${ext}`
      if (all.has(cand)) return cand
    }
  }
  return null
}

export function latexHoverTooltipExtension({
  pid,
  activeRef,
  citeDataRef,
  contentIndex,
  filesRef,
  glossaryRef,
}: {
  pid: string
  activeRef: MutableRefObject<string | null>
  citeDataRef: MutableRefObject<{ cites: CiteCandidate[] }>
  contentIndex: ProjectContentIndex
  filesRef: MutableRefObject<LatexFileInfo[]>
  glossaryRef?: MutableRefObject<GlossaryEntry[]>
}) {
  return hoverTooltip((view, pos) => {
    const lineObj = view.state.doc.lineAt(pos)
    const text = lineObj.text
    const col = pos - lineObj.from

    // 1) \cite...{...}
    const citeRe = /\\([a-zA-Z]*[cC]ite[a-zA-Z]*)\*?(?:\[[^\]]*\])*\{([^}]*)\}/g
    let m: RegExpExecArray | null
    while ((m = citeRe.exec(text)) !== null) {
      const braceStart = m.index + m[0].indexOf('{') + 1
      const braceEnd = braceStart + m[2].length
      if (col >= braceStart && col <= braceEnd) {
        const key = findCommaTokenAt(m[2], col - braceStart)
        if (!key) return null
        const hit = citeDataRef.current.cites.find((c) => c.citation_key === key)
        return {
          pos: lineObj.from + m.index,
          end: lineObj.from + m.index + m[0].length,
          above: true,
          create() {
            const dom = document.createElement('div')
            dom.className = 'cm-latex-tooltip'
            const title = document.createElement('div')
            title.className = 'cm-latex-tooltip-title'
            title.textContent = hit ? hit.title || key : `未找到文献：${key}`
            dom.appendChild(title)
            const meta = document.createElement('p')
            meta.className = 'cm-latex-tooltip-meta'
            if (hit) {
              const authors = (hit.authors || []).slice(0, 3).join(', ')
              meta.textContent = `${key}${authors ? ` · ${authors}` : ''}${hit.year ? ` (${hit.year})` : ''}`
            } else {
              meta.textContent = '请检查 .bib 键名拼写或导入对应文献'
            }
            dom.appendChild(meta)
            return { dom }
          },
        }
      }
    }

    // 2) \ref / \eqref / \autoref / \cref / \Cref
    const refRe = /\\(?:[Cc]?ref|eqref|autoref|pageref)\{([^}]*)\}/g
    while ((m = refRe.exec(text)) !== null) {
      const braceStart = m.index + m[0].indexOf('{') + 1
      const braceEnd = braceStart + m[1].length
      if (col >= braceStart && col <= braceEnd) {
        const key = findCommaTokenAt(m[1], col - braceStart)
        if (!key) return null
        const hit = contentIndex.collectLabels().find((l) => l.name === key)
        const ctx = hit ? extractRefContext(contentIndex.getFileContent(hit.file) ?? '', hit.line) : null
        return {
          pos: lineObj.from + m.index,
          end: lineObj.from + m.index + m[0].length,
          above: true,
          create() {
            const dom = document.createElement('div')
            dom.className = 'cm-latex-tooltip'
            const title = document.createElement('div')
            title.className = 'cm-latex-tooltip-title'
            title.textContent = hit ? `${key} · ${hit.file}:${hit.line}` : `未定义标签：${key}`
            dom.appendChild(title)
            if (ctx) {
              if (ctx.kind === 'math') {
                const mathBox = document.createElement('div')
                mathBox.className = 'cm-latex-tooltip-math'
                katex.render(ctx.text, mathBox, { throwOnError: false, displayMode: true })
                dom.appendChild(mathBox)
              } else {
                const p = document.createElement('p')
                p.className = 'cm-latex-tooltip-meta'
                p.textContent = ctx.kind === 'caption' ? `图注/表注：${ctx.text}` : ctx.text
                dom.appendChild(p)
              }
            }
            return { dom }
          },
        }
      }
    }

    // 3) \includegraphics / \includesvg
    const gfxRe = /\\(?:includegraphics|includesvg)(?:\s*\[[^\]]*\])?\s*\{([^}]+)\}/g
    while ((m = gfxRe.exec(text)) !== null) {
      const braceStart = m.index + m[0].indexOf('{') + 1
      const braceEnd = braceStart + m[1].length
      if (col >= m.index && col <= braceEnd) {
        const target = m[1].trim()
        const resolved = resolveGraphicsFile(target, activeRef.current, filesRef.current)
        return {
          pos: lineObj.from + m.index,
          end: lineObj.from + m.index + m[0].length,
          above: true,
          create() {
            const dom = document.createElement('div')
            dom.className = 'cm-latex-tooltip'
            const title = document.createElement('div')
            title.className = 'cm-latex-tooltip-title'
            title.textContent = resolved ? `图片：${resolved}` : `未找到图片：${target}`
            dom.appendChild(title)
            if (resolved && /\.(png|jpe?g|webp|svg|gif)$/i.test(resolved)) {
              const img = document.createElement('img')
              img.className = 'cm-latex-tooltip-img'
              img.alt = resolved
              img.src = `/api/projects/${encodeURIComponent(pid)}/latex/raw/${resolved.split('/').map(encodeURIComponent).join('/')}`
              dom.appendChild(img)
            } else if (resolved) {
              const meta = document.createElement('p')
              meta.className = 'cm-latex-tooltip-meta'
              meta.textContent = '矢量图文件已存在于工程内（PDF 预览暂不渲染缩略图）'
              dom.appendChild(meta)
            }
            return { dom }
          },
        }
      }
    }

    // 4) 项目术语表 / 符号 / 弃用别名悬停提示（支持中文、多词短语与带花括号 LaTeX 命令）
    const gEntries = glossaryRef?.current ?? []
    if (gEntries.length > 0) {
      const textLow = text.toLowerCase()
      const isAsciiWord = (ch: string | undefined) => Boolean(ch && /[A-Za-z0-9_]/.test(ch))
      let best: {
        entry: GlossaryEntry
        tok: string
        isDeprecated: boolean
        start: number
        end: number
      } | null = null
      for (const e of gEntries) {
        const candidates: Array<{ needle: string; isDeprecated: boolean }> = []
        for (const a of e.aliases) {
          const s = a.trim()
          if (s) candidates.push({ needle: s, isDeprecated: true })
        }
        for (const raw of [e.term, e.symbol]) {
          const s = raw.trim()
          if (s) candidates.push({ needle: s, isDeprecated: false })
        }
        for (const cand of candidates) {
          const { needle, isDeprecated } = cand
          const caseSensitive = e.category === 'notation' || needle.startsWith('\\')
          const hay = caseSensitive ? text : textLow
          const sub = caseSensitive ? needle : needle.toLowerCase()
          const checkLeft = isAsciiWord(needle[0])
          const checkRight = isAsciiWord(needle[needle.length - 1])
          let idx = 0
          while ((idx = hay.indexOf(sub, idx)) !== -1) {
            const end = idx + needle.length
            const leftOk = !checkLeft || (idx === 0 || (!isAsciiWord(text[idx - 1]) && text[idx - 1] !== '\\'))
            const rightOk = !checkRight || !isAsciiWord(text[end])
            if (leftOk && rightOk && col >= idx && col <= end) {
              if (
                !best ||
                needle.length > best.tok.length ||
                (needle.length === best.tok.length && isDeprecated && !best.isDeprecated)
              ) {
                best = { entry: e, tok: text.slice(idx, end), isDeprecated, start: idx, end }
              }
            }
            idx += 1
          }
        }
      }
      if (best) {
        const { entry: hit, tok, isDeprecated, start, end } = best
        const spanStart = lineObj.from + start
        const spanEnd = lineObj.from + end
        return {
          pos: spanStart,
          end: spanEnd,
          above: true,
          create() {
            const dom = document.createElement('div')
            dom.className = 'cm-latex-tooltip'
            const title = document.createElement('div')
            title.className = 'cm-latex-tooltip-title'
            title.textContent = isDeprecated
              ? `弃用别名「${tok}」→ 建议「${hit.term}」`
              : `${hit.term}${hit.symbol && hit.symbol !== hit.term ? ` (${hit.symbol})` : ''}`
            dom.appendChild(title)
            if (hit.definition) {
              const p = document.createElement('p')
              p.className = 'cm-latex-tooltip-meta'
              p.textContent = hit.definition
              dom.appendChild(p)
            }
            return { dom }
          },
        }
      }
    }

    return null
  })
}

import type { MutableRefObject } from 'react'
import { EditorSelection, StateEffect, StateField, type Range } from '@codemirror/state'
import { Decoration, EditorView, hoverTooltip, type DecorationSet } from '@codemirror/view'
import katex from 'katex'
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
}: {
  pid: string
  activeRef: MutableRefObject<string | null>
  citeDataRef: MutableRefObject<{ cites: CiteCandidate[] }>
  contentIndex: ProjectContentIndex
  filesRef: MutableRefObject<LatexFileInfo[]>
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

    return null
  })
}

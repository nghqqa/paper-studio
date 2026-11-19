/**
 * 引用补全源（\cite 家族 / \ref 家族）：纯逻辑 CompletionSource，照 threeView.ts 模式
 * 用真实 CompletionContext 无头测试。
 *
 * - \cite{：多键场景（\cite{a,} 后继续补第二个键）由 `(?:[^{},]*,)*` 前缀组支持；
 *   匹配不限定命令——用户手写 \citep/\citet 一样补全；插什么键由调用方给的候选决定；
 * - \ref/\eqref/\autoref/\cref/\Cref{：label 来自工程内容索引（editorSearch.collectLabels）；
 * - validFor：键内继续输入不关弹窗，敲 `,`/`}` 立即关闭。
 *
 * 注意：本项目 @codemirror/autocomplete 6.20.x 的 matchBefore 只返回 {from,to,text}
 * （无 match 分组）——分组须对 m.text 自行 exec（from 已对齐匹配起点，语义等价）。
 */
import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete'

export interface CiteCandidate {
  citation_key: string
  title: string
  authors: string[]
  year: string | null
}

export interface LabelCandidate {
  name: string
  file: string
  line: number
}

const CITE_RE = /\\([a-zA-Z]*[cC]ite[a-zA-Z]*)\{(?:[^{},]*,)*([^{},]*)$/
const REF_RE = /\\(ref|eqref|autoref|cref|Cref)\{([^}]*)$/

export function citeDetail(e: CiteCandidate): string {
  const first = (e.authors || [])[0] || ''
  const authorBit = first ? `${first}${e.authors.length > 1 ? ' et al.' : ''}` : ''
  const who = authorBit && e.year ? `${authorBit} (${e.year})` : authorBit || (e.year ? `(${e.year})` : '')
  const parts = [e.title || '', who].filter(Boolean)
  const text = parts.join(' · ')
  return text.length > 64 ? text.slice(0, 64) + '…' : text
}

interface Option {
  label: string
  detail: string
  type: string
  apply: string
}

export function makeCiteSource(entries: CiteCandidate[]) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const m = ctx.matchBefore(CITE_RE)
    if (!m) return null
    const groups = CITE_RE.exec(m.text)
    if (!groups) return null
    const typed = (groups[2] || '').toLowerCase()
    const seen = new Set<string>()
    const starts: Option[] = []
    const rest: Option[] = []
    for (const e of entries) {
      const key = e.citation_key
      if (!key || seen.has(key)) continue
      if (typed) {
        const hay = `${key} ${e.title || ''}`.toLowerCase()
        if (!hay.includes(typed)) continue
      }
      seen.add(key)
      const opt = { label: key, detail: citeDetail(e), type: 'text', apply: key }
      if (!typed || key.toLowerCase().startsWith(typed)) starts.push(opt)
      else rest.push(opt)
      if (seen.size >= 60) break
    }
    if (!starts.length && !rest.length) return null
    return {
      from: m.to - (groups[2] || '').length,
      options: [...starts, ...rest.slice(0, Math.max(0, 60 - starts.length))],
      validFor: /^[^,}]*$/,
    }
  }
}

export function makeRefSource(labels: LabelCandidate[]) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const m = ctx.matchBefore(REF_RE)
    if (!m) return null
    const groups = REF_RE.exec(m.text)
    if (!groups) return null
    const typed = (groups[2] || '').toLowerCase()
    const seen = new Set<string>()
    const options: Option[] = []
    for (const l of labels) {
      if (!l.name || seen.has(l.name)) continue
      if (typed && !l.name.toLowerCase().includes(typed)) continue
      seen.add(l.name)
      options.push({ label: l.name, detail: `${l.file}:${l.line}`, type: 'text', apply: l.name })
      if (options.length >= 60) break
    }
    if (!options.length) return null
    return {
      from: m.to - (groups[2] || '').length,
      options,
      validFor: /^[^}]*$/,
    }
  }
}

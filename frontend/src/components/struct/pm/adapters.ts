import type { StructBlock, StructContent } from '@/lib/api/struct'

/**
 * StructContent JSON ↔ ProseMirror 节点 JSON 纯函数适配层。
 *
 * 硬约束：
 * - 无编辑时 pmToContent(contentToPM(J)) 与 J **深度相等**（不丢字段/不改字符串/不重生成对象 ID）；
 * - 行内切分规则与后端 structured.py 逐字符一致：
 *     INLINE_MATH_RE = \$([^$]+)\$   （gen_latex/_esc_text 先切数学）
 *     REF_RE         = \[\[(eq|fig|tab):([A-Za-z0-9_-]+)\]\]（_inline_refs 再切引用）
 * - 未完成/不配对公式、转义美元符：按纯文本保留，不吞不改；
 * - 未知顶层字段 → doc.attrs.meta.extra；未知块 → unknown_block（payload 原样）。
 * 本文件全部为纯 JSON↔JSON 函数（不触碰 DOM），可无头测试。
 */

/** 与后端 structured.py INLINE_MATH_RE 完全一致 */
const INLINE_MATH_RE = /\$([^$]+)\$/g
/** 与后端 structured.py REF_RE 完全一致 */
const REF_RE = /\[\[(eq|fig|tab):([A-Za-z0-9_-]+)\]\]/g

type InlineJSON =
  | { type: 'text'; text: string }
  | { type: 'equation_inline'; attrs: { latex: string } }
  | { type: 'ref_inline'; attrs: { kind: 'eq' | 'fig' | 'tab'; targetId: string } }

/** 非数学段内的 [[…]] 引用切分（与后端 _inline_refs 同序） */
function splitRefs(text: string, out: InlineJSON[]): void {
  let last = 0
  for (const m of text.matchAll(REF_RE)) {
    const idx = m.index ?? 0
    if (idx > last) out.push({ type: 'text', text: text.slice(last, idx) })
    out.push({ type: 'ref_inline', attrs: { kind: m[1] as 'eq' | 'fig' | 'tab', targetId: m[2] } })
    last = idx + m[0].length
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) })
}

/** 行内切分：先数学（与后端同序），非数学段再切引用。每个字符恰好归属一个片段。 */
export function parseInline(text: string): InlineJSON[] {
  const out: InlineJSON[] = []
  let last = 0
  for (const m of (text || '').matchAll(INLINE_MATH_RE)) {
    const idx = m.index ?? 0
    if (idx > last) splitRefs(text.slice(last, idx), out)
    out.push({ type: 'equation_inline', attrs: { latex: m[1] } })
    last = idx + m[0].length
  }
  if (last < text.length) splitRefs(text.slice(last), out)
  return out
}

/** 行内节点 → 原始字符串（parseInline 的精确逆） */
export function inlineToText(nodes: InlineJSON[] | undefined | null): string {
  let out = ''
  for (const n of nodes ?? []) {
    if (n.type === 'text') out += n.text
    else if (n.type === 'equation_inline') out += `$${n.attrs.latex}$`
    else out += `[[${n.attrs.kind}:${n.attrs.targetId}]]`
  }
  return out
}

type BlockJSON = Record<string, unknown> & {
  type: string
  content?: InlineJSON[]
  attrs?: Record<string, unknown>
}

/** StructContent → PM 节点 JSON（配合 structSchema.nodeFromJSON 使用） */
export function contentToPM(content: StructContent): Record<string, unknown> {
  const blocks: BlockJSON[] = []
  blocks.push({
    type: 'title_block',
    attrs: {
      title: content.title ?? '',
      title_en: content.title_en ?? '',
      authors: content.authors ?? '',
      affil: content.affil ?? '',
      keywords: content.keywords ?? '',
    },
  })
  if ((content.abstract_zh ?? '') !== '')
    blocks.push({ type: 'abstract_block', attrs: { lang: 'zh' }, content: parseInline(content.abstract_zh ?? '') })
  if ((content.abstract_en ?? '') !== '')
    blocks.push({ type: 'abstract_block', attrs: { lang: 'en' }, content: parseInline(content.abstract_en ?? '') })

  for (const b of content.body ?? []) {
    const t = (b as { type: string }).type
    if (t === 'h1' || t === 'h2') {
      blocks.push({ type: 'heading', attrs: { level: t === 'h1' ? 1 : 2 }, content: parseInline((b as { text?: string }).text ?? '') })
    } else if (t === 'p') {
      blocks.push({ type: 'paragraph', content: parseInline((b as { text?: string }).text ?? '') })
    } else if (t === 'formula') {
      const { type: _t, id, latex, ...rest } = b as { type: string; id: string; latex: string } & Record<string, unknown>
      blocks.push({ type: 'formula', attrs: { objectId: id, latex, extra: Object.keys(rest).length ? rest : null } })
    } else if (t === 'figure') {
      const { type: _t, id, resource, caption, ...rest } = b as { type: string; id: string; resource: string; caption: string } & Record<string, unknown>
      blocks.push({ type: 'figure', attrs: { objectId: id, resource: resource ?? '', caption: caption ?? '', extra: Object.keys(rest).length ? rest : null } })
    } else if (t === 'table') {
      const { type: _t, id, caption, header, rows, ...rest } = b as { type: string; id: string; caption: string; header: string[]; rows: string[][] } & Record<string, unknown>
      blocks.push({ type: 'struct_table', attrs: { objectId: id, caption: caption ?? '', header: header ?? [], rows: rows ?? [], extra: Object.keys(rest).length ? rest : null } })
    } else {
      // 未知块：整块 payload 原样保真（只读占位）
      blocks.push({ type: 'unknown_block', attrs: { blockType: t, payload: JSON.stringify(b) } })
    }
  }

  const meta: Record<string, unknown> = {
    schema_version: content.schema_version ?? 1,
    title: content.title ?? '',
    title_en: content.title_en ?? '',
    authors: content.authors ?? '',
    affil: content.affil ?? '',
    keywords: content.keywords ?? '',
  }
  const KNOWN_META = new Set(Object.keys(meta))
  const extra: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(content as unknown as Record<string, unknown>)) {
    if (!KNOWN_META.has(k) && k !== 'body') extra[k] = v
  }
  meta.extra = extra

  return { type: 'doc', attrs: { meta }, content: blocks }
}

/** PM 节点 JSON → StructContent（contentToPM 的精确逆；无编辑时深度相等） */
export function pmToContent(doc: {
  attrs?: { meta?: Record<string, unknown> }
  content?: BlockJSON[]
}): StructContent {
  const meta = (doc.attrs?.meta ?? {}) as Record<string, unknown>
  const body: StructBlock[] = []
  let abstract_zh = ''
  let abstract_en = ''

  for (const node of doc.content ?? []) {
    const t = node.type
    if (t === 'title_block') {
      const a = (node.attrs ?? {}) as Record<string, string>
      meta.title = a.title ?? ''
      meta.title_en = a.title_en ?? ''
      meta.authors = a.authors ?? ''
      meta.affil = a.affil ?? ''
      meta.keywords = a.keywords ?? ''
    } else if (t === 'abstract_block') {
      const text = inlineToText(node.content)
      if ((node.attrs as { lang?: string })?.lang === 'en') abstract_en = text
      else abstract_zh = text
    } else if (t === 'heading') {
      const level = ((node.attrs as { level?: number })?.level ?? 1) === 1 ? 'h1' : 'h2'
      body.push({ type: level, text: inlineToText(node.content) } as StructBlock)
    } else if (t === 'paragraph') {
      body.push({ type: 'p', text: inlineToText(node.content) } as StructBlock)
    } else if (t === 'formula') {
      const a = (node.attrs ?? {}) as { objectId: string; latex: string; extra: Record<string, unknown> | null }
      body.push({ type: 'formula', id: a.objectId, latex: a.latex, ...(a.extra ?? {}) } as unknown as StructBlock)
    } else if (t === 'figure') {
      const a = (node.attrs ?? {}) as { objectId: string; resource: string; caption: string; extra: Record<string, unknown> | null }
      body.push({ type: 'figure', id: a.objectId, resource: a.resource, caption: a.caption, ...(a.extra ?? {}) } as unknown as StructBlock)
    } else if (t === 'struct_table') {
      const a = (node.attrs ?? {}) as { objectId: string; caption: string; header: string[][]; rows: string[][]; extra: Record<string, unknown> | null }
      body.push({ type: 'table', id: a.objectId, caption: a.caption, header: a.header, rows: a.rows, ...(a.extra ?? {}) } as unknown as StructBlock)
    } else if (t === 'unknown_block') {
      const a = (node.attrs ?? {}) as { payload: string }
      try {
        body.push(JSON.parse(a.payload) as StructBlock)
      } catch {
        // payload 损坏属编辑器内部错误：宁可不保存也不静默删内容
        throw new Error(`未知块内容损坏（${(node.attrs as { blockType?: string })?.blockType ?? '?'}），已阻止保存`)
      }
    }
  }

  const { extra, ...known } = meta
  const content: StructContent = {
    schema_version: (known.schema_version as number) ?? 1,
    title: (known.title as string) ?? '',
    title_en: (known.title_en as string) ?? '',
    authors: (known.authors as string) ?? '',
    affil: (known.affil as string) ?? '',
    abstract_zh,
    abstract_en,
    keywords: (known.keywords as string) ?? '',
    body,
  }
  for (const [k, v] of Object.entries((extra as Record<string, unknown>) ?? {})) {
    ;(content as unknown as Record<string, unknown>)[k] = v
  }
  return content
}

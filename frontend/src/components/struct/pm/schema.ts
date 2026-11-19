import { Schema } from 'prosemirror-model'

/**
 * 结构化中文论文 · ProseMirror Schema（v0.2 连续编辑）。
 *
 * 协议边界（不可破坏）：
 * - JSON 协议 schema_version=1 不变；标题/正文块无持久 ID，公式/图/表沿用对象 ID；
 * - 行内公式 `$…$` 与引用 `[[eq|fig|tab:id]]` 为 Inline Atom，序列化还原原始标记；
 * - 无编辑时 serialize(deserialize(J)) 必须 deepEqual J（未知字段/未知块原样保真）。
 * 行内切分规则与后端 structured.py 完全一致（INLINE_MATH_RE / REF_RE），见 adapters.ts。
 */

export interface StructMeta {
  schema_version: number
  title: string
  title_en: string
  authors: string
  affil: string
  keywords: string
  /** 协议演进而来的未知顶层字段：原样保真回写 */
  extra: Record<string, unknown>
}

export const structSchema = new Schema({
  nodes: {
    doc: {
      content: 'block+',
      attrs: { meta: { default: null } },
    },
    // 题区：6 个纯文本字段（导出侧 _esc_text 不含行内语义），表单式呈现
    title_block: {
      group: 'block',
      atom: true,
      selectable: true,
      attrs: {
        title: { default: '' },
        title_en: { default: '' },
        authors: { default: '' },
        affil: { default: '' },
        keywords: { default: '' },
      },
    },
    // 摘要：可编辑正文（承载行内公式/引用），验证与导出都按行内标记处理
    abstract_block: {
      group: 'block',
      content: 'inline*',
      attrs: { lang: { default: 'zh' } }, // 'zh' | 'en'
      parseDOM: [{ tag: 'div[data-struct-abstract]' }],
      toDOM() { return ['div', { 'data-struct-abstract': '1' }, 0] },
    },
    heading: {
      group: 'block',
      content: 'inline*',
      attrs: { level: { default: 1 } },
      parseDOM: [
        { tag: 'h2', attrs: { level: 1 } },
        { tag: 'h3', attrs: { level: 2 } },
      ],
      toDOM(node) { return [`h${(node.attrs.level as number) + 1}`, 0] },
    },
    paragraph: {
      group: 'block',
      content: 'inline*',
      parseDOM: [{ tag: 'p' }],
      toDOM() { return ['p', 0] },
    },
    formula: {
      group: 'block',
      atom: true,
      attrs: {
        objectId: { default: '' },
        latex: { default: '' },
        extra: { default: null }, // 未知块内字段保真
      },
    },
    figure: {
      group: 'block',
      atom: true,
      attrs: {
        objectId: { default: '' },
        resource: { default: '' },
        caption: { default: '' },
        extra: { default: null },
      },
    },
    struct_table: {
      group: 'block',
      atom: true,
      attrs: {
        objectId: { default: '' },
        caption: { default: '' },
        header: { default: [] }, // string[]
        rows: { default: [] }, // string[][]
        extra: { default: null },
      },
    },
    // 未知块：只读占位，原始 payload 原样回写（不显示占位后静默删内容）
    unknown_block: {
      group: 'block',
      atom: true,
      attrs: {
        blockType: { default: '' },
        payload: { default: '{}' }, // 原始 JSON 字符串
      },
    },
    text: { group: 'inline', inline: true },
    equation_inline: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: { latex: { default: '' } },
    },
    ref_inline: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: { kind: { default: 'eq' }, targetId: { default: '' } },
    },
  },
})

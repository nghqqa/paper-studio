import { describe, expect, it } from 'vitest'
import { contentToPM, parseInline, inlineToText, pmToContent } from '../adapters'
import type { StructContent } from '@/lib/api/struct'

/** 验收硬约束：无编辑时 pmToContent(contentToPM(J)) 与 J 深度相等（不丢字段/不改字符串/不重生成 ID）。 */

function roundTrip(c: StructContent): StructContent {
  return pmToContent(contentToPM(c) as never)
}

/** 真实旧工程形状：v0.1.5 验收脚本 good_content + 种子初始内容的并集（后端代码产物） */
const realOldProject: StructContent = {
  schema_version: 1,
  title: '结构化验收论文',
  title_en: 'A Structured Acceptance Paper',
  authors: '张三、李四',
  affil: '示例大学计算机系',
  abstract_zh: '本文验证结构化导出闭环，引用式(1)与表1。$n$ 为样本量。',
  abstract_en: 'We verify the structured export loop, citing Eq.(1) and Table 1.',
  keywords: '结构化写作;导出门禁',
  body: [
    { type: 'h1', text: '引言' },
    { type: 'p', text: '加权平均见式 [[eq:eq-1]]，其中 $w_i$ 为权重。' },
    { type: 'formula', id: 'eq-1', latex: 'G = \\frac{\\sum_{i=1}^{n} w_i \\cdot x_i}{\\sum_{i=1}^{n} w_i}' },
    { type: 'h1', text: '实验' },
    { type: 'p', text: '结果汇总于 [[tab:tab-1]] 与 [[fig:fig-1]]。' },
    { type: 'table', id: 'tab-1', caption: '对比结果', header: ['方法', '精度'], rows: [['基线', '0.82'], ['本文', '0.91']] },
    { type: 'figure', id: 'fig-1', resource: 'res-1a2b3c4d', caption: '示意占位图' },
    { type: 'h2', text: '分实验说明' },
    { type: 'p', text: '二级行。' },
  ],
}

describe('parseInline/inlineToText 精确互逆', () => {
  it('中英混排+公式+引用（真实工程摘要）', () => {
    const t = '本文验证结构化导出闭环，引用式 [[eq:eq-1]] 与表 [[tab:t-9]]。其中 $w_i$ 为权重、$\\alpha$ 为系数。'
    expect(inlineToText(parseInline(t))).toBe(t)
  })

  it('未配对/悬空美元符按纯文本保留', () => {
    for (const t of ['成本 $5 与 $10', 'a $ x', '悬空 $x$ 后随 $', '$$', '$ x $']) {
      expect(inlineToText(parseInline(t))).toBe(t)
    }
  })

  it('相邻公式 $a$$b$ 与后端 INLINE_MATH_RE 同切分', () => {
    const nodes = parseInline('$a$$b$')
    expect(nodes).toEqual([
      { type: 'equation_inline', attrs: { latex: 'a' } },
      { type: 'equation_inline', attrs: { latex: 'b' } },
    ])
    expect(inlineToText(nodes)).toBe('$a$$b$')
  })

  it('空串与纯文本', () => {
    expect(parseInline('')).toEqual([])
    expect(inlineToText(parseInline('普通文本，含反斜杠 \\ 与百分号 %。'))).toBe('普通文本，含反斜杠 \\ 与百分号 %。')
  })

  it('失效引用原样保留（不吞不改）', () => {
    const t = '见 [[eq:nope]] 与 [[fig:a-b_C9]]。'
    expect(inlineToText(parseInline(t))).toBe(t)
    const nodes = parseInline(t)
    expect(nodes[1]).toEqual({ type: 'ref_inline', attrs: { kind: 'eq', targetId: 'nope' } })
    expect(nodes[3]).toEqual({ type: 'ref_inline', attrs: { kind: 'fig', targetId: 'a-b_C9' } })
  })

  it('数学段内不找引用、非数学段才找（与后端同序）', () => {
    const t = '$[[eq:x]]$ 与 [[eq:y]]'
    const nodes = parseInline(t)
    expect(nodes).toEqual([
      { type: 'equation_inline', attrs: { latex: '[[eq:x]]' } },
      { type: 'text', text: ' 与 ' },
      { type: 'ref_inline', attrs: { kind: 'eq', targetId: 'y' } },
    ])
    expect(inlineToText(nodes)).toBe(t)
  })
})

describe('整篇往返：无编辑时深度相等', () => {
  it('真实旧工程（v0.1.5 验收内容形状）', () => {
    expect(roundTrip(realOldProject)).toEqual(realOldProject)
  })

  it('种子初始内容（最小编号工程）', () => {
    const seed: StructContent = {
      schema_version: 1,
      title: '', title_en: '', authors: '', affil: '',
      abstract_zh: '', abstract_en: '', keywords: '',
      body: [{ type: 'h1', text: '引言' }, { type: 'p', text: '' }],
    }
    expect(roundTrip(seed)).toEqual(seed)
  })

  it('全部题区字段为空串也保留（不丢键）', () => {
    const c: StructContent = { ...structuredClone(realOldProject), abstract_zh: '', abstract_en: '', title_en: '' }
    const rt = roundTrip(c)
    expect(rt).toEqual(c)
  })

  it('换行与空白原样（协议中文本按字面量存储）', () => {
    const c: StructContent = {
      ...structuredClone(realOldProject),
      body: [{ type: 'p', text: '首行\n\n尾随空格  与\t制表。' }],
    }
    expect(roundTrip(c)).toEqual(c)
  })

  it('转义美元符、相邻公式、前后向重复引用', () => {
    const c: StructContent = {
      ...structuredClone(realOldProject),
      body: [
        { type: 'p', text: '转义写法 \\$5 不是公式；相邻 $a$$b$ 相邻。' },
        { type: 'formula', id: 'eq-dup', latex: 'x' },
        { type: 'p', text: '前向 [[eq:eq-dup]]、重复 [[eq:eq-dup]] 再 [[eq:eq-dup]]。' },
      ],
    }
    expect(roundTrip(c)).toEqual(c)
  })

  it('未知顶层字段经 doc.meta.extra 原样回写', () => {
    const c = structuredClone(realOldProject) as StructContent & Record<string, unknown>
    ;(c as Record<string, unknown>)['future_field'] = { nested: [1, '二', null] }
    const rt = roundTrip(c) as StructContent & Record<string, unknown>
    expect((rt as Record<string, unknown>)['future_field']).toEqual({ nested: [1, '二', null] })
    const { future_field: _f, ...rest } = rt as Record<string, unknown>
    expect(rest).toEqual(realOldProject)
  })

  it('未知块类型：只读占位原样回写（不静默删除）', () => {
    const c = structuredClone(realOldProject)
    ;(c.body as unknown[]).push({ type: 'custom_future_block', spec: { a: 1 }, note: '协议演进' })
    expect(roundTrip(c)).toEqual(c)
  })

  it('对象块内未知字段随 extra 保真', () => {
    const c = structuredClone(realOldProject)
    ;(c.body[2] as Record<string, unknown>)['future_attr'] = 'v1'
    expect(roundTrip(c)).toEqual(c)
  })

  it('重复对象 ID 原样保留（后端保存门禁负责报错，编辑器不静默改写）', () => {
    const c = structuredClone(realOldProject)
    ;(c.body as unknown[]).push({ type: 'formula', id: 'eq-1', latex: 'y' })
    expect(roundTrip(c)).toEqual(c)
  })

  it('表格：空表头/空行/中文内容', () => {
    const c: StructContent = {
      ...structuredClone(realOldProject),
      body: [
        { type: 'table', id: 'tab-0', caption: '表 [[eq:eq-1]] 引用', header: [], rows: [['', '中文'], ['行', '']] },
        { type: 'formula', id: 'eq-1', latex: 'z' },
      ],
    }
    expect(roundTrip(c)).toEqual(c)
  })
})

describe('schema 兼容：PM JSON 可被 structSchema 解释', () => {
  it('contentToPM 产物可经 nodeFromJSON 往返（真实工程）', async () => {
    const { structSchema } = await import('../schema')
    const pm = contentToPM(realOldProject) as never
    const node = structSchema.nodeFromJSON(pm)
    const back = node.toJSON()
    expect(pmToContent(back as never)).toEqual(realOldProject)
  })
})

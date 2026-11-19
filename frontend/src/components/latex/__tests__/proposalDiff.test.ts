import { describe, expect, it } from 'vitest'
import { computeDiff } from '../proposalDiff'

function texts(parts: ReturnType<typeof computeDiff>) {
  return parts.map((p) => ({ t: p.type, s: p.text }))
}

describe('computeDiff', () => {
  it('纯前缀修改', () => {
    const parts = computeDiff('这种方法效果很好。', '本文方法效果显著。')
    const joined = parts.map((p) => (p.type === 'del' || p.type === 'add' ? `[${p.type}]${p.text}` : p.text)).join('')
    expect(joined).toContain('[del]')
    expect(joined).toContain('[add]')
    // 拼接回去能还原两侧
    const dels = parts.filter((p) => p.type !== 'add').map((p) => p.text).join('')
    const adds = parts.filter((p) => p.type !== 'del').map((p) => p.text).join('')
    expect(dels).toBe('这种方法效果很好。')
    expect(adds).toBe('本文方法效果显著。')
  })
  it('完全一致 → 单块 same', () => {
    const parts = computeDiff('一样', '一样')
    expect(texts(parts)).toEqual([{ t: 'same', s: '一样' }])
  })
  it('纯插入', () => {
    const parts = computeDiff('abc', 'abxc')
    expect(parts.some((p) => p.type === 'add' && p.text === 'x')).toBe(true)
    expect(parts.some((p) => p.type === 'del')).toBe(false)
  })
  it('超限降级为整段替换（不近似糊弄）', () => {
    const a = '甲'.repeat(600)
    const b = '乙'.repeat(600) // 600*600=360k > 250k
    const parts = computeDiff(a, b)
    expect(parts).toEqual([
      { type: 'del', text: a },
      { type: 'add', text: b },
    ])
  })
  it('典型润色：数值变化可见', () => {
    const parts = computeDiff('精度为 92.3%。', '精度为 95.7%。')
    const dels = parts.filter((p) => p.type === 'del').map((p) => p.text).join('')
    const adds = parts.filter((p) => p.type === 'add').map((p) => p.text).join('')
    expect(dels).toBe('23')
    expect(adds).toBe('57')
  })
})

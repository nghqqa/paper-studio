import { describe, expect, it } from 'vitest'

import { compressCitationNumbers, mergeCitationBrackets } from '@/components/word/WordSidePanels'

describe('mergeCitationBrackets（上标引用合并，GB/T 7714）', () => {
  it('把多个纯编号括号合并为单个逗号编号', () => {
    expect(mergeCitationBrackets('[1], [2]')).toBe('[1,2]')
    expect(mergeCitationBrackets('[3],[7], [12]')).toBe('[3,7,12]')
  })

  it('两个连续编号保持 [1,2]（不压缩，兼容既有断言）', () => {
    expect(mergeCitationBrackets('[1], [2]')).toBe('[1,2]')
    expect(mergeCitationBrackets('[4], [5]')).toBe('[4,5]')
  })

  it('三个及以上连号按 GB/T 7714-2015 压缩为起止范围', () => {
    expect(mergeCitationBrackets('[1], [2], [3]')).toBe('[1-3]')
    expect(mergeCitationBrackets('[1], [2], [3], [4]')).toBe('[1-4]')
  })

  it('连号与散号混合：[1],[2],[3],[5] → [1-3,5]', () => {
    expect(mergeCitationBrackets('[1], [2], [3], [5]')).toBe('[1-3,5]')
  })

  it('乱序输入先升序去重：[3],[1],[2] → [1-3]，重复编号去重', () => {
    expect(mergeCitationBrackets('[3],[1],[2]')).toBe('[1-3]')
    expect(mergeCitationBrackets('[2],[1],[2],[3]')).toBe('[1-3]')
  })

  it('压缩段与非压缩段混合输出：[1],[2],[3],[8],[9] → [1-3,8,9]', () => {
    expect(mergeCitationBrackets('[1], [2], [3], [8], [9]')).toBe('[1-3,8,9]')
  })

  it('单个编号原样返回', () => {
    expect(mergeCitationBrackets('[1]')).toBe('[1]')
  })

  it('带文字或非常规结构的标签不猜结构、原样上标', () => {
    expect(mergeCitationBrackets('[Smith 2020], [1]')).toBe('[Smith 2020], [1]')
    expect(mergeCitationBrackets('参见 [1] 与 [2]')).toBe('参见 [1] 与 [2]')
  })

  it('空串安全', () => {
    expect(mergeCitationBrackets('')).toBe('')
  })
})

describe('compressCitationNumbers（连号压缩工具）', () => {
  it('≥3 连号压缩、2 连号保留、单号保留', () => {
    expect(compressCitationNumbers([1, 2, 3])).toBe('1-3')
    expect(compressCitationNumbers([1, 2])).toBe('1,2')
    expect(compressCitationNumbers([7])).toBe('7')
  })

  it('去重且升序无关输入顺序', () => {
    expect(compressCitationNumbers([3, 1, 2])).toBe('1-3')
    expect(compressCitationNumbers([2, 1, 2, 3])).toBe('1-3')
  })

  it('混合段：1-4 连号 + 8-9 两连号 + 散号', () => {
    expect(compressCitationNumbers([1, 2, 3, 4, 8, 9, 12])).toBe('1-4,8,9,12')
  })

  it('空数组安全', () => {
    expect(compressCitationNumbers([])).toBe('')
  })
})

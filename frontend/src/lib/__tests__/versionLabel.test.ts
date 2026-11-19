import { describe, expect, it } from 'vitest'
import { versionLabel } from '../versionLabel'

describe('versionLabel（history.py 机器串 → 面板人话）', () => {
  it('保存 / 附图 / 恢复 / 旧备份', () => {
    expect(versionLabel('save')).toBe('保存')
    expect(versionLabel('figures')).toBe('附图更新')
    expect(versionLabel('restore abc1234')).toBe('恢复自 abc1234')
    expect(versionLabel('backup 2026-01-01 09:00:00')).toBe('旧备份 2026-01-01 09:00:00')
  })

  it('协同保存：content 不带书名，分书带书名', () => {
    expect(versionLabel('collab:content')).toBe('协同保存')
    expect(versionLabel('collab:description')).toBe('协同保存 · 说明书')
    expect(versionLabel('collab:claims')).toBe('协同保存 · 权利要求书')
    expect(versionLabel('collab:abstract')).toBe('协同保存 · 摘要')
  })

  it('台账事件：字段名与状态翻成中文', () => {
    expect(versionLabel('case: update dates')).toBe('台账：日期')
    expect(versionLabel('case: update case_no, client, deadlines')).toBe('台账：案号、客户、期限')
    expect(versionLabel('case: status drafting → review')).toBe('状态：撰写 → 内审')
    expect(versionLabel('case: status review → client_review · 已发客户')).toBe('状态：内审 → 客户确认 · 已发客户')
    expect(versionLabel('case: deadlines recompute')).toBe('期限重算')
    expect(versionLabel('case: deadline override oa-1 → 2026-12-01')).toBe('期限改期 → 2026-12-01')
    expect(versionLabel('case: deadline done oa-1')).toBe('期限完成')
  })

  it('未知串与 AI 提案原样返回', () => {
    expect(versionLabel('AI 提案 claims：docs/claims.md')).toBe('AI 提案 claims：docs/claims.md')
    expect(versionLabel('something else')).toBe('something else')
  })

  it('LaTeX 工程线（latex_history.py 机器串）', () => {
    expect(versionLabel('build')).toBe('编译快照')
    expect(versionLabel('save sections/a.tex')).toBe('保存 · sections/a.tex')
    expect(versionLabel('create sections/a.tex')).toBe('新建 · sections/a.tex')
    expect(versionLabel('upload figs/f.png')).toBe('上传 · figs/f.png')
    expect(versionLabel('zip-merge +7')).toBe('ZIP 合并 · +7 个文件')
    expect(versionLabel('rename a.tex -> b.tex')).toBe('重命名 a.tex → b.tex')
    expect(versionLabel('delete sections/a.tex')).toBe('删除 · sections/a.tex')
    expect(versionLabel('library refs.bib')).toBe('文献写回 · refs.bib')
    expect(versionLabel('restore abcd123')).toBe('恢复自 abcd123') // 与专利线共用
  })
})

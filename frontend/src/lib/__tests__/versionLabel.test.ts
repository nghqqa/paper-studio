import { describe, expect, it } from 'vitest'
import { versionLabel } from '../versionLabel'

describe('versionLabel（history.py 机器串 → 面板人话）', () => {
  it('保存 / 附图 / 恢复 / 旧备份', () => {
    expect(versionLabel('save')).toBe('保存')
    expect(versionLabel('figures')).toBe('附图更新')
    expect(versionLabel('restore abc1234')).toBe('恢复自 abc1234')
    expect(versionLabel('backup 2026-01-01 09:00:00')).toBe('旧备份 2026-01-01 09:00:00')
  })

  it('未知串原样返回', () => {
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

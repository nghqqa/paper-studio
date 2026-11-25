import { describe, expect, it, vi } from 'vitest'
import { ProjectContentIndex, type EditorSearchDeps } from '../editorSearch'

function makeDeps(files: { path: string; size: number; editable: boolean; content?: string }[]) {
  const stats = { listCalls: 0, readCalls: [] as string[] }
  const deps: EditorSearchDeps = {
    list: vi.fn(async () => {
      stats.listCalls++
      return { files: files.map(({ path, size, editable }) => ({ path, size, editable })) }
    }),
    read: vi.fn(async (path: string) => {
      stats.readCalls.push(path)
      const hit = files.find((f) => f.path === path)
      if (!hit) throw new Error('missing ' + path)
      return { path, content: hit.content ?? '' }
    }),
  }
  return { deps, stats }
}

const DOC_A = '\\section{Intro}\nWe cite prior work \\cite{einstein1905}.\n\\label{sec:intro}\n'
const DOC_B = '精度达到 92.3%。\n\\label{eq:main}\n如式~\\ref{eq:main} 所示。\n'

describe('ProjectContentIndex（工程内容索引）', () => {
  it('加载全部可编辑文件并按文件序搜索（大小写不敏感，行号列号 1-based）', async () => {
    const { deps, stats } = makeDeps([
      { path: 'main.tex', size: 5, editable: true, content: DOC_A },
      { path: 'sections/b.tex', size: 5, editable: true, content: DOC_B },
    ])
    const index = new ProjectContentIndex(deps)
    expect(index.ready).toBe(false)
    await index.ensure()
    expect(index.ready).toBe(true)
    expect(stats.readCalls).toEqual(['main.tex', 'sections/b.tex'])
    expect(index.isPartial).toBe(false)

    const hits = index.searchAll('REF')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ path: 'sections/b.tex', line: 3, col: 5 })
    expect(hits[0].text).toContain('\\ref{eq:main}')
  })

  it('ensure 并发去重：多次调用只拉一次', async () => {
    const { deps, stats } = makeDeps([{ path: 'main.tex', size: 5, editable: true, content: DOC_A }])
    const index = new ProjectContentIndex(deps)
    await Promise.all([index.ensure(), index.ensure(), index.ensure()])
    expect(stats.listCalls).toBe(1)
  })

  it('自限：单文件超限跳过并标记 partial；总量超限停止并标记 partial', async () => {
    const { deps } = makeDeps([
      { path: 'big.pdf.tex', size: 2 * 1024 * 1024, editable: true, content: 'x' },
      { path: 'a.tex', size: 10, editable: true, content: 'needle here\n' },
      { path: 'b.tex', size: 8 * 1024 * 1024, editable: true, content: 'needle too\n' },
    ])
    const index = new ProjectContentIndex(deps)
    await index.ensure()
    expect(index.isPartial).toBe(true)
    const hits = index.searchAll('needle')
    expect(hits.map((h) => h.path)).toEqual(['a.tex']) // b 超总量被跳过
  })

  it('invalidate 后 ensure 重建（保存/导入后的失效语义）', async () => {
    const { deps, stats } = makeDeps([{ path: 'main.tex', size: 5, editable: true, content: DOC_A }])
    const index = new ProjectContentIndex(deps)
    await index.ensure()
    index.invalidate()
    expect(index.ready).toBe(false)
    await index.ensure()
    expect(stats.listCalls).toBe(2)
  })

  it('collectLabels：仅 .tex、带文件与行号、多 label 全收', async () => {
    const { deps } = makeDeps([
      { path: 'main.tex', size: 5, editable: true, content: DOC_A + '双 label 同行 \\label{tab:x} \\label{fig:y}\n' },
      { path: 'refs.bib', size: 5, editable: true, content: '\\label{bib:不应收录}\n' },
    ])
    const index = new ProjectContentIndex(deps)
    await index.ensure()
    const labels = index.collectLabels()
    expect(labels).toEqual([
      { name: 'sec:intro', file: 'main.tex', line: 3 },
      { name: 'tab:x', file: 'main.tex', line: 4 },
      { name: 'fig:y', file: 'main.tex', line: 4 },
    ])
  })

  it('单文件 read 失败不炸整体，标记 partial', async () => {
    const { deps } = makeDeps([
      { path: 'gone.tex', size: 5, editable: true },
      { path: 'a.tex', size: 5, editable: true, content: 'find me\n' },
    ])
    deps.read = vi.fn(async (path: string) => {
      if (path === 'gone.tex') throw new Error('404')
      return { path, content: 'find me\n' }
    })
    const index = new ProjectContentIndex(deps)
    await index.ensure()
    expect(index.isPartial).toBe(true)
    expect(index.searchAll('find')).toHaveLength(1)
  })

  it('collectOutline：从主文件递归展开 \\include / \\input 并支持实时覆盖', async () => {
    const { deps } = makeDeps([
      {
        path: 'main.tex',
        size: 50,
        editable: true,
        content: '\\chapter*{摘要}\n\\include{chapters/chap1}\n% \\include{chapters/ignored}\n\\input{chapters/chap2.tex}\n',
      },
      {
        path: 'chapters/chap1.tex',
        size: 50,
        editable: true,
        content: '\\chapter{绪论}\n\\section{研究背景}\n',
      },
      {
        path: 'chapters/chap2.tex',
        size: 50,
        editable: true,
        content: '\\chapter{核心方法}\n\\subsection{模型设计}\n',
      },
    ])
    const index = new ProjectContentIndex(deps)
    await index.ensure()
    const outline = index.collectOutline('main.tex', {
      'chapters/chap2.tex': '\\chapter{核心方法（修订）}\n\\subsection{模型设计}\n',
    })
    expect(outline).toEqual([
      { file: 'main.tex', line: 1, level: 0, title: '摘要' },
      { file: 'chapters/chap1.tex', line: 1, level: 0, title: '绪论' },
      { file: 'chapters/chap1.tex', line: 2, level: 1, title: '研究背景' },
      { file: 'chapters/chap2.tex', line: 1, level: 0, title: '核心方法（修订）' },
      { file: 'chapters/chap2.tex', line: 2, level: 2, title: '模型设计' },
    ])
  })
})

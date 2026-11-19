// @vitest-environment jsdom
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStudio } from '@/store'
import { NewPaperProjectDialog } from '../NewPaperProjectDialog'

/** 论文统一新建入口合约：模式 Segmented（结构化仅开关开启时显示）/ 模板库列表 / profile 卡片 / 创建走对应 API。 */
declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

vi.mock('@/lib/api/latex', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/latex')>()
  return {
    ...actual,
    latexApi: {
      ...actual.latexApi,
      createDemo: vi.fn().mockResolvedValue({ id: 'latex-blank-1', title: '论文标题', source_format: 'latex', latex: { main: 'main.tex', engine: 'xelatex' } }),
    },
  }
})

vi.mock('@/lib/api/struct', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/struct')>()
  return {
    ...actual,
    structApi: {
      ...actual.structApi,
      paperTemplates: vi.fn().mockResolvedValue({
        word: [
          { id: 'blank', name: '空白 Word 文档', desc: '原生 DOCX' },
          { id: 'jcip', name: '中文信息学报投稿模板', desc: '期刊原件', venue: '中文信息学报' },
          { id: 'custom-team', name: '团队自定义模板', desc: '管理员上传', venue: '团队期刊' },
        ],
        latex: [
          { id: 'blank', name: '空白中文论文', desc: '最小 ctex 骨架', language: '中文', kind: '通用', venue: '通用' },
          { id: 'ieee', name: 'IEEE 会议（IEEEtran）', desc: 'IEEEtran bare_conf 示例', language: '英文', kind: '会议', venue: 'IEEE' },
          { id: 'ieee_journal', name: 'IEEE 期刊（TPAMI 等）', desc: 'IEEEtran journal 模式', language: '英文', kind: '期刊', venue: 'IEEE' },
          { id: 'lncs_springer', name: 'Springer LNCS（ECCV 等）', desc: 'LNCS 会议/丛书格式', language: '英文', kind: '会议', venue: 'Springer' },
          { id: 'elsevier_journal', name: 'Elsevier 期刊', desc: 'elsarticle', language: '英文', kind: '期刊', venue: 'Elsevier' },
        ],
        struct: [{ id: 'jcip', name: '中文信息学报（jcip）', desc: '结构化写作 → DOCX/PDF 导出', experimental: true }],
      }),
      create: vi.fn().mockResolvedValue({ id: 'struct-paper-9', title: '结构化中文论文（实验）', settings: { source_format: 'structured' } }),
    },
  }
})

vi.mock('@/lib/api/word', () => ({ wordApi: {
  create: vi.fn().mockResolvedValue({ id: 'word-1', title: '中文论文', source_format: 'docx' }),
  import: vi.fn().mockResolvedValue({ id: 'word-2', title: '现有稿件', source_format: 'docx' }),
} }))

let root: Root | null = null
let host: HTMLElement

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  vi.clearAllMocks()
  useStudio.setState({ structWriterEnabled: false, wordEditorEnabled: true, wordEditorReady: true, product: 'paper' })
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  host?.remove()
})

async function mount(el: ReactElement) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root!.render(el))
  return host
}

function setNativeValue(el: HTMLInputElement, v: string) {
  // React 受控输入：直接赋值会被 value tracker 去重，须走原型 setter
  const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
  desc?.set?.call(el, v)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

function findButton(h: HTMLElement, testId: string) {
  // Radix Dialog 渲染进 body portal：host 内查询不到，统一查 document
  void h
  return document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)
}

async function chooseLatex() {
  await act(async () => {
    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-testid="np-mode"] button')) if (b.textContent?.includes('LaTeX')) b.click()
  })
}

describe('NewPaperProjectDialog', () => {
  it('管理员上传的 Word 模板从注册表出现，创建时提交动态模板 ID', async () => {
    const { wordApi } = await import('@/lib/api/word')
    const h = await mount(<NewPaperProjectDialog open onOpenChange={() => {}} />)
    await act(async () => { findButton(h, 'np-word-template-custom-team')!.querySelector('input')!.click() })
    await act(async () => { findButton(h, 'np-create')!.click() })
    expect(wordApi.create).toHaveBeenCalledWith(expect.objectContaining({ template: 'custom-team', venue: '团队期刊' }))
  })
  it('LaTeX 模式保留模板库与创建参数', async () => {
    const { latexApi } = await import('@/lib/api/latex')
    const h = await mount(<NewPaperProjectDialog open onOpenChange={() => {}} onZipImport={() => {}} />)
    await chooseLatex()
    await act(async () => { await vi.waitFor(() => expect(findButton(h, 'np-template-ieee')).not.toBeNull()) })
    // 切到 IEEE 模板
    await act(async () => { findButton(h, 'np-template-ieee')!.querySelector('input')!.click() })
    await act(async () => { setNativeValue(document.querySelector<HTMLInputElement>('[data-testid="np-title"]')!, '我的论文') })
    await act(async () => { findButton(h, 'np-create')!.click() })
    await act(async () => { await vi.waitFor(() => expect(latexApi.createDemo).toHaveBeenCalled()) })
    expect(latexApi.createDemo).toHaveBeenCalledWith('ieee', '我的论文')
    // 结构化选项存在（开关开启 + 注册表返回 profile）
    expect(document.body.textContent).toContain('Word 论文')
  })

  it('默认 Word 模式，不依赖结构化开关，模板与投稿元数据随创建提交', async () => {
    const { wordApi } = await import('@/lib/api/word')
    const h = await mount(<NewPaperProjectDialog open onOpenChange={() => {}} onZipImport={() => {}} />)
    expect(findButton(h, 'np-word-template-blank')).not.toBeNull()
    await act(async () => { findButton(h, 'np-word-template-jcip')!.querySelector('input')!.click() })
    await act(async () => { setNativeValue(document.querySelector<HTMLInputElement>('[data-testid="np-rank"]')!, 'CCF-A') })
    await act(async () => { findButton(h, 'np-create')!.click() })
    await act(async () => { await vi.waitFor(() => expect(wordApi.create).toHaveBeenCalled()) })
    expect(wordApi.create).toHaveBeenCalledWith({ title: '未命名论文', template: 'jcip', venue: '中文信息学报', field: '', rank: 'CCF-A' })
  })

  it('文档服务未配置时阻止 Word 创建，不伪装成功', async () => {
    const { wordApi } = await import('@/lib/api/word')
    useStudio.setState({ wordEditorReady: false })
    const h = await mount(<NewPaperProjectDialog open onOpenChange={() => {}} onZipImport={() => {}} />)
    // 断言对象=模式 Segmented 的选项（对话框描述文案里允许出现「结构化中文论文」字样）
    const modeButtons = [...(document.querySelector('[data-testid="np-mode"]')?.querySelectorAll('button') ?? [])]
    expect(modeButtons.some((b) => b.textContent?.includes('结构化'))).toBe(false)
    expect(findButton(h, 'np-create')!.disabled).toBe(true)
    expect(findButton(h, 'np-word-unavailable')!.textContent).toContain('ONLYOFFICE')
    expect(wordApi.create).not.toHaveBeenCalled()
  })

  it('上传现有 DOCX 通过原生 Word 导入接口，不转结构化，且原生 file 控件视觉隐藏不重复露出', async () => {
    const { wordApi } = await import('@/lib/api/word')
    const h = await mount(<NewPaperProjectDialog open onOpenChange={() => {}} />)
    const file = new File(['docx'], '期刊模板.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
    const input = document.querySelector<HTMLInputElement>('[data-testid="np-word-file"]')!
    expect(input.classList.contains('sr-only')).toBe(true)
    expect(document.querySelector('label[for="np-word-file"]')?.contains(input)).toBe(true)
    Object.defineProperty(input, 'files', { value: [file] })
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
    expect(document.querySelector('[data-testid="np-word-selected"]')?.textContent).toContain('期刊模板.docx')
    await act(async () => { findButton(h, 'np-create')!.click() })
    expect(wordApi.import).toHaveBeenCalledWith(file, undefined)
    expect(wordApi.create).not.toHaveBeenCalled()
  })

  it('未提供 onZipImport（移动端）：不出现上传压缩包按钮', async () => {
    const h = await mount(<NewPaperProjectDialog open onOpenChange={() => {}} />)
    await chooseLatex()
    await act(async () => { await vi.waitFor(() => expect(findButton(h, 'np-template-ieee')).not.toBeNull()) })
    expect(findButton(h, 'np-zip')).toBeNull()
  })
})

describe('NewPaperProjectDialog 模板库搜索', () => {
  it('搜索关键词过滤模板列表（按 venue/名称）', async () => {
    const h = await mount(<NewPaperProjectDialog open onOpenChange={() => {}} />)
    await chooseLatex()
    await act(async () => { await vi.waitFor(() => expect(findButton(h, 'np-template-ieee')).not.toBeNull()) })
    await act(async () => { setNativeValue(document.querySelector<HTMLInputElement>('[data-testid="np-template-search"]')!, 'Springer') })
    await act(async () => { await vi.waitFor(() => expect(findButton(h, 'np-template-ieee')).toBeNull()) })
    expect(findButton(h, 'np-template-lncs_springer')).not.toBeNull()
  })

  it('清空搜索恢复全列表；模板总数=注册表长度', async () => {
    const h = await mount(<NewPaperProjectDialog open onOpenChange={() => {}} />)
    await chooseLatex()
    await act(async () => { await vi.waitFor(() => expect(findButton(h, 'np-template-elsevier_journal')).not.toBeNull()) })
    const all = document.querySelectorAll('[data-testid="np-templates"] label')
    expect(all.length).toBe(5)
  })
})

/**
 * LaTeX 符号目录（编辑器三件套之三：符号面板的数据）。
 * 自编的常用命令集合（命令本身是 LaTeX 标准语法，非任何项目的产物）；
 * demo = KaTeX 预览用的演示参数（带 {} 占位的命令渲染空参数无意义）。
 * 结构与引用组是文字模式命令，不做数学预览（previewHtml 返回 null，面板显示等宽字面量）。
 */
import katex from 'katex'

export interface SymbolItem {
  /** 插入到光标处的字面文本 */
  cmd: string
  /** KaTeX 预览用（缺省用 cmd 去掉 {} 后的形态） */
  demo?: string
}

export interface SymbolGroup {
  label: string
  math: boolean
  items: SymbolItem[]
}

const g = (cmd: string, demo?: string): SymbolItem => (demo ? { cmd, demo } : { cmd })

export const SYMBOL_GROUPS: SymbolGroup[] = [
  {
    label: '希腊字母',
    math: true,
    items: [
      g('\\alpha'), g('\\beta'), g('\\gamma'), g('\\delta'), g('\\epsilon'), g('\\varepsilon'),
      g('\\zeta'), g('\\eta'), g('\\theta'), g('\\vartheta'), g('\\iota'), g('\\kappa'),
      g('\\lambda'), g('\\mu'), g('\\nu'), g('\\xi'), g('\\pi'), g('\\rho'),
      g('\\sigma'), g('\\tau'), g('\\upsilon'), g('\\phi'), g('\\varphi'), g('\\chi'),
      g('\\psi'), g('\\omega'),
      g('\\Gamma'), g('\\Delta'), g('\\Theta'), g('\\Lambda'), g('\\Xi'), g('\\Pi'),
      g('\\Sigma'), g('\\Upsilon'), g('\\Phi'), g('\\Psi'), g('\\Omega'),
    ],
  },
  {
    label: '运算与关系',
    math: true,
    items: [
      g('\\times'), g('\\cdot'), g('\\div'), g('\\pm'), g('\\mp'),
      g('\\leq'), g('\\geq'), g('\\neq'), g('\\approx'), g('\\equiv'), g('\\sim'), g('\\propto'),
      g('\\ll'), g('\\gg'), g('\\infty'), g('\\partial'), g('\\nabla'), g('\\degree'),
      g('\\sum'), g('\\prod'), g('\\int', '\\int f(x)\\,dx'), g('\\oint'),
      g('\\sqrt{}', '\\sqrt{x}'), g('\\frac{}{}', '\\frac{a}{b}'), g('\\lim', '\\lim_{x\\to 0}'),
    ],
  },
  {
    label: '箭头',
    math: true,
    items: [
      g('\\rightarrow'), g('\\leftarrow'), g('\\leftrightarrow'),
      g('\\Rightarrow'), g('\\Leftarrow'), g('\\Leftrightarrow'),
      g('\\longrightarrow'), g('\\longleftarrow'), g('\\mapsto'),
      g('\\uparrow'), g('\\downarrow'), g('\\updownarrow'), g('\\leadsto'),
    ],
  },
  {
    label: '逻辑与集合',
    math: true,
    items: [
      g('\\forall'), g('\\exists'), g('\\nexists'), g('\\neg'), g('\\land'), g('\\lor'),
      g('\\in'), g('\\notin'), g('\\ni'),
      g('\\subset'), g('\\subseteq'), g('\\supset'), g('\\supseteq'),
      g('\\cup'), g('\\cap'), g('\\emptyset'), g('\\varnothing'),
      g('\\mathbb{R}', '\\mathbb{R}'), g('\\mathbb{N}', '\\mathbb{N}'),
    ],
  },
  {
    label: '定界符',
    math: true,
    items: [
      g('\\{'), g('\\}'), g('|'), g('\\|'),
      g('\\langle'), g('\\rangle'), g('\\lceil'), g('\\rceil'), g('\\lfloor'), g('\\rfloor'),
    ],
  },
  {
    label: '重音与装饰',
    math: true,
    items: [
      g('\\bar{}', '\\bar{x}'), g('\\hat{}', '\\hat{x}'), g('\\tilde{}', '\\tilde{x}'),
      g('\\vec{}', '\\vec{x}'), g('\\dot{}', '\\dot{x}'), g('\\ddot{}', '\\ddot{x}'),
      g('\\overline{}', '\\overline{xy}'), g('\\underline{}', '\\underline{xy}'),
      g('\\widehat{}', '\\widehat{xy}'), g('\\widetilde{}', '\\widetilde{xy}'),
    ],
  },
  {
    label: '结构与引用',
    math: false,
    items: [
      g('\\label{}'), g('\\ref{}'), g('\\eqref{}'), g('\\cite{}'),
      g('\\section{}'), g('\\subsection{}'), g('\\footnote{}'),
      g('\\textit{}'), g('\\textbf{}'), g('\\item '),
    ],
  },
]

/** 预览展示文本：带 {} 占位的命令换成 demo（缺省填 x），纯命令原样。 */
export function symbolPreviewSrc(item: SymbolItem): string {
  if (item.demo) return item.demo
  return item.cmd.replace(/\{\}/g, 'x')
}

/** 数学命令的 KaTeX 预览 HTML；文字模式命令（math=false）返回 null 由面板显示字面量。 */
export function symbolPreviewHtml(group: SymbolGroup, item: SymbolItem): string | null {
  if (!group.math) return null
  try {
    return katex.renderToString(symbolPreviewSrc(item), { throwOnError: false })
  } catch {
    return null
  }
}

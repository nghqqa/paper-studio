import katex from 'katex'

/** KaTeX 渲染（错误内联展示，不抛出）；供连续编辑器与卡片视图共用 */
export function ktHtml(latex: string, display: boolean): string {
  try {
    return katex.renderToString(latex || '', { displayMode: display, throwOnError: true, output: 'html' })
  } catch (e) {
    return `<span class="text-red-600">公式错误：${e instanceof Error ? e.message : String(e)}</span>`
  }
}

/** 与后端 structured.py ALLOWED_COMMANDS 同集的前端白名单提示（导出阻断的先行反馈） */
const ALLOWED_COMMANDS = new Set(
  ('frac dfrac sqrt sum prod int lim exp max min log ln sin cos tan top ' +
    'alpha beta gamma delta epsilon varepsilon zeta eta theta iota kappa lambda mu nu xi pi rho sigma tau upsilon phi varphi chi psi omega ' +
    'Gamma Delta Theta Lambda Xi Pi Sigma Phi Psi Omega times cdot div pm mp leq geq neq approx equiv infty partial nabla forall exists in subset cup cap ' +
    'rightarrow leftarrow Rightarrow Leftarrow mapsto to mathbf mathrm mathit boldsymbol text operatorname left right quad qquad begin end').split(' '),
)
const ALLOWED_ENVIRONMENTS = new Set(['pmatrix', 'bmatrix', 'matrix', 'cases', 'aligned'])

export function formulaWarn(latex: string): string[] {
  const bad = new Set<string>()
  for (const m of (latex || '').matchAll(/\\([a-zA-Z]+)/g)) {
    if (ALLOWED_COMMANDS.has(m[1])) continue
    bad.add(m[1] === 'label' ? '\\label（编号由系统生成，请勿手写）' : `\\${m[1]}`)
  }
  for (const m of (latex || '').matchAll(/\\(?:begin|end)\{(\w+\*?)\}/g))
    if (!ALLOWED_ENVIRONMENTS.has(m[1])) bad.add(`\\begin{${m[1]}}`)
  return [...bad]
}

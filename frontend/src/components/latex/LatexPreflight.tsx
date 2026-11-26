import { useCallback } from 'react'
import { PreflightPanel, type PreflightRulesetOption } from '@/components/paper/PreflightPanel'
import {
  latexApi,
  type LatexPreflightReport,
  type LatexPreflightRuleset,
} from '@/lib/api/latex'

/** 规则集（与后端 domain/latex_preflight.py RULESETS 同名同序）。 */
const RULESETS: PreflightRulesetOption<LatexPreflightRuleset>[] = [
  {
    id: 'latex-general',
    label: '通用学术检查',
    hint: '通用投稿规范：TODO/FIXME/\\hl/?? 残留、未定义 \\cite/\\ref、未解决 Issue、未使用图片/标签与缩略语连字符一致性。只读。',
  },
  {
    id: 'double-blind',
    label: '双盲匿名检查',
    hint: '双盲匿名审查：扫描非注释行的 \\author/\\thanks/\\affiliation/Acknowledgments、资助基金词与屏蔽词；% 注释行跳过。只读。',
  },
  {
    id: 'submission-readiness',
    label: '投稿就绪度体检',
    hint: '投稿终检：最新编译 PDF 页数与新鲜度、.bbl 就绪度、未使用图片/图表标签、未引用 .bib 文献与缩略语/连字符一致性。只读。',
  },
]

interface Props {
  pid: string
  canEdit: boolean
}

/** LaTeX 投稿前检查（只读体检）：不改源码、不调外部 AI；报告绑定源码内容指纹，过期如实提示。 */
export function LatexPreflight({ pid, canEdit }: Props) {
  const loadReport = useCallback((ruleset: LatexPreflightRuleset) => latexApi.getPreflight(pid, ruleset), [pid])
  const runReport = useCallback((ruleset: LatexPreflightRuleset) => latexApi.runPreflight(pid, { ruleset }), [pid])

  return (
    <PreflightPanel<LatexPreflightRuleset, LatexPreflightReport>
      testIdPrefix="latex-preflight"
      description="只读投稿前检查；不修改源码、不调用外部 AI。"
      notRunText="当前规则集尚未运行检查。运行后会对当前已保存源码生成只读报告。"
      footerPrefix="报告为只读快照结果；源码变化后请重新运行。生成时间"
      rulesets={RULESETS}
      defaultRuleset="latex-general"
      loadReport={loadReport}
      runReport={runReport}
      canEdit={canEdit}
      expiredText={() => '源文件已更新：以下报告绑定旧快照指纹，与当前工程不一致——请重新运行检查。'}
      renderMeta={(report) => (
        <>
          规则集 {report.ruleset_id}/{report.ruleset_version} · 扫描 {Object.keys(report.digest).length} 个源文件 · 指纹 {report.digest_sha.slice(0, 12)}
          {report.parse_error && <span className="text-warning">（解析异常：{report.parse_error}）</span>}
        </>
      )}
    />
  )
}

import { useCallback } from 'react'
import { PreflightPanel, type PreflightRulesetOption } from '@/components/paper/PreflightPanel'
import {
  wordApi,
  type WordPreflightReport,
  type WordPreflightRuleset,
} from '@/lib/api/word'

/** 规则集注册表（与后端 domain/word_preflight.py RULESETS 同名同序）。 */
const RULESETS: PreflightRulesetOption<WordPreflightRuleset>[] = [
  {
    id: 'jcip-preflight',
    label: '中文信息学报（jcip）',
    hint: '依据中文信息学报模板与通用投稿规范的只读检查；不修改正文、不自动接受修订。',
  },
  {
    id: 'cn-general',
    label: '通用中文论文',
    hint: '通用投稿规范：待办/占位残留、未处理修订、未关闭批注、正文引用与文献表对账。只读。',
  },
  {
    id: 'double-blind',
    label: '双盲匿名检查',
    hint: '双盲匿名审查：按项目设置 blind_terms（或运行时传入词表）扫描正文/页眉页脚/文档属性作者与基金残留。只读。',
  },
]

interface Props {
  pid: string
  canEdit: boolean
  saving: boolean
  /** 工作台轮询到的当前已保存快照 SHA——变化即标记旧报告过期并刷新（本轮审查问题 4）。 */
  stateSha?: string | null
  stateVersion?: number | null
}

/** 投稿前检查（多规则集，只读报告）：不改稿、不自动接受修订、不调外部 AI。 */
export function WordPreflightPanel({ pid, canEdit, saving, stateSha, stateVersion }: Props) {
  const loadReport = useCallback((ruleset: WordPreflightRuleset) => wordApi.getPreflight(pid, ruleset), [pid])
  const runReport = useCallback((ruleset: WordPreflightRuleset) => wordApi.runPreflight(pid, { ruleset }), [pid])
  const isReportStale = useCallback(
    (report: WordPreflightReport) =>
      (stateSha != null && report.sha256 !== stateSha) || (stateVersion != null && report.version !== stateVersion),
    [stateSha, stateVersion],
  )

  return (
    <PreflightPanel<WordPreflightRuleset, WordPreflightReport>
      testIdPrefix="word-preflight"
      description="只读投稿前检查；不修改正文、不自动接受修订。"
      notRunText="当前规则集尚未运行检查。运行后会对当前已保存版本生成只读报告。"
      footerPrefix="报告为只读快照结果；正文或保存状态变化后请重新运行。生成时间"
      rulesets={RULESETS}
      defaultRuleset="jcip-preflight"
      loadReport={loadReport}
      runReport={runReport}
      canEdit={canEdit}
      runDisabled={saving}
      runTitle={saving ? '文档服务正在回传文件，请等保存完成后再检查' : !canEdit ? '当前账号无编辑权限' : undefined}
      banner={
        saving ? (
          <p className="mb-2 text-fg-muted" data-testid="word-preflight-saving">
            文档服务正在回传文件——请等保存完成后再运行检查，避免对旧快照出报告。
          </p>
        ) : undefined
      }
      expiredText={(report) => `文档已更新：以下报告对应旧快照（版本 v${report.version}），与当前稿件不一致——请重新运行检查。`}
      renderMeta={(report) => (
        <>
          保存版本 v{report.version} · 文件 SHA {report.sha256.slice(0, 12)} · 规则集 {report.ruleset_id}/{report.ruleset_version}
          {report.parse_error && <span className="text-warning">（解析失败：{report.parse_error}）</span>}
        </>
      )}
      stalenessTrigger={stateSha}
      isReportStale={isReportStale}
    />
  )
}

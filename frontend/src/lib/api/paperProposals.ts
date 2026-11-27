import { postSse, req, type SseOptions } from './net'

/** 论文 AI 修改提案 API（v0.4）。生成/列表/状态流转；落地在编辑器（前端事务 / Word 插件桥）。 */

export type ProposalStatus = 'generating' | 'pending' | 'applied' | 'rejected' | 'stale' | 'failed' | 'undone'
export type ProposalAction =
  | 'polish'
  | 'academic'
  | 'condense'
  | 'expand'
  | 'custom'
  | 'deai'
  | 'writing'
  | 'translate_en'
  | 'translate_zh'

export interface ProposalAnchor {
  file: string
  base_sha: string
  offset: number | null
  context_before: string
  context_after: string
  original_text: string
}

/** 编译错误快照（从 Issues/诊断条「AI 修复提案」带入，verify-fix 的对照口径）。 */
export interface ProposalErrorContext {
  file: string
  line: number | null
  message: string
}

/** 一次修复验证记录（接受修改→重编译→确认错误消失；append 可回看）。 */
export interface FixVerification {
  at: number
  build_id: string
  build_status: string
  before: { file?: string; line?: number | null; message?: string }[]
  after: { file?: string; line?: number | null; message?: string }[]
  resolved: boolean
  issue_resolved: boolean
}

export interface PaperProposal {
  proposal_id: string
  mode: 'latex' | 'word'
  action: ProposalAction
  instruction: string | null
  anchor: ProposalAnchor
  suggested_text: string
  rationale: string
  model: string
  created_by: string | null
  created_at: number
  updated_at: number
  status: ProposalStatus
  protection_flags: string[]
  error: string | null
  applied_at: number | null
  applied_text: string | null
  applied_by: string | null
  error_context?: ProposalErrorContext | null
  linked_issue_id?: string | null
  verifications?: FixVerification[]
  parent_proposal_id?: string | null
}

export const PROPOSAL_ACTION_LABELS: Record<ProposalAction, string> = {
  polish: '润色',
  deai: '去AI味',
  writing: '写作',
  academic: '学术化',
  condense: '凝练',
  expand: '扩写',
  translate_en: '中译英',
  translate_zh: '英译中',
  custom: '自定义',
}

export const PROPOSAL_STATUS_LABELS: Record<ProposalStatus, string> = {
  generating: '生成中',
  pending: '待审阅',
  applied: '已采纳',
  rejected: '已拒绝',
  stale: '原文已变化',
  failed: '生成失败',
  undone: '已撤销',
}

export const PROTECTION_LABELS: Record<string, string> = {
  numbers: '数值改动',
  units: '单位改动',
  citations: '引用键改动',
  math: '公式改动',
  refs: 'ref/label 改动',
}

export interface AiDisclosureSummary {
  used_ai: boolean
  total_proposals: number
  applied_count: number
  human_edited_count: number
  rejected_count: number
  undone_count: number
  pending_count: number
  protected_applied_count: number
  protected_by_flag: Record<string, number>
  by_action: Record<string, number>
  models: string[]
  files: string[]
  time_range: { start: string; end: string } | null
  generated_at: string
}

export interface AiDisclosureResponse {
  lang: 'zh' | 'en'
  format: 'markdown' | 'latex'
  filename: string
  summary: AiDisclosureSummary
  content: string
}

export interface GenerateProposalInput {
  mode: 'latex' | 'word'
  file: string
  base_sha: string
  original_text: string
  context_before?: string
  context_after?: string
  action: ProposalAction
  instruction?: string
  error_context?: ProposalErrorContext
  linked_issue_id?: string
  parent_proposal_id?: string
  previous_suggestion?: string
  use_glossary?: boolean
  cite_keys?: string[]
}

export const paperProposalApi = {
  generate: (pid: string, body: GenerateProposalInput) =>
    req<{ proposal: PaperProposal }>(`/api/projects/${encodeURIComponent(pid)}/paper-proposals/generate`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  generateStream: (pid: string, body: GenerateProposalInput, opts?: SseOptions) =>
    postSse<{ proposal: PaperProposal }>(
      `/api/projects/${encodeURIComponent(pid)}/paper-proposals/generate/stream`,
      body,
      opts,
    ),
  list: (pid: string, params?: { status?: string; file?: string }) => {
    const q = new URLSearchParams()
    if (params?.status) q.set('status', params.status)
    if (params?.file) q.set('file', params.file)
    const qs = q.toString()
    return req<{ proposals: PaperProposal[] }>(
      `/api/projects/${encodeURIComponent(pid)}/paper-proposals${qs ? `?${qs}` : ''}`,
    )
  },
  setStatus: (pid: string, proposalId: string, status: 'applied' | 'rejected' | 'stale' | 'undone', appliedText?: string) =>
    req<{ proposal: PaperProposal }>(
      `/api/projects/${encodeURIComponent(pid)}/paper-proposals/${encodeURIComponent(proposalId)}/status`,
      { method: 'POST', body: JSON.stringify({ status, applied_text: appliedText ?? null }) },
    ),
  /** 修复验证闭环：重编译并对照 error_context 判定目标错误是否消失（服务端同步跑构建）。 */
  verifyFix: (pid: string, proposalId: string) =>
    req<{ verification: FixVerification; proposal: PaperProposal }>(
      `/api/projects/${encodeURIComponent(pid)}/paper-proposals/${encodeURIComponent(proposalId)}/verify-fix`,
      { method: 'POST', body: JSON.stringify({}) },
    ),
  /** 只读生成 AI 使用披露声明（基于项目真实提案台账，支持中英 × Markdown/LaTeX）。 */
  disclosure: (pid: string, params?: { lang?: 'zh' | 'en'; format?: 'markdown' | 'latex' }) => {
    const q = new URLSearchParams()
    if (params?.lang) q.set('lang', params.lang)
    if (params?.format) q.set('format', params.format)
    const qs = q.toString()
    return req<AiDisclosureResponse>(
      `/api/projects/${encodeURIComponent(pid)}/paper-proposals/disclosure${qs ? `?${qs}` : ''}`,
    )
  },
}

/** 论文精读（只读分析，不产生提案、不修改文档）。 */
export const assistantApi = {
  read: (pid: string, body: { mode: 'latex' | 'word'; file: string; text: string; question?: string }) =>
    req<{ answer: string; model: string; chars: number }>(
      `/api/projects/${encodeURIComponent(pid)}/paper-assistant/read`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  readStream: (
    pid: string,
    body: { mode: 'latex' | 'word'; file: string; text: string; question?: string },
    opts?: SseOptions,
  ) =>
    postSse<{ answer: string; model: string; chars: number }>(
      `/api/projects/${encodeURIComponent(pid)}/paper-assistant/read/stream`,
      body,
      opts,
    ),
}

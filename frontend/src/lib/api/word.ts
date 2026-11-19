import { P, req } from './net'
import type { Settings } from '../types'

export interface WordProjectCreated {
  id: string
  title: string
  source_format: 'docx'
  settings?: Settings
}

export interface WordVersion {
  id: string
  sha: string
  created_at: string
  source: string
}

export interface WordState {
  sha: string
  version: number
  updated_at: string
  /** 当前 DS 文档会话键（文献桥任务箱绑定用；只读，不触发会话轮换） */
  doc_key?: string | null
  saving?: boolean
  last_error?: string | null
  last_saved_request_id?: string | null
  versions: WordVersion[]
}

/** 由服务端签名的完整编辑配置；客户端只补充 UI 事件，不覆盖权限或令牌。 */
export interface WordEditorConfig {
  document_server_url: string
  config: {
    document?: { permissions?: { edit?: boolean; review?: boolean; download?: boolean }; [key: string]: unknown }
    editorConfig?: { mode?: string; [key: string]: unknown }
    [key: string]: unknown
  }
}

export interface WordPreflightItem {
  rule_id: string
  status: 'pass' | 'warn' | 'unknown'
  evidence: string
  source: string
}

export interface WordPreflightReport {
  schema: string
  project_id: string
  version: number
  sha256: string
  ruleset_id: string
  ruleset_version: string
  generated_at: string
  items: WordPreflightItem[]
  parse_error?: string
}

export interface WordPreflightPost {
  report: WordPreflightReport
  /** 写报告时核对当前快照：报告对应旧快照 → true（如实返回，不无条件置 false） */
  expired: boolean
  /** 旧快照结果未覆盖已存在的较新报告 → true */
  superseded: boolean
  current: { version: number; sha256: string }
}

export interface WordPreflightGet {
  report: WordPreflightReport
  expired: boolean
  current: { version: number; sha256: string; saving?: boolean }
}

/** 规则集（多规则集架构，backend domain/word_preflight.py RULESETS） */
export type WordPreflightRuleset = 'jcip-preflight' | 'cn-general' | 'double-blind'

export interface WordPreflightRunOptions {
  ruleset?: WordPreflightRuleset
  /** 双盲匿名检查屏蔽词（缺省取项目设置 studio.json 的 blind_terms） */
  blind_terms?: string[]
}

/** POST /word/upload-version 返回：state 为服务端最新快照（含 versions，触发体检报告过期判定） */
export interface WordUploadResult {
  version: number
  sha: string
  doc_key?: string | null
  /** 上传内容与当前版本一致 → 幂等未新增版本 */
  unchanged: boolean
  state: WordState
}

/** 引用样式（与 LibraryPanel 的 CitationStyle 同构；此处独立定义避免组件依赖倒挂） */
/** 与后端 word_citations.STYLES / CitationStyle（LibraryPanel）一一对应。 */
export type WordCitationStyle = 'gb-t-7714-2015' | 'ieee' | 'springer-lncs' | 'acm' | 'elsevier-vancouver'

/** POST /word/renumber-citations 返回（P1-0-B）：正文引用按首次出现序重排 */
export interface WordRenumberResult {
  /** DOCX 字节或引用顺序表有变化；false = 引用已按出现序排列（幂等未改） */
  changed: boolean
  /** {旧编号: 新编号}（字符串键，按旧编号数值序） */
  mapping: Record<string, string>
  /** 新引用顺序表（reference_id；已引用按出现序在前，未引用保持追加在后） */
  order: string[]
  /** 托管参考文献表是否已按新顺序重建 */
  rebuilt_block: boolean
  state: WordState
  warnings: string[]
  doc_key?: string | null
}

export const wordApi = {
  create: (input: { title: string; template: string; venue?: string; field?: string; rank?: string }) =>
    req<WordProjectCreated>('/api/projects/word/create', { method: 'POST', body: JSON.stringify(input) }),
  import: (file: File, title?: string) => {
    const body = new FormData()
    body.append('file', file)
    if (title) body.append('title', title)
    return req<WordProjectCreated>('/api/projects/word/import', { method: 'POST', body })
  },
  editorConfig: (pid: string) => req<WordEditorConfig>(`${P(pid)}/word/editor-config`),
  state: (pid: string) => req<WordState>(`${P(pid)}/word/state`),
  save: (pid: string) => req<{ pending: boolean; request_id?: string }>(`${P(pid)}/word/save`, { method: 'POST', body: '{}' }),
  /** 桌面 Word/WPS 往返：上传本地修改稿为新版本；expected_sha 过期或 DS 回传中时后端 409 */
  uploadVersion: (pid: string, file: File, expectedSha?: string) => {
    const body = new FormData()
    body.append('file', file)
    if (expectedSha) body.append('expected_sha', expectedSha)
    return req<WordUploadResult>(`${P(pid)}/word/upload-version`, { method: 'POST', body })
  },
  downloadUrl: (pid: string) => `${P(pid)}/word/download`,
  versionDownloadUrl: (pid: string, id: string) => `${P(pid)}/word/versions/${encodeURIComponent(id)}/download`,
  /** 按正文首次出现顺序重排全文引用编号（服务端 OOXML 确定性重排；有变化时轮换 doc_key） */
  renumberCitations: (pid: string, opts?: { style?: WordCitationStyle; expected_sha?: string }) =>
    req<WordRenumberResult>(`${P(pid)}/word/renumber-citations`, { method: 'POST', body: JSON.stringify(opts ?? {}) }),
  exportPdf: (pid: string) => req<{ url: string; sha: string }>(`${P(pid)}/word/export/pdf`, { method: 'POST', body: '{}' }),
  convertStructured: (pid: string) => req<WordProjectCreated>(`${P(pid)}/word/convert-structured`, { method: 'POST', body: '{}' }),
  /** ruleset 缺省 = jcip-preflight（后端空 body 语义一致，旧行为不变） */
  runPreflight: (pid: string, opts?: WordPreflightRunOptions) =>
    req<WordPreflightPost>(`${P(pid)}/word/preflight`, { method: 'POST', body: JSON.stringify(opts ?? {}) }),
  getPreflight: (pid: string, ruleset?: WordPreflightRuleset) =>
    req<WordPreflightGet>(`${P(pid)}/word/preflight${ruleset ? `?ruleset=${encodeURIComponent(ruleset)}` : ''}`),
}

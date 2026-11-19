import { req, P } from './net'

/** v0.1 proto：结构化中文论文（实验）API——创建 / 内容读写（乐观并发）/ 版本 / 资源 / 导出。
 *  后端开关 PATENT_STUDIO_STRUCT_WRITER=on；关闭时端点 404，入口由 /api/meta.struct_writer 隐藏。 */

export interface StructVersion {
  vid: string
  sha: string
  at: number
  source: string
}

export interface StructGate {
  ok: boolean
  errors: string[]
  warnings: string[]
}

export type StructBlock =
  | { type: 'h1' | 'h2'; text: string }
  | { type: 'p'; text: string }
  | { type: 'formula'; id: string; latex: string }
  | { type: 'figure'; id: string; resource: string; caption: string }
  | { type: 'table'; id: string; caption: string; header: string[]; rows: string[][] }

export interface StructContent {
  schema_version: number
  title: string
  title_en: string
  authors: string
  affil: string
  abstract_zh: string
  abstract_en: string
  keywords: string
  body: StructBlock[]
}

export interface StructContentReply {
  content: StructContent
  sha: string
  versions: StructVersion[]
}

export interface StructSaveReply {
  saved: boolean
  version: StructVersion
  sha: string
  gate: StructGate
}

export interface StructResourceReply {
  rid: string
  ext: string
  bytes: number
}

export interface StructArtifactManifest {
  pid: string
  artifact: string
  mode: 'tab' | 'table'
  profile: string
  content_sha256: string
  docx_sha256: string
  at: number
  stale: boolean
  engine: string
  resources?: Record<string, string>
  pandoc_version?: string
}

export interface StructExportReply {
  docxUrl: string
  manifest: StructArtifactManifest
}

export interface StructArtifactsReply {
  artifacts: StructArtifactManifest[]
  current_sha: string
}

export interface StructPdfReply {
  pdfUrl: string
  bytes: number
  engine: string
}

export interface StructPreviewReply {
  status: 'ok' | 'cached'
  sha: string
  vid: string
  mode: 'tab' | 'table'
  pdfUrl: string
  bytes: number
  duration_ms: number
}

export interface PaperTemplateInfo {
  id: string
  name: string
  desc: string
  language: string
  kind: string
  venue: string
  /** 版本年份（滚动模板标 master 实际取用年；未标注=通用骨架） */
  year?: string
  /** review/final 模式说明 */
  mode?: string
  /** 官方来源（仅 verified 模板给出可溯源地址） */
  source?: string
  /** verified=镜像内真实编译验证；link-only=仅官方链接待验证（不可创建） */
  verify: 'verified' | 'link-only' | 'unverified'
  /** 服务端已生成首页缩略图（缺失时前端回退图标，不发 404 请求） */
  thumb?: boolean
  version?: number
  updated_at?: number | null
}

export interface StructProfileInfo {
  id: string
  name: string
  desc: string
  experimental: boolean
}

export interface PaperTemplatesReply {
  latex: PaperTemplateInfo[]
  struct: StructProfileInfo[]
  word?: { id: string; name: string; desc: string; venue?: string; thumb?: boolean; version?: number; updated_at?: number | null }[]
}

export const structApi = {
  /** 统一新建入口的模板注册表（LaTeX 模板 + 结构化 profile；结构化仅在开关开启时返回） */
  paperTemplates() {
    return req<PaperTemplatesReply>('/api/paper-templates')
  },

  create(title: string, meta?: { venue?: string; field?: string; rank?: string }) {
    return req<{ id: string; title: string; settings: { source_format: string } }>(
      '/api/projects/struct/create',
      { method: 'POST', body: JSON.stringify({ title, ...meta }) },
    )
  },

  getContent(pid: string) {
    return req<StructContentReply>(`${P(pid)}/struct/content`)
  },

  /** 乐观并发：base_sha 不匹配 → 409（detail.detail = 当前 sha，供「基于最新版重试」） */
  putContent(pid: string, content: StructContent, baseSha: string | null) {
    return req<StructSaveReply>(`${P(pid)}/struct/content`, {
      method: 'PUT',
      body: JSON.stringify({ content, base_sha: baseSha }),
    })
  },

  uploadResource(pid: string, file: File) {
    const fd = new FormData()
    fd.append('file', file)
    return req<StructResourceReply>(`${P(pid)}/struct/resources`, { method: 'POST', body: fd })
  },

  /** 导出被门禁阻断时后端 422（detail.message 逐条列阻断原因），由调用方 catch 呈现 */
  exportDocx(pid: string, mode: 'tab' | 'table') {
    return req<StructExportReply>(`${P(pid)}/struct/export/docx?mode=${mode}`, { method: 'POST' })
  },

  artifacts(pid: string) {
    return req<StructArtifactsReply>(`${P(pid)}/struct/artifacts`)
  },

  /** 未配置 STRUCT_PDF_SVC_URL 时 501（DOCX 仍可下载，本地另存为 PDF 兜底） */
  exportPdf(pid: string, docx: string) {
    return req<StructPdfReply>(`${P(pid)}/struct/export/pdf`, {
      method: 'POST',
      body: JSON.stringify({ docx }),
    })
  },

  /** 投稿版预览：对服务器已保存快照走与导出完全相同的链路（DOCX→sidecar PDF），按 content sha 缓存。
   *  同案已有任务运行时 409（detail.detail=运行中 sha）；生成期间内容变化服务端丢弃并 409（stale）。 */
  preview(pid: string) {
    return req<StructPreviewReply>(`${P(pid)}/struct/preview`, { method: 'POST' })
  },
}

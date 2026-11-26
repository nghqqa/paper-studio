import { req } from './net'

export interface ManagedPaperTemplate {
  id: string
  format: 'docx' | 'latex'
  name: string
  desc: string
  venue?: string
  language?: string
  kind?: string
  year?: string
  main?: string
  engine?: 'pdflatex' | 'xelatex'
  origin: 'builtin' | 'upload'
  enabled: boolean
  verify: string
  /** 最近一次验收失败原因（成功时为空；verify=verified 后不再展示） */
  verify_error?: string | null
  verified_at?: number | null
  /** 替换版本时自增（上传为 1）；缩略图 URL 用它做缓存击穿 */
  version?: number
  /** 最近替换/改主文件时间（epoch 秒） */
  updated_at?: number | null
  /** 服务端已生成首页缩略图（isfile 实时判定） */
  thumb?: boolean
  /** 仅管理端列表返回：最近一次验收失败日志尾部（作者目录不含） */
  verify_log_tail?: string | null
}

export interface PaperTemplateVerifyResult extends ManagedPaperTemplate {
  status: 'ok' | 'error'
  duration_ms: number
  log_tail: string
}

export interface PaperTemplatePatch {
  name?: string
  desc?: string
  venue?: string
  language?: string
  kind?: string
  year?: string
  main?: string
  engine?: 'pdflatex' | 'xelatex'
  enabled?: boolean
}

export interface PaperTemplateReplaceMeta {
  main?: string | null
  engine?: 'pdflatex' | 'xelatex' | null
}

export interface PaperTemplateListReply {
  items: ManagedPaperTemplate[]
  /** 服务端自动验收开关（开启时面板轮询刷新验收状态与缩略图） */
  auto_accept: boolean
}

export interface PaperTemplateInput {
  format: 'docx' | 'latex'
  name: string
  desc: string
  venue: string
  language: string
  kind: string
  main: string
  engine: 'pdflatex' | 'xelatex'
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

export interface PaperTemplatesReply {
  latex: PaperTemplateInfo[]
  word?: { id: string; name: string; desc: string; venue?: string; thumb?: boolean; version?: number; updated_at?: number | null }[]
}

const BASE = '/api/admin/paper-templates'
const path = (t: Pick<ManagedPaperTemplate, 'format' | 'id'>) => `${BASE}/${t.format}/${encodeURIComponent(t.id)}`

/** 缩略图 URL：v/t 双参数确保替换版本后浏览器立即重新拉取（配合服务端 ETag 弱缓存） */
export const thumbUrl = (t: Pick<ManagedPaperTemplate, 'format' | 'id' | 'version' | 'updated_at'>) =>
  `/api/paper-templates/${t.format}/${encodeURIComponent(t.id)}/thumbnail?v=${t.version ?? 1}&t=${t.updated_at ?? 0}`

export const paperTemplatesApi = {
  catalogue: () => req<PaperTemplatesReply>('/api/paper-templates'),
  list: () => req<PaperTemplateListReply>(BASE),
  upload: (metadata: PaperTemplateInput, file: File) => {
    const body = new FormData()
    body.append('metadata', JSON.stringify(metadata))
    body.append('file', file)
    return req<ManagedPaperTemplate>(BASE, { method: 'POST', body })
  },
  remove: (t: ManagedPaperTemplate) => req<ManagedPaperTemplate>(path(t), { method: 'DELETE' }),
  restore: (t: ManagedPaperTemplate) => req<ManagedPaperTemplate>(path(t), { method: 'PATCH', body: JSON.stringify({ enabled: true }) }),
  /** 元信息部分更新：None/缺省字段不修改；兼容旧 {"enabled": bool} 体 */
  updateMeta: (t: ManagedPaperTemplate, patch: PaperTemplatePatch) =>
    req<ManagedPaperTemplate>(path(t), { method: 'PATCH', body: JSON.stringify(patch) }),
  /** 替换上传模板版本（仅 origin=upload）：version 自增、verify 重置、失败完整回滚 */
  replaceFile: (t: ManagedPaperTemplate, file: File, meta?: PaperTemplateReplaceMeta) => {
    const body = new FormData()
    if (meta && (meta.main != null || meta.engine != null)) body.append('metadata', JSON.stringify(meta))
    body.append('file', file)
    return req<ManagedPaperTemplate>(`${path(t)}/file`, { method: 'PUT', body })
  },
  /** 验证编译：真实跑一遍 latexmk；成功 ⇒ 注册「已验证编译」并产出首页缩略图 */
  verify: (t: ManagedPaperTemplate) => req<PaperTemplateVerifyResult>(`${path(t)}/verify`, { method: 'POST' }),
  /** Word「生成预览」：ONLYOFFICE 转换验收 + 首页缩略图（失败返回可读原因，不抛错） */
  preview: (t: ManagedPaperTemplate) => req<PaperTemplateVerifyResult>(`${path(t)}/preview`, { method: 'POST' }),
}

import { req } from './net'

/** w21 批A：LaTeX 工程最小闭环 API（文件清单 / 文本读写 / 手动编译 / 构建历史与产物）。 */

export interface LatexFileInfo {
  path: string
  size: number
  editable: boolean
}

export interface LatexFileRead {
  path: string
  content: string
  sha: string
}

export interface LatexDiagnostic {
  file: string
  line: number | null
  message: string
}

export interface LatexBuildInfo {
  build_id: string
  pid: string
  engine: string
  main: string
  status: 'ok' | 'error' | 'running' | 'canceled'
  error: string | null
  started_at: string
  duration_ms: number
  digest: Record<string, string>
  diagnostics?: LatexDiagnostic[]
  stale?: boolean
}

export interface LatexBuildOutcome extends LatexBuildInfo {
  pdf_url: string | null
  log_url: string
}

export interface LatexBuildsReply {
  builds: LatexBuildInfo[]
  latest_ok_build_id: string | null
}

/** DOCX 实验性导出（jcip profile；PATENT_STUDIO_DOCX_EXPORT=on 才可用） */
export interface DocxExportManifest {
  export_id: string
  pid: string
  venue: string
  venue_display: string
  main: string
  digest: Record<string, string>
  status: 'pass' | 'degraded' | 'blocked'
  export_status: string
  degrades: string[]
  artifacts: Record<string, string>
  stale?: boolean
}

/** 通用 Word 导出（v0.6.7 导师阅读版；pandoc 默认样式 + 工程自带 .bib citeproc） */
export interface WordExportManifest {
  export_id: string
  pid: string
  main: string
  digest: Record<string, string>
  status: 'pass' | 'degraded' | 'blocked'
  degrades: string[]
  tool: { pandoc: string; runtime: string; exit_code: number; duration_ms: number }
  artifacts: Record<string, string>
  stale?: boolean
}

export interface ImportStaged {
  token: string
  filename: string
  files: { path: string; size: number; editable: boolean }[]
  main_candidates: string[]
  excluded: { path: string; reason: string }[]
  skipped: string[]
  sha256: string
}

export interface LatexIssue {
  id: string
  file: string | null
  line: number | null
  message: string
  status: 'open' | 'resolved'
  created_at: number
  resolved_at: number | null
}

/** 版本历史（backend/app/domain/latex_history.py）：行数跨全部文件求和，files=变化文件数 */
export interface LatexVersion {
  sha: string
  at: number
  message: string
  author: string
  added: number
  deleted: number
  files: number
}

/** 投稿前检查（只读体检，backend/app/domain/latex_preflight.py）：条目结构与 Word 侧同构 */
export type LatexPreflightRuleset = 'latex-general' | 'double-blind'

export interface LatexPreflightItem {
  rule_id: string
  status: 'pass' | 'warn' | 'unknown'
  evidence: string
  source: string
}

export interface LatexPreflightReport {
  schema: string
  project_id: string
  ruleset_id: string
  ruleset_version: string
  generated_at: string
  /** 被扫描文件的内容哈希（latex-general=.tex+.bib；double-blind=.tex） */
  digest: Record<string, string>
  digest_sha: string
  items: LatexPreflightItem[]
  parse_error?: string
}

export interface LatexPreflightPost {
  report: LatexPreflightReport
  /** 写报告前核对当前源码指纹：检查期间源文件变化 → true（如实返回） */
  expired: boolean
  /** 旧指纹结果未覆盖已存在的较新报告 → true */
  superseded: boolean
  current: { digest_sha: string }
}

export interface LatexPreflightGet {
  report: LatexPreflightReport
  expired: boolean
  current: { digest_sha: string }
}

const enc = encodeURIComponent
/** 相对路径按段编码（'/' 保留为分隔符） */
const encPath = (rel: string) => rel.split('/').map(enc).join('/')

export const latexApi = {
  files: (pid: string) => req<{ files: LatexFileInfo[] }>(`/api/projects/${enc(pid)}/latex/files`),
  read: (pid: string, rel: string) =>
    req<LatexFileRead>(`/api/projects/${enc(pid)}/latex/files/${encPath(rel)}`),
  save: (pid: string, rel: string, content: string, base?: string) =>
    req<{ ok: boolean; path: string; sha: string }>(`/api/projects/${enc(pid)}/latex/files/${encPath(rel)}`, {
      method: 'PUT',
      body: JSON.stringify({ content, base }),
    }),
  build: (pid: string, engine?: string) =>
    req<LatexBuildOutcome>(`/api/projects/${enc(pid)}/latex/build`, {
      method: 'POST',
      body: JSON.stringify({ engine: engine ?? null }),
    }),
  /** 中止进行中的编译（构建请求随后以 status=canceled 返回；无进行中编译 409） */
  cancelBuild: (pid: string) =>
    req<{ ok: true }>(`/api/projects/${enc(pid)}/latex/builds/cancel`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  builds: (pid: string) => req<LatexBuildsReply>(`/api/projects/${enc(pid)}/latex/builds`),

  /* ---- 版本历史（防丢稿：编译必快照；保存 90s 合并；结构性操作立即提交） ---- */
  history: (pid: string) => req<LatexVersion[]>(`/api/projects/${enc(pid)}/latex/history`),
  historyDiff: (pid: string, a: string, b = 'work') =>
    req<{ a: string; b: string; diff: string }>(
      `/api/projects/${enc(pid)}/latex/history/diff?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`,
    ),
  /** 恢复整树到目标版本（工作区精确回到目标状态；多余文件删除） */
  restoreVersion: (pid: string, sha: string) =>
    req<{ ok: true; sha_new: string; changed: boolean; written: number; deleted: string[] }>(
      `/api/projects/${enc(pid)}/latex/history/${encodeURIComponent(sha)}/restore`,
      { method: 'POST', body: JSON.stringify({}) },
    ),
  /** DOCX 实验性导出：同步执行（jcip 管线，docker），blocked 时也有 manifest */
  exportDocx: (pid: string) =>
    req<DocxExportManifest>(`/api/projects/${enc(pid)}/latex/export-docx`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  docxExports: (pid: string) =>
    req<{ exports: DocxExportManifest[] }>(`/api/projects/${enc(pid)}/latex/docx-exports`),
  /** 通用 Word 导出（v0.6.7 导师阅读版）：同步 pandoc；产物为转换语义而非排版结果，需人工核对 */
  exportWord: (pid: string) =>
    req<WordExportManifest>(`/api/projects/${enc(pid)}/latex/export-word`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  wordExports: (pid: string) =>
    req<{ exports: WordExportManifest[] }>(`/api/projects/${enc(pid)}/latex/word-exports`),
  wordArtifactUrl: (pid: string, eid: string, name: string) =>
    `/api/projects/${enc(pid)}/latex/word-exports/${enc(eid)}/artifacts/${enc(name)}`,
  /** 受限 LaTeX ZIP 导入：两段式（upload 校验暂存 → create 建项） */
  importUpload: (file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return req<ImportStaged>('/api/projects/latex/import/upload', { method: 'POST', body: fd })
  },
  importCreate: (token: string, main: string, engine: string, title: string) =>
    req<{ id: string; title: string; source_format: string; latex: { main: string; engine: string } }>(
      '/api/projects/latex/import/create',
      { method: 'POST', body: JSON.stringify({ token, main, engine, title }) },
    ),

  /* ---- Word(.docx) → LaTeX 导入（v0.6.8；两段式同 ZIP；CJK 自动建议 ctexart+xelatex） ---- */
  importDocxUpload: (file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return req<ImportStaged & { warnings: string[]; engine: string; cjk: boolean }>(
      '/api/projects/latex/import-docx/upload', { method: 'POST', body: fd })
  },
  importDocxCreate: (token: string, engine: string, title: string) =>
    req<{ id: string; title: string; source_format: string; latex: { main: string; engine: string } }>(
      '/api/projects/latex/import-docx/create',
      { method: 'POST', body: JSON.stringify({ token, engine, title }) },
    ),

  /* ---- per-project GitHub/Gitea 推拉（v0.6.8；token 永不回传，仅 has_token） ---- */
  gitStatus: (pid: string) =>
    req<{ remote: { url: string; branch: string; has_token: boolean } | null; ahead: number | null; behind: number | null; head: string | null }>(
      `/api/projects/${enc(pid)}/latex/git`),
  gitSetRemote: (pid: string, url: string, branch: string, token: string) =>
    req<{ ok: true; remote: { url: string; branch: string; has_token: boolean } }>(
      `/api/projects/${enc(pid)}/latex/git/remote`,
      { method: 'PUT', body: JSON.stringify({ url, branch, token }) }),
  gitDeleteRemote: (pid: string) =>
    req<{ ok: true; removed: boolean }>(`/api/projects/${enc(pid)}/latex/git/remote`, { method: 'DELETE', body: JSON.stringify({}) }),
  gitPush: (pid: string, force = false) =>
    req<{ ok: true; sha: string; committed: boolean; forced?: boolean }>(`/api/projects/${enc(pid)}/latex/git/push`, { method: 'POST', body: JSON.stringify({ force }) }),
  gitPull: (pid: string, force = false) =>
    req<{ ok: true; changed: boolean; ahead: number; behind: number; sha?: string; note?: string; forced?: boolean }>(
      `/api/projects/${enc(pid)}/latex/git/pull`, { method: 'POST', body: JSON.stringify({ force }) }),
  docxArtifactUrl: (pid: string, eid: string, name: string) =>
    `/api/projects/${enc(pid)}/latex/docx-exports/${enc(eid)}/artifacts/${enc(name)}`,
  /** 按模板创建 LaTeX 工程（v0.1.5 统一新建入口；blank=最小 ctex 骨架 / jcip=中文论文示例 / ieee=IEEEtran）
   *  合法分发：IEEEtran v1.8b（LPPL 1.3），见后端 app/latex_seed SOURCES.md。不传 template 保持旧语义（ieee） */
  createDemo: (template?: string, title?: string) =>
    req<{ id: string; title: string; source_format: string; latex: { main: string; engine: string } }>(
      '/api/projects/latex-demo',
      { method: 'POST', body: JSON.stringify({ template, title }) },
    ),
  /** v0.2：编译设置（主文件/引擎）——PUT /settings 部分合并，不影响其他键 */
  updateBuildSettings: (pid: string, main: string, engine: string) =>
    req<{ settings: { latex: { main: string; engine: string } } }>(
      `/api/projects/${encodeURIComponent(pid)}/settings`,
      { method: 'PUT', body: JSON.stringify({ latex: { main, engine } }) },
    ),
  /** 中文论文示例（实验）：jcip profile 形态合成示例（自撰合成内容），适配 DOCX 实验导出 */
  createJcipDemo: () =>
    req<{ id: string; title: string; source_format: string; latex: { main: string; engine: string } }>(
      '/api/projects/jcip-demo',
      { method: 'POST', body: JSON.stringify({}) },
    ),

  /* ---- 工程文件面板（v0.4.2 CoCraft 式）：新建 / 上传 / ZIP 合并 / 整包下载 / Issues ---- */
  createFile: (pid: string, rel: string, content = '') =>
    req<{ ok: true; path: string }>(`/api/projects/${enc(pid)}/latex/files/${rel.split('/').map(encodeURIComponent).join('/')}`,
      { method: 'POST', body: JSON.stringify({ content }) }),
  uploadFile: (pid: string, rel: string, file: File, overwrite = false) => {
    const body = new FormData()
    body.append('rel', rel)
    body.append('overwrite', String(overwrite))
    body.append('file', file)
    return req<{ ok: true; path: string }>(`/api/projects/${enc(pid)}/latex/upload`, { method: 'POST', body })
  },
  uploadZipMerge: (pid: string, file: File) => {
    const body = new FormData()
    body.append('file', file)
    return req<{ added: string[]; skipped_existing: string[]; skipped_rejected: string[] }>(
      `/api/projects/${enc(pid)}/latex/upload-zip`, { method: 'POST', body })
  },
  exportZipUrl: (pid: string) => `/api/projects/${enc(pid)}/latex/export-zip`,
  issues: (pid: string) => req<{ issues: LatexIssue[] }>(`/api/projects/${enc(pid)}/latex/issues`),
  addIssue: (pid: string, body: { message: string; file?: string | null; line?: number | null }) =>
    req<LatexIssue>(`/api/projects/${enc(pid)}/latex/issues`, { method: 'POST', body: JSON.stringify(body) }),
  resolveIssue: (pid: string, id: string, resolved: boolean) =>
    req<LatexIssue>(`/api/projects/${enc(pid)}/latex/issues/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify({ resolved }) }),
  deleteIssue: (pid: string, id: string) =>
    req<{ ok: true }>(`/api/projects/${enc(pid)}/latex/issues/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /** SyncTeX 正向：源码行 → PDF 页 + 72dpi 坐标 */
  synctexView: (pid: string, buildId: string, file: string, line: number) =>
    req<{ page: number; x: number; y: number }>(
      `/api/projects/${enc(pid)}/latex/builds/${encodeURIComponent(buildId)}/synctex/view`,
      { method: 'POST', body: JSON.stringify({ file, line }) },
    ),
  /** SyncTeX 反向：PDF 页 + 72dpi 坐标 → 源码行 */
  synctexEdit: (pid: string, buildId: string, page: number, x: number, y: number) =>
    req<{ file: string; line: number }>(
      `/api/projects/${enc(pid)}/latex/builds/${encodeURIComponent(buildId)}/synctex/edit`,
      { method: 'POST', body: JSON.stringify({ page, x, y }) },
    ),
  /** 重命名/移动源文件（主文件自动同步编译设置） */
  renameFile: (pid: string, rel: string, newPath: string) =>
    req<{ ok: true; path: string; main_updated: boolean }>(
      `/api/projects/${enc(pid)}/latex/files/${encPath(rel)}/rename`,
      { method: 'POST', body: JSON.stringify({ new_path: newPath }) },
    ),
  /** 删除源文件（主文件会被 409 拒绝） */
  deleteFile: (pid: string, rel: string) =>
    req<{ ok: true }>(`/api/projects/${enc(pid)}/latex/files/${encPath(rel)}`, { method: 'DELETE' }),
  /** AI 审稿当前文件全文（前端须先弹窗确认外发范围）→ 问题清单逐条落为 Issue */
  aiReview: (pid: string, file: string, content: string) =>
    req<{ added: number; issues: LatexIssue[] }>(`/api/projects/${enc(pid)}/latex/ai-review`,
      { method: 'POST', body: JSON.stringify({ file, content }) }),

  /* ---- 投稿前检查（只读体检；ruleset 缺省 = latex-general） ---- */
  runPreflight: (pid: string, opts?: { ruleset?: LatexPreflightRuleset; blind_terms?: string[] }) =>
    req<LatexPreflightPost>(`/api/projects/${enc(pid)}/latex/preflight`,
      { method: 'POST', body: JSON.stringify(opts ?? {}) }),
  getPreflight: (pid: string, ruleset?: LatexPreflightRuleset) =>
    req<LatexPreflightGet>(`/api/projects/${enc(pid)}/latex/preflight${ruleset ? `?ruleset=${encodeURIComponent(ruleset)}` : ''}`),
}

import { req } from './net'

/** 科研图表行。chart（数据图）行保持 v0.3 原字段；diagram（方法图）行多出 kind/version 等键，
 *  旧数据（无 kind）一律视为 chart —— 与后端读端缺省口径一致。 */
export type FigurePalette = 'default' | 'academic' | 'colorblind' | 'grayscale'

export interface ProjectFigure {
  id: string
  name: string
  type?: 'line' | 'bar' | 'scatter' | 'pie'
  title?: string
  x_label?: string
  y_label?: string
  categories?: string[]
  series?: { name: string; values: number[] }[]
  palette?: FigurePalette
  kind?: 'chart' | 'diagram'
  version?: number
  updated_at?: number
  width_px?: number
  height_px?: number
  created_at: number
  bytes: number
}

export interface DiagramPayload {
  scene: string
  png_data_url: string
}

const P = (pid: string) => `/api/project-figures/${encodeURIComponent(pid)}`

export const figuresApi = {
  list: (pid: string) => req<{ figures: ProjectFigure[] }>(P(pid)),
  create: (pid: string, body: { name: string; type: string; title: string; x_label: string; y_label: string; categories: string[]; series: { name: string; values: number[] }[]; palette?: FigurePalette }) =>
    req<{ figure: ProjectFigure }>(P(pid), { method: 'POST', body: JSON.stringify(body) }),
  createDiagram: (pid: string, body: { name: string } & DiagramPayload) =>
    req<{ figure: ProjectFigure }>(P(pid), { method: 'POST', body: JSON.stringify({ kind: 'diagram', ...body }) }),
  /** 方法图原地更新（乐观并发）；409 detail.kind=version_conflict 表示他人已更新。 */
  updateDiagram: (pid: string, fid: string, body: DiagramPayload & { name?: string; expected_version: number }) =>
    req<{ figure: ProjectFigure }>(`${P(pid)}/${encodeURIComponent(fid)}`, { method: 'PUT', body: JSON.stringify(body) }),
  getScene: (pid: string, fid: string) =>
    req<{ id: string; name: string; version: number; updated_at?: number; scene: string }>(`${P(pid)}/${encodeURIComponent(fid)}/scene`),
  publishLatex: (pid: string, fid: string, body: { stem?: string; overwrite?: boolean } = {}) =>
    req<{ ok: boolean; path: string; stem: string; snippet: string }>(`${P(pid)}/${encodeURIComponent(fid)}/publish-latex`, { method: 'POST', body: JSON.stringify(body) }),
  remove: (pid: string, fid: string) => req<{ ok: boolean }>(`${P(pid)}/${encodeURIComponent(fid)}`, { method: 'DELETE' }),
  /** v 参数 = 版本号缓存破：原地更新后浏览器不得复用旧 PNG。 */
  pngUrl: (pid: string, fid: string, version?: number) =>
    `${P(pid)}/${encodeURIComponent(fid)}/png${version ? `?v=${version}` : ''}`,
  exportUrl: (pid: string, fid: string, format: 'png' | 'pdf' | 'svg', dpi = 300) =>
    `${P(pid)}/${encodeURIComponent(fid)}/export?format=${format}&dpi=${dpi}`,
}

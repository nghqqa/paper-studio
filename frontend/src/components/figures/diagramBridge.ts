/** 方法图编辑器的 Excalidraw 桥接：场景序列化 / 恢复 / 高清导出 / Mermaid 初始生成。
 *  自包含于 paper 线（figures/），不依赖 figure-book（专利线）代码。
 *  本模块只被 lazy 的 DiagramEditor chunk 消费，@excalidraw/* 不会进工作台首包。 */
import { serializeAsJSON } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'

export type DiagramApi = ExcalidrawImperativeAPI
export type SceneData = {
  elements: readonly unknown[]
  appState?: Record<string, unknown>
  files?: Record<string, unknown>
}

/** 导出档位：从 2x 起步，超字节/像素上限逐档下调（服务端硬上限 5MB / 1600 万像素）。 */
const EXPORT_SCALES = [2, 1.5, 1]
const MAX_PNG_BYTES = 4.5 * 1024 * 1024 // 前端预判留余量
const MAX_PNG_PIXELS = 16_000_000
const MAX_EXPORT_SIDE = 8192 // 浏览器 canvas 边长/面积上限防护

/** 画布场景 → .excalidraw JSON 文本（内嵌图片资源 dataURL，作为编辑真源）。 */
export function serializeScene(api: DiagramApi): string {
  return serializeAsJSON(api.getSceneElementsIncludingDeleted(), api.getAppState(), api.getFiles(), 'local')
}

/** 导出白底：canvas/Excalidraw 只认实际色值字符串，运行时从 token 解析（无 DOM 回退 white）。 */
function paperWhite(): string {
  if (typeof window === 'undefined') return 'white'
  return getComputedStyle(document.documentElement).getPropertyValue('--paper').trim() || 'white'
}

/** 画布 → 高清 PNG：逐档导出直到满足上限；全档超限返回末档（由服务端 413 兜底）。 */
export async function exportPng(api: DiagramApi): Promise<{ blob: Blob; scale: number }> {
  const { exportToBlob } = await import('@excalidraw/excalidraw')
  const elements = api.getSceneElements()
  if (!elements.length) throw new Error('画布为空——先绘制内容再保存')
  let fallback: { blob: Blob; scale: number } | null = null
  for (const scale of EXPORT_SCALES) {
    let dims = { width: 0, height: 0 }
    const blob = await exportToBlob({
      elements,
      appState: { exportBackground: true, viewBackgroundColor: paperWhite(), exportWithDarkMode: false, theme: 'light' },
      files: api.getFiles(),
      mimeType: 'image/png',
      exportPadding: 16,
      getDimensions: (w: number, h: number) => {
        const s = Math.min(scale, MAX_EXPORT_SIDE / Math.max(w, h, 1))
        dims = { width: Math.round(w * s), height: Math.round(h * s) }
        return { width: dims.width, height: dims.height, scale: s }
      },
    })
    if (!blob) continue
    const candidate = { blob, scale }
    if (blob.size <= MAX_PNG_BYTES && dims.width * dims.height <= MAX_PNG_PIXELS) return candidate
    fallback = candidate
  }
  if (!fallback) throw new Error('导出失败：画布过大或浏览器 canvas 受限，请缩小内容后重试')
  return fallback
}

/** Blob → dataURL（FileReader 对非本域 Blob 可能不回调，arrayBuffer+btoa 全环境最稳）。 */
export async function blobToDataUrl(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer())
  let bin = ''
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000))
  return `data:${blob.type || 'image/png'};base64,${btoa(bin)}`
}

/** .excalidraw JSON 文本 → 可挂载的 initialData（restore 校验 + files 还原）。 */
export async function restoreScene(text: string): Promise<SceneData> {
  const { restore } = await import('@excalidraw/excalidraw')
  const parsed = JSON.parse(text) as { elements?: never; appState?: Record<string, unknown>; files?: Record<string, unknown> }
  const restored = restore(
    { elements: parsed.elements, appState: parsed.appState ?? {}, files: (parsed.files ?? {}) as never },
    null, null,
  )
  return { elements: restored.elements, appState: restored.appState as Record<string, unknown>, files: restored.files as Record<string, unknown> }
}

/** Mermaid 文本 → Excalidraw 场景（可选初始生成入口；覆盖现有画布前由调用方确认）。 */
export async function mermaidToScene(code: string): Promise<SceneData> {
  const [{ parseMermaidToExcalidraw }, { convertToExcalidrawElements }] = await Promise.all([
    import('@excalidraw/mermaid-to-excalidraw'),
    import('@excalidraw/excalidraw'),
  ])
  const { elements: skeleton, files } = await parseMermaidToExcalidraw(code)
  const elements = convertToExcalidrawElements(skeleton)
  return { elements, files: (files ?? undefined) as Record<string, unknown> | undefined }
}

/** 场景应用到画布（updateScene + addFiles，与 figure-book BoardPage 同款）。 */
export function applyScene(api: DiagramApi, data: SceneData): void {
  api.updateScene({ elements: data.elements as never })
  if (data.files) api.addFiles(Object.values(data.files) as never)
}

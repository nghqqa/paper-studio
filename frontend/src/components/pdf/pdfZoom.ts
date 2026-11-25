/** PDF 预览缩放常量与类型（无全局 store 耦合）。 */
export type ZoomFit = 'width' | 'page' | 'custom'

/** A4 纸宽 210 mm @ 96 dpi 下的 CSS 像素 */
export const A4_WIDTH_PX = 794
export const A4_RATIO = 297 / 210
export const A4_PT_W = 595.28
export const A4_PT_H = 841.89

export const ZOOM_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const
export const ZOOM_MIN = 0.5
export const ZOOM_MAX = 3
export const ZOOM_STEP = 0.1

export function clampZoom(z: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100))
}

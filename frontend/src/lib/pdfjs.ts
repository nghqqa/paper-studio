import { pdfjs } from 'react-pdf'

// react-pdf worker 一次性配置：导入即生效。
// 注意：本模块经由 pdf 预览的 lazy 链引入——pdf.js 需要 DOMMatrix（jsdom 没有），
// 任何非懒加载路径都不得 import 本模块，否则测试环境会被 pdf.js 拉崩。
pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()

/**
 * 全部 react-pdf <Document> 统一使用的渲染参数。
 *
 * cMapUrl/cMapPacked：xelatex/ctex 产出的中文 PDF 使用 Adobe-GB1 集合的 CID 字体
 * （Fandol 系列，Identity-H 且无 ToUnicode），pdf.js 翻译字形时必须能取到 CMap 二进制表，
 * 否则整页中文字形全部空白（v0.1.3 修复的缺陷）。CMap 表由 scripts/sync-pdfjs-cmaps.mjs
 * 在 dev/build 前同步进 public/pdfjs/cmaps，随应用同源自托管（无 CDN 依赖）。
 * LibreOffice 导出的专利 PDF 内嵌字体子集不受影响，多传此参数无副作用。
 */
export const pdfDocumentOptions = { cMapUrl: '/pdfjs/cmaps/', cMapPacked: true as const }

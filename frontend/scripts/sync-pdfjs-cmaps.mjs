// 把 pdfjs-dist 的 CMap 二进制表同步到 public/pdfjs/cmaps（vite 原样拷入 dist）。
// 背景：xelatex/ctex 产出的中文 PDF 用 Adobe-GB1 集合的 CID 字体，pdf.js 需要
// cMapUrl + cMapPacked 才能翻译字形（缺失 ⇒ 预览中文全部空白，见 v0.1.3 修复记录）。
// 版本随锁定的 pdfjs-dist 走：构建/开发前从 node_modules 同步，不提交产物本身。
import { cpSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'node_modules', 'pdfjs-dist', 'cmaps')
const dst = join(root, 'public', 'pdfjs', 'cmaps')

if (!existsSync(src)) {
  console.error('[cmaps] node_modules/pdfjs-dist/cmaps 不存在——先安装依赖')
  process.exit(1)
}
cpSync(src, dst, { recursive: true })
console.log('[cmaps] synced to public/pdfjs/cmaps')

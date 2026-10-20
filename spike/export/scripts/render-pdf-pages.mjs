/**
 * PDF 页面位图渲染（用于人工/程序核对渐变背景是否真的打印出来）。
 * 复现：node scripts/render-pdf-pages.mjs out/export-chrome.pdf pdf-chrome
 * 产物：out/pdf-<prefix>-N.png（1280 宽）+ 每页四角/中心像素统计。
 *
 * 兼容性坑：pdfjs-dist 4.x 内部按 `@napi-rs/canvas` 自建临时 canvas 画渐变，
 * 并访问 `canvas.canvas`（浏览器 Canvas 属性）→ @napi-rs/canvas 没有该属性，
 * 需给「pdfjs 实际解析到的那个 @napi-rs/canvas 实例」的 Canvas 原型补 getter。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const outDir = path.join(ROOT, 'out')
const pdfPath = path.resolve(process.argv[2] || path.join(outDir, 'export-chrome.pdf'))
const prefix = process.argv[3] || 'pdf-page'

const pdfjsUrl = import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs')
const pdfjs = await import(pdfjsUrl)

// 用 pdfjs 自己解析到的 @napi-rs/canvas（pnpm 多实例时保证是同一份）
const requireFromPdfjs = createRequire(fileURLToPath(pdfjsUrl))
let canvasMod
try {
  canvasMod = requireFromPdfjs('@napi-rs/canvas')
} catch {
  canvasMod = await import('@napi-rs/canvas')
}
const { createCanvas } = canvasMod
const CanvasProto = createCanvas(1, 1).constructor.prototype
if (!Object.getOwnPropertyDescriptor(CanvasProto, 'canvas')) {
  Object.defineProperty(CanvasProto, 'canvas', {
    get() {
      return this
    },
    configurable: true
  })
}

const pdfjsDir = path.dirname(fileURLToPath(pdfjsUrl))
const data = new Uint8Array(fs.readFileSync(pdfPath))
const pdf = await pdfjs.getDocument({
  data,
  useWorkerFetch: false,
  isEvalSupported: false,
  useSystemFonts: true,
  disableFontFace: true,
  standardFontDataUrl: path.join(pdfjsDir, '..', '..', 'standard_fonts') + path.sep
}).promise

const pages = []
for (let i = 1; i <= pdf.numPages; i++) {
  const page = await pdf.getPage(i)
  const base = page.getViewport({ scale: 1 })
  const scale = 1280 / base.width
  const viewport = page.getViewport({ scale })
  const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height))
  const ctx = canvas.getContext('2d')
  await page.render({ canvasContext: ctx, viewport }).promise
  const buf = canvas.toBuffer('image/png')
  const file = path.join(outDir, `${prefix}-${i}.png`)
  fs.writeFileSync(file, buf)

  const px = (x, y) => {
    const d = ctx.getImageData(x, y, 1, 1).data
    return [d[0], d[1], d[2]]
  }
  const W = canvas.width
  const H = canvas.height
  const points = {
    tl: px(2, 2),
    tr: px(W - 3, 2),
    bl: px(2, H - 3),
    br: px(W - 3, H - 3),
    center: px(Math.floor(W / 2), Math.floor(H / 2))
  }
  const distinct = new Set(Object.values(points).map((p) => p.join(','))).size
  const allWhite = Object.values(points).every((p) => p[0] > 245 && p[1] > 245 && p[2] > 245)
  pages.push({
    page: i,
    file: path.relative(ROOT, file),
    size: { w: W, h: H },
    points,
    distinctColors: distinct,
    gradientOrBackgroundLikely: !allWhite && distinct >= 2
  })
}
console.log(JSON.stringify({ pdf: path.relative(ROOT, pdfPath), pages }, null, 2))

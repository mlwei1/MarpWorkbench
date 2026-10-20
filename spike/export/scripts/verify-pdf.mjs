/**
 * PDF 验收：页数 / 页面尺寸（pt）/ 中文可提取 / 页眉页脚 / 渐变或深色背景绘制痕迹。
 * 复现：node scripts/verify-pdf.mjs out/export-chrome.pdf
 * 依赖：pdf-lib（尺寸）+ pdfjs-dist（文本 + 绘制算子）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument } from 'pdf-lib'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')

const pdfPath = path.resolve(process.argv[2] || path.join(ROOT, 'out', 'export-chrome.pdf'))
const expectPages = process.argv.includes('--pages')
  ? Number(process.argv[process.argv.indexOf('--pages') + 1])
  : null

const buf = fs.readFileSync(pdfPath)
const doc = await PDFDocument.load(buf)
const pages = doc.getPages()
const sizes = pages.map((p) => {
  const { width, height } = p.getSize()
  return { w: +width.toFixed(2), h: +height.toFixed(2) }
})

// ---- 文本提取 ----
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
const pdfjsDir = path.dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs')))
const pdf = await pdfjs.getDocument({
  data: new Uint8Array(buf),
  useWorkerFetch: false,
  isEvalSupported: false,
  useSystemFonts: true,
  disableFontFace: true,
  standardFontDataUrl: path.join(pdfjsDir, '..', '..', 'standard_fonts') + path.sep
}).promise

const texts = []
const drawOps = []
for (let i = 1; i <= pdf.numPages; i++) {
  const page = await pdf.getPage(i)
  const content = await page.getTextContent()
  texts.push(content.items.map((it) => ('str' in it ? it.str : '')).join('').replace(/\s+/g, ' ').trim())
  try {
    const ops = await page.getOperatorList()
    const counts = {}
    for (const fn of ops.fnArray) {
      const name = Object.keys(pdfjs.OPS).find((k) => pdfjs.OPS[k] === fn) || String(fn)
      counts[name] = (counts[name] || 0) + 1
    }
    drawOps.push({
      shadingFill: counts.shadingFill || 0,
      paintImageXObject: counts.paintImageXObject || 0,
      paintInlineImageXObject: counts.paintInlineImageXObject || 0,
      fill: counts.fill || 0,
      constructPath: counts.constructPath || 0
    })
  } catch (e) {
    drawOps.push({ error: String(e).slice(0, 200) })
  }
}

const hasCjk = (s) => /[\u3400-\u9fff]/.test(s)
const hasHeaderFooter = texts.some((t) => /127\.0\.0\.1|http:\/\/|file:\/\/|about:blank/i.test(t))
const pageCountOk = expectPages ? pdf.numPages === expectPages : true
const sizeOk = sizes.every((s) => Math.abs(s.w - 960) < 0.5 && Math.abs(s.h - 540) < 0.5)
const cjkOk = texts.filter(hasCjk).length === pdf.numPages
const backgroundDrawn = drawOps.every(
  (d) => d.error || d.shadingFill > 0 || d.paintImageXObject > 0 || d.fill > 0
)

const report = {
  ok: pageCountOk && sizeOk && cjkOk && !hasHeaderFooter && backgroundDrawn,
  file: pdfPath,
  bytes: buf.length,
  pdfPages: pdf.numPages,
  expectPages,
  pageCountOk,
  pageSizes: sizes,
  sizeOk,
  expectedSizePt: { w: 960, h: 540 },
  textChars: texts.map((t) => t.length),
  cjkChars: texts.map((t) => (t.match(/[\u3400-\u9fff]/g) || []).length),
  cjkOk,
  textSample: texts.map((t) => t.slice(0, 60)),
  hasHeaderFooter,
  backgroundDrawn,
  drawOps
}
console.log(JSON.stringify(report, null, 2))
if (!report.ok) process.exit(1)

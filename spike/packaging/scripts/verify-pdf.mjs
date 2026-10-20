// 校验 printToPDF 产物：
//  1) 页数 = 3
//  2) 每页尺寸 = 960x540 pt（= 1280x720 CSS px @96dpi，16:9）
//  3) 每页能提取到预期文本且文本量足够（非空白页）
// 用法：node scripts/verify-pdf.mjs [pdf路径]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument } from 'pdf-lib'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const pdfPath = process.argv[2] || path.join(ROOT, 'out', 'deck.pdf')
const reportPath = path.join(ROOT, 'out', 'verify-report.json')

const EXPECTED_PAGES = 3
const EXPECTED_PT = { width: 960, height: 540 } // 1280px/96*72, 720px/96*72
const TOLERANCE = 1

function fail(msg) {
  const report = { ok: false, error: msg, pdfPath }
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
  console.error('VERIFY_FAILED:', msg)
  process.exit(1)
}

if (!fs.existsSync(pdfPath)) fail(`PDF 不存在: ${pdfPath}（先运行 pnpm export）`)
const buf = fs.readFileSync(pdfPath)
if (buf.length < 10_000) fail(`PDF 过小 ${buf.length} bytes，疑似空白/失败`)

// ---- 1) 页数 + 页面尺寸（pdf-lib，纯字节解析）----
const doc = await PDFDocument.load(buf)
const pages = doc.getPages()
const sizes = pages.map((p) => {
  const { width, height } = p.getSize()
  return Number(width.toFixed(2)) + 'x' + Number(height.toFixed(2))
})
const pageCountOk = pages.length === EXPECTED_PAGES
const sizeOk = pages.every(
  (p) =>
    Math.abs(p.getWidth() - EXPECTED_PT.width) <= TOLERANCE &&
    Math.abs(p.getHeight() - EXPECTED_PT.height) <= TOLERANCE
)

// ---- 2) 文本提取（pdfjs-dist），证明每页有内容、不是空白页 ----
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
const { getDocument } = pdfjs
const loadingTask = getDocument({
  data: new Uint8Array(buf),
  useWorkerFetch: false,
  isEvalSupported: false,
  useSystemFonts: false,
  disableFontFace: true
})
const pdf = await loadingTask.promise
const pageTexts = []
for (let i = 1; i <= pdf.numPages; i++) {
  const page = await pdf.getPage(i)
  const content = await page.getTextContent()
  const text = content.items
    .map((it) => ('str' in it ? it.str : ''))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  pageTexts.push(text)
}
await pdf.destroy()

const expectedMarkers = ['SLIDE 1 / 3', 'SLIDE 2 / 3', 'SLIDE 3 / 3']
const textOk = pageTexts.every(
  (t, i) => t.length >= 10 && t.includes(expectedMarkers[i])
)
const hasCjk = pageTexts.some((t) => /[\u4e00-\u9fff]/.test(t))

const report = {
  ok: pageCountOk && sizeOk && textOk,
  pdfPath,
  bytes: buf.length,
  sizeOnDisk: Number((buf.length / 1024).toFixed(1)) + ' KB',
  pageCount: pages.length,
  pageCountOk,
  expectedPagePt: EXPECTED_PT,
  actualPageSizes: sizes,
  sizeOk,
  textOk,
  hasCjk,
  pageTextLengths: pageTexts.map((t) => t.length),
  pageTextSamples: pageTexts.map((t) => t.slice(0, 80)),
  checks: {
    '页数 = 3': pageCountOk,
    '尺寸 = 960x540pt (16:9)': sizeOk,
    '每页非空白且含 SLIDE n 标记': textOk,
    '中文字符可提取': hasCjk
  }
}
fs.mkdirSync(path.dirname(reportPath), { recursive: true })
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
if (!report.ok) process.exit(1)
console.log('VERIFY_OK')

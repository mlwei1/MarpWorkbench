// 校验 PDF：页数 / 精确页面尺寸 / 文本（非空白、中文、标记）/ 像素级检查（白边、背景色、裁切）
// 用法：node browser-print/verify.mjs <pdf路径> [--strict]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument } from 'pdf-lib'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const pdfPath = process.argv[2] || path.join(ROOT, 'out', 'edge-deck.pdf')
const strict = process.argv.includes('--strict') || pdfPath.endsWith('edge-deck.pdf')
const outPath = path.join(ROOT, 'out', 'verify-' + path.basename(pdfPath).replace(/\.pdf$/, '') + '.json')

const buf = fs.readFileSync(pdfPath)
const doc = await PDFDocument.load(buf)
const pages = doc.getPages()
const sizes = pages.map((p) => ({ w: +p.getWidth().toFixed(2), h: +p.getHeight().toFixed(2) }))

// ---- 文本提取：页数、标记、中文 ----
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
const pdfjsDir = path.dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs')))
const standardFontDataUrl = path.join(pdfjsDir, '..', '..', 'standard_fonts') + path.sep
const pdf = await pdfjs.getDocument({
  data: new Uint8Array(buf),
  useWorkerFetch: false,
  isEvalSupported: false,
  useSystemFonts: true,
  disableFontFace: true,
  standardFontDataUrl
}).promise
const texts = []
for (let i = 1; i <= pdf.numPages; i++) {
  const page = await pdf.getPage(i)
  const content = await page.getTextContent()
  texts.push(content.items.map((it) => ('str' in it ? it.str : '')).join('').replace(/\s+/g, ' ').trim())
}

// ---- 像素检查：用 pdfjs 渲染每页到 canvas（需要 @napi-rs/canvas）----
let pixel = { available: false }
try {
  const { createCanvas } = await import('@napi-rs/canvas')
  const results = []
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const base = page.getViewport({ scale: 1 })
    const scale = 1280 / base.width // 统一渲染到 1280 宽
    const vp = page.getViewport({ scale })
    const canvas = createCanvas(Math.round(vp.width), Math.round(vp.height))
    const ctx = canvas.getContext('2d')
    await page.render({ canvasContext: ctx, viewport: vp }).promise
    const { width: W, height: H } = canvas
    const img = ctx.getImageData(0, 0, W, H).data
    const px = (x, y) => {
      const o = (y * W + x) * 4
      return [img[o], img[o + 1], img[o + 2]]
    }
    const isWhite = ([r, g, b]) => r > 240 && g > 240 && b > 240
    const avg = (x0, y0, s = 8) => {
      let r = 0, g = 0, b = 0, n = 0
      for (let y = y0; y < Math.min(y0 + s, H); y += 2)
        for (let x = x0; x < Math.min(x0 + s, W); x += 2) { const p = px(x, y); r += p[0]; g += p[1]; b += p[2]; n++ }
      return [Math.round(r / n), Math.round(g / n), Math.round(b / n)]
    }
    // 统计非白像素比例（判断内容是否铺满 & 背景是否印出）
    let nonWhite = 0, total = 0
    for (let y = 0; y < H; y += 8) for (let x = 0; x < W; x += 8) { total++; if (!isWhite(px(x, y))) nonWhite++ }
    results.push({
      page: i,
      renderedPx: `${W}x${H}`,
      corners: { tl: avg(1, 1), tr: avg(W - 9, 1), bl: avg(1, H - 9), br: avg(W - 9, H - 9) },
      edgeLeft: avg(1, Math.floor(H / 2)),
      nonWhiteRatio: +(nonWhite / total).toFixed(3)
    })
  }
  pixel = { available: true, pages: results }
} catch (e) {
  pixel = { available: false, error: String(e && e.message || e) }
}
await pdf.destroy()

// ---- 断言（严格模式针对 3 页 1280x720 测试 deck）----
const checks = []
const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail })
add('页数 = 3', pages.length === 3, `actual=${pages.length}`)
add('每页尺寸 = 960x540pt (=1280x720px 16:9)', sizes.every((s) => Math.abs(s.w - 960) < 0.6 && Math.abs(s.h - 540) < 0.6), JSON.stringify(sizes))
const markers = ['SLIDE 1 / 3', 'SLIDE 2 / 3', 'SLIDE 3 / 3']
add('每页文本非空且含 SLIDE n 标记', texts.length === 3 && texts.every((t, i) => t.length >= 10 && t.includes(markers[i])), JSON.stringify(texts.map((t) => t.length)))
add('中文可提取（字体未缺字/未变图片）', texts.some((t) => /[\u4e00-\u9fff]/.test(t)), texts.map((t) => (t.match(/[\u4e00-\u9fff]/g) || []).length).join(','))
add('无页眉页脚 URL/日期（--no-pdf-header-footer 生效）', !texts.some((t) => /127\.0\.0\.1|http:\/\/|file:\/\//.test(t)), '')
if (pixel.available) {
  const p = pixel.pages
  add('第 2/3 页背景印出（四角非白，无白边）', p.length === 3 && [1, 2].every((i) => { const pg = p[i]; return !pg.corners.tl.every((v) => v > 240) && !pg.corners.br.every((v) => v > 240) && !pg.edgeLeft.every((v) => v > 240) }), JSON.stringify(p.map((x) => ({ p: x.page, tl: x.corners.tl, nw: x.nonWhiteRatio }))))
  add('内容铺满页面（非白像素占比合理 >5%）', p.every((x) => x.nonWhiteRatio > 0.05), JSON.stringify(p.map((x) => x.nonWhiteRatio)))
}
const ok = strict ? checks.every((c) => c.ok) : true
const report = { pdfPath, bytes: buf.length, kb: +(buf.length / 1024).toFixed(1), pageCount: pages.length, pageSizes: sizes, textLengths: texts.map((t) => t.length), textSamples: texts.map((t) => t.slice(0, 60)), pixel, checks, strict, ok }
fs.writeFileSync(outPath, JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
if (strict && !ok) process.exit(1)

// 无需光栅化的 PDF 版面校验：
//  - 操作符流里是否存在「整页背景填充」（证明背景/渐变被打印、无白边）
//  - 每页文本坐标是否都在页面范围内（证明没有横向/纵向裁切）
// 用法：node browser-print/verify-paint.mjs <pdf> [<pdf> ...]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
const OPS = pdfjs.OPS
const pdfjsDir = path.dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs')))
const standardFontDataUrl = path.join(pdfjsDir, '..', '..', 'standard_fonts') + path.sep

const results = []
for (const pdfPath of process.argv.slice(2)) {
  const buf = fs.readFileSync(pdfPath)
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, standardFontDataUrl }).promise
  const pages = []
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const [, , W, H] = page.view // [x0,y0,x1,y1] 单位 pt
    const ops = await page.getOperatorList()
    const fills = []
    let curColor = null
    let curRect = null
    const fnArray = ops.fnArray
    const argsArray = ops.argsArray
    for (let k = 0; k < fnArray.length; k++) {
      const fn = fnArray[k]
      const a = argsArray[k]
      if (fn === OPS.setFillRGBColor) curColor = a // Uint8ClampedArray [r,g,b]
      else if (fn === OPS.rectangle) curRect = a
      else if ((fn === OPS.fill || fn === OPS.eoFill || fn === OPS.fillStroke) && curRect) {
        fills.push({ rect: curRect, color: curColor ? Array.from(curColor).slice(0, 3) : null })
        curRect = null
      } else if (fn === OPS.shadingFill) {
        fills.push({ shading: true })
      } else if (fn === OPS.constructPath) {
        // constructPath: [ops, coords]; 粗判最后一个闭合矩形
        const coords = a[1]
        if (coords && coords.length >= 4) {
          const xs = coords.filter((_, idx) => idx % 2 === 0)
          const ys = coords.filter((_, idx) => idx % 2 === 1)
          curRect = [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)]
        }
      }
    }
    // 找覆盖面积最大的填充
    let best = null
    for (const f of fills) {
      if (!f.rect) continue
      const [x, y, w, h] = f.rect
      const coverage = (w * h) / (W * H)
      if (!best || coverage > best.coverage) best = { coverage: +coverage.toFixed(3), rect: [x, y, w, h].map((v) => +v.toFixed(1)), color: f.color, shading: false }
    }
    const shadingCount = fills.filter((f) => f.shading).length
    // 文本范围
    const tc = await page.getTextContent()
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const it of tc.items) {
      if (!('transform' in it)) continue
      const x = it.transform[4], y = it.transform[5]
      minX = Math.min(minX, x); maxX = Math.max(maxX, x + it.width); minY = Math.min(minY, y); maxY = Math.max(maxY, y)
    }
    pages.push({
      page: i, pagePt: [W, H], fullPageBackground: best, shadingCount,
      textBoundsPt: { minX: +minX.toFixed(1), maxX: +maxX.toFixed(1), minY: +minY.toFixed(1), maxY: +maxY.toFixed(1) },
      textInPage: minX >= -2 && maxX <= W + 2 && minY >= -2 && maxY <= H + 2
    })
  }
  await pdf.destroy()
  results.push({ pdf: pdfPath, pageCount: pages.length, pages })
}
const outFile = path.join(__dirname, '..', 'out', 'verify-paint.json')
fs.writeFileSync(outFile, JSON.stringify(results, null, 2))
for (const r of results) {
  console.log(`== ${path.basename(r.pdf)} pages=${r.pageCount}`)
  for (const p of r.pages) {
    console.log(`  p${p.page} pagePt=${p.pagePt.join('x')} bgCoverage=${p.fullPageBackground?.coverage} bgColor=${JSON.stringify(p.fullPageBackground?.color)} shading=${p.shadingCount} textInPage=${p.textInPage} textBounds=${JSON.stringify(p.textBoundsPt)}`)
  }
}

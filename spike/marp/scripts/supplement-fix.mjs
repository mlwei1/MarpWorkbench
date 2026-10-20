// 快速修正：KaTeX 字体体积、PPTX 备注、PDF 字体嵌入（用 pdf-lib 低层 API）
import { readFileSync, statSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { PDFDocument, PDFName, PDFDict, PDFRawStream } from 'pdf-lib'

const outPath = (f) => fileURLToPath(new URL(`../out/${f}`, import.meta.url))
const report = {}

// KaTeX 字体（pnpm 嵌套目录）
try {
  const pnpm = fileURLToPath(new URL('../node_modules/.pnpm/', import.meta.url))
  const dir = readdirSync(pnpm).find((d) => d.startsWith('katex@'))
  const fontsDir = `${pnpm}${dir}/node_modules/katex/dist/fonts/`
  const files = readdirSync(fontsDir).filter((f) => f.endsWith('.woff2'))
  report.katexFonts = {
    pnpmDir: dir,
    woff2Files: files.length,
    woff2Bytes: files.reduce((a, f) => a + statSync(fontsDir + f).size, 0),
  }
} catch (e) {
  report.katexFonts = { error: String(e) }
}

// PPTX 备注
try {
  const dest = fileURLToPath(new URL('../out/pptx-unpacked/', import.meta.url))
  const notes = {}
  for (const n of [1, 2, 3]) {
    try {
      const xml = readFileSync(`${dest}ppt\\notesSlides\\notesSlide${n}.xml`, 'utf8')
      notes[`notesSlide${n}`] = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1])
    } catch (e) {
      notes[`notesSlide${n}`] = { error: String(e) }
    }
  }
  report.pptxNotes = notes
} catch (e) {
  report.pptxNotes = { error: String(e) }
}

// PDF 字体嵌入（pdf-lib 低层）
try {
  const buf = readFileSync(outPath('cli-offline.pdf'))
  const doc = await PDFDocument.load(buf)
  let fontFileObjs = 0
  const fontNames = []
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    let dict
    if (obj instanceof PDFRawStream) dict = obj.dict
    else if (obj instanceof PDFDict) dict = obj
    if (!dict) continue
    for (const k of ['FontFile', 'FontFile2', 'FontFile3']) if (dict.has(PDFName.of(k))) fontFileObjs++
    const base = dict.lookupMaybe ? dict.lookupMaybe(PDFName.of('BaseFont'), undefined) : undefined
    if (base) fontNames.push(String(base))
  }
  report.pdfFonts = { fontFileObjects: fontFileObjs, fontNames: [...new Set(fontNames)].slice(0, 20) }
} catch (e) {
  report.pdfFonts = { error: String(e) }
}

report.bundleSizes = {
  marpCoreMinGzip: gzipSync(readFileSync(outPath('marp-core.browser.min.js')), { level: 9 }).length,
}
console.log(JSON.stringify(report, null, 2))

// 补充统计：KaTeX 字体体积、CLI HTML 外链情况、PDF 字体嵌入、PPTX 备注
import { readFileSync, statSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import { PDFDocument } from 'pdf-lib'

const require = createRequire(import.meta.url)
const out = (f) => fileURLToPath(new URL(`../out/${f}`, import.meta.url))
const report = {}

// 1) KaTeX 字体
try {
  const katexPkg = require.resolve('katex/package.json')
  const fontsDir = katexPkg.replace(/package\.json$/, '') + 'dist/fonts/'
  const files = readdirSync(fontsDir).filter((f) => f.endsWith('.woff2'))
  const bytes = files.reduce((a, f) => a + statSync(fontsDir + f).size, 0)
  report.katexFonts = { dir: fontsDir, woff2Files: files.length, woff2Bytes: bytes }
} catch (e) {
  report.katexFonts = { error: String(e) }
}

// 2) CLI HTML 是否引用外网资源
try {
  const html = readFileSync(out('cli-sample.html'), 'utf8')
  report.cliHtmlExternal = {
    httpRefs: [...new Set((html.match(/https?:\/\/[^"'\s)]+/g) || []))].slice(0, 20),
    localRefs: [...new Set((html.match(/(?:src|href)="(?!https?:|data:)[^"]+"/g) || []))].slice(0, 10),
  }
} catch (e) {
  report.cliHtmlExternal = { error: String(e) }
}

// 3) PDF 字体嵌入（pdf-lib 枚举间接对象）
try {
  const doc = await PDFDocument.load(readFileSync(out('cli-offline.pdf')))
  let fontFiles = 0
  const baseFonts = new Set()
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const dict = obj.dict ?? obj
    for (const key of ['FontFile', 'FontFile2', 'FontFile3']) if (dict.has && dict.has(key)) fontFiles++
    if (dict.get && dict.get({ toString: () => 'BaseFont' })) {
      try {
        const bf = dict.get({ toString: () => 'BaseFont' })
        baseFonts.add(String(bf))
      } catch {}
    }
    try {
      const bf = dict.lookup?.({ toString: () => 'BaseFont' })
      if (bf) baseFonts.add(String(bf))
    } catch {}
  }
  report.pdfFonts = { embeddedFontFileObjects: fontFiles, baseFonts: [...baseFonts].slice(0, 20) }
} catch (e) {
  report.pdfFonts = { error: String(e) }
}

// 4) PPTX 备注文本（notesSlide2/3）
try {
  const dest = fileURLToPath(new URL('../out/pptx-unpacked/', import.meta.url))
  const read = (f) => readFileSync(dest + f.replace(/\//g, '\\'), 'utf8')
  const notes = {}
  for (const f of ['notesSlides/notesSlide1.xml', 'notesSlides/notesSlide2.xml', 'notesSlides/notesSlide3.xml']) {
    try {
      const xml = read(f)
      notes[f] = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).filter(Boolean)
    } catch {}
  }
  report.pptxNotes = notes
  const pres = read('ppt/presentation.xml')
  report.pptxSlideSize = (pres.match(/<p:sldSz[^>]*>/) || [])[0]
} catch (e) {
  report.pptxNotes = { error: String(e) }
}

// 5) 浏览器 bundle 中是否含外链字体引用（KaTeX CDN 等）
try {
  const bundle = readFileSync(out('marp-core.browser.min.js'), 'utf8')
  report.bundleExternalRefs = {
    cdnJsdelivr: (bundle.match(/cdn\.jsdelivr\.net/g) || []).length,
    fontsBunny: (bundle.match(/fonts\.bunny\.net/g) || []).length,
    jsdelivrKaTeXSample: (bundle.match(/https:\/\/cdn\.jsdelivr\.net\/npm\/katex[^"']*/) || [])[0],
    gzipBytes: gzipSync(bundle, { level: 9 }).length,
  }
} catch (e) {
  report.bundleExternalRefs = { error: String(e) }
}

console.log(JSON.stringify(report, null, 2))

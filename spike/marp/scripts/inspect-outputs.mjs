// 检查 marp-cli 产物：PDF 页数/尺寸、PPTX 是否为逐页位图、PNG 尺寸、HTML 打印 CSS
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PDFDocument } from 'pdf-lib'
import { execFileSync } from 'node:child_process'

const root = fileURLToPath(new URL('..', import.meta.url))
const out = (f) => fileURLToPath(new URL(`../out/${f}`, import.meta.url))
const report = {}

// PDF
for (const f of ['cli-offline.pdf', 'browser-print.pdf']) {
  try {
    const doc = await PDFDocument.load(readFileSync(out(f)))
    report[f] = {
      bytes: readFileSync(out(f)).length,
      pages: doc.getPageCount(),
      sizes: doc.getPages().map((p) => {
        const { width, height } = p.getSize()
        return `${+width.toFixed(2)}x${+height.toFixed(2)}pt`
      }),
      title: doc.getTitle(),
      producer: doc.getProducer(),
      creator: doc.getCreator(),
    }
  } catch (e) {
    report[f] = { error: String(e) }
  }
}

// PDF 字体嵌入：粗查 /FontFile
try {
  const buf = readFileSync(out('cli-offline.pdf'))
  const txt = buf.toString('latin1')
  report['cli-offline.pdf'].fontFile2Count = (txt.match(/\/FontFile2/g) || []).length
  report['cli-offline.pdf'].fontDescriptorCount = (txt.match(/\/FontDescriptor/g) || []).length
} catch {}

// PNG 尺寸（读 IHDR）
function pngSize(file) {
  const buf = readFileSync(file)
  return { bytes: buf.length, width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}
report.png = {}
for (const f of readdirSync(fileURLToPath(new URL('../out/', import.meta.url))).filter((x) => x.endsWith('.png'))) {
  report.png[f] = pngSize(out(f))
}

// PPTX：解析 zip（用 PowerShell Expand-Archive 解包后统计）
try {
  const zipPath = out('cli-offline.pptx')
  const dest = fileURLToPath(new URL('../out/pptx-unpacked/', import.meta.url))
  execFileSync('pwsh', ['-NoProfile', '-Command', `if (Test-Path '${dest}') { Remove-Item -Recurse -Force '${dest}' }; Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${dest}'`])
  const files = execFileSync('pwsh', ['-NoProfile', '-Command', `Get-ChildItem -Recurse -File '${dest}' | ForEach-Object { $_.FullName.Substring(${dest.length}) + '|' + $_.Length }`]).toString().trim().split(/\r?\n/)
  const entries = files.map((l) => {
    const [path, size] = l.split('|')
    return { path: path.replace(/\\/g, '/'), size: +size }
  })
  report.pptx = {
    totalFiles: entries.length,
    slides: entries.filter((e) => /slides\/slide\d+\.xml$/.test(e.path)).length,
    notesSlides: entries.filter((e) => /notesSlides\/notesSlide\d+\.xml$/.test(e.path)).length,
    media: entries.filter((e) => /ppt\/media\//.test(e.path)).map((e) => e.path.split('/').pop().replace(/^.*\./, '') ? { file: e.path.split('/').pop(), size: e.size } : e),
    presentationXmlBytes: entries.find((e) => e.path.endsWith('presentation.xml'))?.size,
    slideXmlBytes: entries.filter((e) => /slides\/slide\d+\.xml$/.test(e.path)).map((e) => e.size),
  }
  // slide1.xml 中的内容：是否只有背景图片、有无文本
  const slide1 = readFileSync(`${dest}\\ppt\\slides\\slide1.xml`, 'utf8')
  report.pptx.slide1 = {
    hasBlipFill: /<p:blipFill/.test(slide1),
    hasRunText: /<a:t>/.test(slide1),
    textRuns: (slide1.match(/<a:t>/g) || []).length,
    xmlStart: slide1.slice(0, 400),
  }
  const notes1 = readFileSync(`${dest}\\ppt\\notesSlides\\notesSlide1.xml`, 'utf8')
  report.pptx.notes1Text = (notes1.match(/<a:t>([^<]*)<\/a:t>/g) || []).map((x) => x.replace(/<\/?a:t>/g, '')).join(' | ')
  // presentation.xml 中 sldSz
  const pres = readFileSync(`${dest}\\ppt\\presentation.xml`, 'utf8')
  report.pptx.slideSize = (pres.match(/<p:sldSz[^>]*>/) || [])[0]
} catch (e) {
  report.pptx = { error: String(e) }
}

// marp-cli 生成的 HTML 中的打印 CSS（对比 @page / 分页方式）
try {
  const html = readFileSync(out('cli-sample.html'), 'utf8')
  report.cliHtml = {
    bytes: html.length,
    hasPageRule: /@page/.test(html),
    pageRules: [...html.matchAll(/@page[^{]*\{[^}]*\}/g)].map((m) => m[0]).slice(0, 3),
    hasPrintMedia: /@media print/.test(html),
    printMediaSnippets: [...html.matchAll(/@media print\{[^}]{0,300}/g)].map((m) => m[0]).slice(0, 3),
    usesBespoke: /bespoke/.test(html),
    scriptTags: (html.match(/<script/g) || []).length,
  }
} catch (e) {
  report.cliHtml = { error: String(e) }
}

console.log(JSON.stringify(report, null, 2))

// 浏览器端实测：marp-core 在真实 Chromium（本机 Chrome 155）中渲染 / 截图 / 生成 PPTX / 打印 PDF / 主题缩略图
import puppeteer from 'puppeteer-core'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PDFDocument } from 'pdf-lib'

const root = new URL('..', import.meta.url)
const out = (f) => fileURLToPath(new URL(`../out/${f}`, import.meta.url))
mkdirSync(new URL('../out/', import.meta.url), { recursive: true })
const read = (p) => readFileSync(new URL(p, root), 'utf8')

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const decks = {
  mathjax: read('samples/sample-browser.md'),
}
const report = {}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none', '--allow-file-access-from-files'],
})

async function newPage() {
  const page = await browser.newPage()
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 })
  page.setDefaultTimeout(45000)
  await page.setRequestInterception(true)
  page.on('request', (req) => {
    const u = req.url()
    if (u.startsWith('http://') || u.startsWith('https://')) req.abort()
    else req.continue()
  })
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)))
  return page
}

const page = await newPage()
await page.setContent('<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;background:#fff}</style></head><body><div id="stage"></div></body></html>', { waitUntil: 'load' })
for (const lib of [
  ['marp-core', out('marp-core.browser.min.js')],
  ['html-to-image', fileURLToPath(new URL('../node_modules/html-to-image/dist/html-to-image.js', import.meta.url))],
  ['html2canvas', fileURLToPath(new URL('../node_modules/html2canvas/dist/html2canvas.min.js', import.meta.url))],
  ['pptxgenjs', fileURLToPath(new URL('../node_modules/pptxgenjs/dist/pptxgen.bundle.js', import.meta.url))],
]) {
  const t = Date.now()
  await page.addScriptTag({ path: lib[1] })
  report[`load_${lib[0]}_ms`] = Date.now() - t
}

// ---- A. 浏览器内 marp-core 渲染 ----
report.render = await page.evaluate((md) => {
  const { Marp, browser: marpBrowser } = window.MarpCore
  const r = {}
  r.globals = {
    Marp: typeof Marp,
    browserHelper: typeof marpBrowser,
    htmlToImage: typeof window.htmlToImage,
    html2canvas: typeof window.html2canvas,
  }
  let t0 = performance.now()
  const marp = new Marp()
  r.marpConstructMs = +(performance.now() - t0).toFixed(1)

  t0 = performance.now()
  const first = marp.render(md)
  r.coldRenderMs = +(performance.now() - t0).toFixed(1)
  t0 = performance.now()
  const res = marp.render(md)
  r.warmRenderMs = +(performance.now() - t0).toFixed(1)

  r.htmlBytes = first.html.length
  r.cssBytes = first.css.length
  r.slideCount = (first.html.match(/data-marpit-svg/g) || []).length
  r.comments = first.comments
  r.mathMarkup = /mjx-container/.test(first.html) ? 'mathjax' : /class="katex/.test(first.html) ? 'katex' : 'none'
  r.scriptTagsInHtml = (first.html.match(/<script/g) || []).length

  // 注入方式 1：innerHTML + 手动 style + 官方 browser() helper
  document.getElementById('marp-css')?.remove()
  const style = document.createElement('style')
  style.id = 'marp-css'
  style.textContent = res.css
  document.head.appendChild(style)
  const stage = document.getElementById('stage')
  stage.innerHTML = res.html
  t0 = performance.now()
  const helper = marpBrowser(stage)
  r.helperMs = +(performance.now() - t0).toFixed(1)
  r.helperKeys = Object.keys(helper || {})
  const section = stage.querySelector('section')
  const cs = getComputedStyle(section)
  r.sectionComputed = { width: cs.width, height: cs.height }
  r.domMathCount = stage.querySelectorAll('.katex, mjx-container').length
  r.notesLengths = res.comments.map((c) => c.join('\n').length)
  r.htmlHead = res.html.slice(0, 220)
  return r
}, decks.mathjax)

// ---- B. iframe srcdoc 注入（真正执行 marp-core 内联 helper 脚本的方式）----
report.iframe = await page.evaluate(async (md) => {
  const { Marp } = window.MarpCore
  const res = new Marp().render(md)
  const t0 = performance.now()
  const iframe = document.createElement('iframe')
  iframe.style.cssText = 'width:1280px;height:720px;border:0;position:absolute;left:-9999px;top:0'
  const doc = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#fff}${res.css}</style></head><body>${res.html}</body></html>`
  document.body.appendChild(iframe)
  await new Promise((resolve) => {
    iframe.onload = resolve
    iframe.srcdoc = doc
  })
  const idoc = iframe.contentDocument
  const section = idoc.querySelector('section')
  const r = {
    totalMs: +(performance.now() - t0).toFixed(1),
    slideCount: idoc.querySelectorAll('svg[data-marpit-svg]').length,
    sectionWidth: getComputedStyle(section).width,
    sectionHeight: getComputedStyle(section).height,
    inlineScriptCount: idoc.querySelectorAll('script').length,
    mathCount: idoc.querySelectorAll('mjx-container').length,
  }
  iframe.remove()
  return r
}, decks.mathjax)

// ---- C. html-to-image 每页 2x PNG + html2canvas 对比 ----
report.screenshots = await page.evaluate(async (md) => {
  const { Marp } = window.MarpCore
  const marp = new Marp()
  const res = marp.render(md)
  const style = document.getElementById('marp-css')
  // 独立容器：只放一页，套用 marp CSS 所需结构
  const holder = document.createElement('div')
  holder.style.cssText = 'position:absolute;left:-99999px;top:0;width:1280px;height:720px;overflow:hidden;background:#fff'
  holder.innerHTML = '<div class="marpit"></div>'
  document.body.appendChild(holder)
  const wrap = holder.firstElementChild
  const slides = new DOMParser().parseFromString(`<div>${res.html}</div>`, 'text/html').body.firstElementChild.querySelectorAll('svg[data-marpit-svg]')

  const result = { slideCount: slides.length, htmlToImage: [], html2canvas: null, warnings: [] }
  const origWarn = console.warn
  console.warn = (...a) => result.warnings.push(a.map(String).join(' ').slice(0, 200))

  for (let i = 0; i < slides.length; i++) {
    wrap.innerHTML = ''
    wrap.appendChild(slides[i].cloneNode(true))
    const t0 = performance.now()
    try {
      const dataUrl = await window.htmlToImage.toPng(holder, {
        pixelRatio: 2,
        backgroundColor: '#ffffff',
        skipFonts: true, // 离线场景：不抓取外部字体
      })
      result.htmlToImage.push({
        slide: i + 1,
        ms: +(performance.now() - t0).toFixed(1),
        bytes: dataUrl.length,
        dataUrl,
      })
    } catch (e) {
      result.htmlToImage.push({ slide: i + 1, ms: +(performance.now() - t0).toFixed(1), error: String(e).slice(0, 300) })
    }
  }
  // html2canvas 只测第 1 页
  wrap.innerHTML = ''
  wrap.appendChild(slides[0].cloneNode(true))
  const t1 = performance.now()
  try {
    const canvas = await window.html2canvas(holder, { scale: 2, backgroundColor: '#ffffff', logging: false })
    result.html2canvas = { ms: +(performance.now() - t1).toFixed(1), width: canvas.width, height: canvas.height, dataUrl: canvas.toDataURL('image/png') }
  } catch (e) {
    result.html2canvas = { ms: +(performance.now() - t1).toFixed(1), error: String(e).slice(0, 300) }
  }
  console.warn = origWarn
  holder.remove()
  return result
}, decks.mathjax)

for (const [i, s] of report.screenshots.htmlToImage.entries()) {
  if (s.dataUrl) {
    writeFileSync(out(`slide-${i + 1}@2x.png`), Buffer.from(s.dataUrl.split(',')[1], 'base64'))
    s.file = `slide-${i + 1}@2x.png`
    delete s.dataUrl
  }
}
if (report.screenshots.html2canvas?.dataUrl) {
  writeFileSync(out('slide-1-html2canvas@2x.png'), Buffer.from(report.screenshots.html2canvas.dataUrl.split(',')[1], 'base64'))
  report.screenshots.html2canvas.file = 'slide-1-html2canvas@2x.png'
  delete report.screenshots.html2canvas.dataUrl
}

// ---- D. 浏览器端 pptxgenjs 生成图片版 PPTX（复刻 marp-cli --pptx 思路）----
report.pptx = await page.evaluate(async (md) => {
  const { Marp } = window.MarpCore
  const PptxGenJS = window.pptxgen || window.PptxGenJS || window.pptxgenjs
  const r = { globalFound: typeof PptxGenJS }
  if (typeof PptxGenJS !== 'function') return r
  const marp = new Marp()
  const res = marp.render(md)
  const holder = document.createElement('div')
  holder.style.cssText = 'position:absolute;left:-99999px;top:0;width:1280px;height:720px;overflow:hidden;background:#fff'
  holder.innerHTML = '<div class="marpit"></div>'
  document.body.appendChild(holder)
  const wrap = holder.firstElementChild
  const slides = new DOMParser().parseFromString(`<div>${res.html}</div>`, 'text/html').body.firstElementChild.querySelectorAll('svg[data-marpit-svg]')
  const images = []
  const tImg = performance.now()
  for (let i = 0; i < slides.length; i++) {
    wrap.innerHTML = ''
    wrap.appendChild(slides[i].cloneNode(true))
    images.push(await window.htmlToImage.toPng(holder, { pixelRatio: 2, backgroundColor: '#ffffff', skipFonts: true }))
  }
  r.renderImagesMs = +(performance.now() - tImg).toFixed(1)
  r.imagesBytes = images.reduce((a, b) => a + b.length, 0)
  holder.remove()

  const pptx = new PptxGenJS()
  pptx.author = 'marp_exe spike'
  pptx.company = 'spike'
  pptx.defineLayout({ name: 'MARPSLIDE', width: 1280 / 96, height: 720 / 96 })
  pptx.layout = 'MARPSLIDE'
  images.forEach((data, i) => {
    const slide = pptx.addSlide()
    slide.background = { data }
    const notes = res.comments[i].join('\n\n')
    if (notes) slide.addNotes(notes)
  })
  const t0 = performance.now()
  const blob = await pptx.write({ outputType: 'blob' })
  r.writeMs = +(performance.now() - t0).toFixed(1)
  const buf = await blob.arrayBuffer()
  r.pptxBytes = buf.byteLength
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  r.base64 = btoa(bin)
  return r
}, decks.mathjax)

if (report.pptx.base64) {
  writeFileSync(out('browser-pptxgen.pptx'), Buffer.from(report.pptx.base64, 'base64'))
  report.pptx.file = 'browser-pptxgen.pptx'
  delete report.pptx.base64
}

// ---- E. 主题画廊缩略图：4 主题 × 首页，html-to-image 缩略 vs DOM 缩放预览 ----
const CUSTOM_THEME = read('themes/custom-spike.css')
report.thumbnails = await page.evaluate(async (customCss) => {
  const { Marp } = window.MarpCore
  const themes = { default: null, gaia: null, uncover: null, 'company-cn': customCss }
  const marp = new Marp()
  marp.themeSet.add(customCss)
  const cssOnPage = document.getElementById('marp-css')
  const r = { themes: {}, domPreview: {} }
  const holder = document.createElement('div')
  holder.style.cssText = 'position:absolute;left:-99999px;top:0;width:1280px;height:720px;overflow:hidden;background:#fff'
  document.body.appendChild(holder)

  for (const [name, css] of Object.entries(themes)) {
    const md = `---\ntheme: ${name}\n---\n# 主题 ${name}\n\n## 副标题演示\n\n- 要点一\n- 要点二`
    const t0 = performance.now()
    const res = marp.render(md)
    const renderMs = +(performance.now() - t0).toFixed(1)
    const style = document.createElement('style')
    style.textContent = res.css
    document.head.appendChild(style)
    holder.innerHTML = res.html
    const t1 = performance.now()
    let thumbBytes = 0
    let thumbMs = 0
    try {
      const dataUrl = await window.htmlToImage.toPng(holder, { pixelRatio: 0.25, backgroundColor: '#ffffff', skipFonts: true })
      thumbMs = +(performance.now() - t1).toFixed(1)
      thumbBytes = dataUrl.length
    } catch (e) {
      r.themes[name] = { error: String(e).slice(0, 200) }
    }
    // DOM 缩放预览成本（不生成位图）
    const t2 = performance.now()
    const mini = document.createElement('div')
    mini.style.cssText = 'width:320px;height:180px;overflow:hidden;position:absolute;left:-9999px'
    const inner = document.createElement('div')
    inner.style.cssText = 'transform:scale(0.25);transform-origin:top left;width:1280px;height:720px'
    inner.innerHTML = res.html
    mini.appendChild(inner)
    document.body.appendChild(mini)
    document.head.appendChild(style.cloneNode(true))
    const domMs = +(performance.now() - t2).toFixed(1)
    mini.remove()
    style.remove()
    r.themes[name] = { renderMs, thumbMs, thumbBytes, domMs }
  }
  holder.remove()
  return r
}, CUSTOM_THEME)

// ---- F. window.print / printToPDF 路径：@page CSS + Chrome printToPDF ----
const freshPrint = await newPage()
await freshPrint.setContent('<!DOCTYPE html><html><head><meta charset="utf-8"></head><body></body></html>', { waitUntil: 'load' })
await freshPrint.addScriptTag({ path: out('marp-core.browser.min.js') })
report.print = await freshPrint.evaluate((md) => {
  const { Marp } = window.MarpCore
  const res = new Marp().render(md)
  document.head.innerHTML = `<meta charset="utf-8"><style>
@page { size: 1280px 720px; margin: 0; }
html, body { margin: 0; padding: 0; background: #fff; }
${res.css}
@media print { div.marpit > svg { display: block !important; break-after: page; page-break-after: always; break-inside: avoid; } }
</style>`
  document.body.innerHTML = res.html
  return { slides: document.querySelectorAll('svg[data-marpit-svg]').length, cssBytes: res.css.length }
}, decks.mathjax)
const tPdf = Date.now()
const pdfBuf = await freshPrint.pdf({ printBackground: true, preferCSSPageSize: true })
writeFileSync(out('browser-print.pdf'), pdfBuf)
report.print.pdfMs = Date.now() - tPdf
report.print.pdfBytes = pdfBuf.length
report.print.file = 'browser-print.pdf'
try {
  const doc = await PDFDocument.load(pdfBuf)
  report.print.pageCount = doc.getPageCount()
  report.print.pageSizes = doc.getPages().map((p) => {
    const { width, height } = p.getSize()
    return { widthPt: +width.toFixed(2), heightPt: +height.toFixed(2) }
  })
} catch (e) {
  report.print.pdfInspectError = String(e)
}

await browser.close()
writeFileSync(out('browser-report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))

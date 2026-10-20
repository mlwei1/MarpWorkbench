// 浏览器端截图备选：inlineSVG:false（传统 HTML section 输出）→ html-to-image 是否可用
import puppeteer from 'puppeteer-core'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const out = (f) => fileURLToPath(new URL(`../out/${f}`, import.meta.url))
mkdirSync(new URL('../out/', import.meta.url), { recursive: true })
const md = readFileSync(new URL('../samples/sample-browser.md', import.meta.url), 'utf8')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const report = {}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'] })
const page = await browser.newPage()
await page.setViewport({ width: 1000, height: 900 })
page.setDefaultTimeout(45000)
await page.setRequestInterception(true)
page.on('request', (r) => (/^https?:/.test(r.url()) ? r.abort() : r.continue()))
await page.setContent('<!DOCTYPE html><html><head><meta charset="utf-8"></head><body></body></html>')
await page.addScriptTag({ path: out('marp-core.browser.min.js') })
await page.addScriptTag({ path: fileURLToPath(new URL('../node_modules/html-to-image/dist/html-to-image.js', import.meta.url)) })
await page.addScriptTag({ path: fileURLToPath(new URL('../node_modules/html2canvas/dist/html2canvas.min.js', import.meta.url)) })

report.result = await page.evaluate(async (md) => {
  const { Marp, browser: marpBrowser } = window.MarpCore
  const r = {}
  const marp = new Marp({ inlineSVG: false, math: 'mathjax' })
  const res = marp.render(md)
  r.inlineSVG = false
  r.htmlBytes = res.html.length
  r.cssBytes = res.css.length
  r.htmlHead = res.html.slice(0, 260)
  r.directSections = (res.html.match(/<section/g) || []).length
  r.hasMarpitSvg = /data-marpit-svg/.test(res.html)

  const style = document.createElement('style')
  style.textContent = res.css
  document.head.appendChild(style)
  const holder = document.createElement('div')
  holder.style.cssText = 'position:absolute;left:-99999px;top:0;width:1280px;height:720px;overflow:hidden;background:#fff'
  document.body.appendChild(holder)
  holder.innerHTML = res.html
  marpBrowser(holder)
  const sections = holder.querySelectorAll('section')
  r.sectionCount = sections.length

  // 每页截图：只保留第 i 页
  const all = [...sections]
  r.slides = []
  for (let i = 0; i < all.length; i++) {
    all.forEach((s, idx) => (s.style.display = idx === i ? 'block' : 'none'))
    const t0 = performance.now()
    try {
      const dataUrl = await window.htmlToImage.toPng(holder, { pixelRatio: 2, backgroundColor: '#ffffff', skipFonts: true })
      r.slides.push({ slide: i + 1, ms: +(performance.now() - t0).toFixed(1), dataUrl })
    } catch (e) {
      r.slides.push({ slide: i + 1, error: String(e).slice(0, 300) })
    }
  }
  // html2canvas 第 1 页
  all.forEach((s, idx) => (s.style.display = idx === 0 ? 'block' : 'none'))
  const t1 = performance.now()
  try {
    const canvas = await window.html2canvas(holder, { scale: 2, backgroundColor: '#ffffff', logging: false })
    r.html2canvas = { ms: +(performance.now() - t1).toFixed(1), width: canvas.width, height: canvas.height, dataUrl: canvas.toDataURL('image/png') }
  } catch (e) {
    r.html2canvas = { ms: +(performance.now() - t1).toFixed(1), error: String(e).slice(0, 300) }
  }
  holder.remove()
  return r
}, md)

if (report.result.slides) {
  for (const s of report.result.slides) {
    if (s.dataUrl) {
      writeFileSync(out(`inlineSVG-off-slide-${s.slide}@2x.png`), Buffer.from(s.dataUrl.split(',')[1], 'base64'))
      s.file = `inlineSVG-off-slide-${s.slide}@2x.png`
      s.dataUrl = '(base64 removed)'
    }
  }
}
if (report.result.html2canvas?.dataUrl) {
  writeFileSync(out('inlineSVG-off-html2canvas@2x.png'), Buffer.from(report.result.html2canvas.dataUrl.split(',')[1], 'base64'))
  report.result.html2canvas.file = 'inlineSVG-off-html2canvas@2x.png'
  report.result.html2canvas.dataUrl = '(base64 removed)'
}

await browser.close()
writeFileSync(out('browser-export-fallback.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))

// 最终验证：inline SVG（默认）渲染 + 可见定位 + html-to-image 2x 截图 / 主题缩略图
import puppeteer from 'puppeteer-core'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const out = (f) => fileURLToPath(new URL(`../out/${f}`, import.meta.url))
const md = readFileSync(new URL('../samples/sample-browser.md', import.meta.url), 'utf8')
const customCss = readFileSync(new URL('../themes/custom-spike.css', import.meta.url), 'utf8')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const page = await browser.newPage()
await page.setViewport({ width: 1500, height: 1000 })
page.setDefaultTimeout(45000)
await page.setRequestInterception(true)
page.on('request', (r) => (/^https?:/.test(r.url()) ? r.abort() : r.continue()))
await page.setContent('<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#fff"></body></html>')
await page.addScriptTag({ path: out('marp-core.browser.min.js') })
await page.addScriptTag({ path: fileURLToPath(new URL('../node_modules/html-to-image/dist/html-to-image.js', import.meta.url)) })

const report = await page.evaluate(async (md, customCss) => {
  const { Marp, browser: marpBrowser } = window.MarpCore
  const r = { inlineSVG: true, slides: [], thumbnails: {} }

  // ---- inline SVG 模式（默认）每页截图 ----
  const marp = new Marp()
  const res = marp.render(md)
  const style = document.createElement('style')
  style.textContent = res.css
  document.head.appendChild(style)
  const holder = document.createElement('div')
  // 注意：必须放在可见坐标（>=0），html-to-image 对负偏移元素会输出空白
  holder.style.cssText = 'position:absolute;left:0;top:0;width:1280px;height:720px;overflow:hidden;background:#fff'
  holder.innerHTML = '<div class="marpit"></div>'
  document.body.appendChild(holder)
  const wrap = holder.firstElementChild
  const slides = new DOMParser().parseFromString(`<div>${res.html}</div>`, 'text/html').body.firstElementChild.querySelectorAll('svg[data-marpit-svg]')
  marpBrowser(holder)

  for (let i = 0; i < slides.length; i++) {
    wrap.innerHTML = ''
    wrap.appendChild(slides[i].cloneNode(true))
    const t0 = performance.now()
    const dataUrl = await window.htmlToImage.toPng(holder, { pixelRatio: 2, backgroundColor: '#ffffff', skipFonts: true })
    r.slides.push({ slide: i + 1, ms: +(performance.now() - t0).toFixed(1), bytes: dataUrl.length, dataUrl })
  }
  holder.remove()
  style.remove()

  // ---- 主题缩略图（可见定位，pixelRatio 0.25 ≈ 320px 宽）----
  const marp2 = new Marp()
  marp2.themeSet.add(customCss)
  const style2 = document.createElement('style')
  document.head.appendChild(style2)
  const th = document.createElement('div')
  th.style.cssText = 'position:absolute;left:0;top:0;width:1280px;height:720px;overflow:hidden;background:#fff'
  document.body.appendChild(th)
  for (const name of ['default', 'gaia', 'uncover', 'company-cn']) {
    const themeMd = `---\ntheme: ${name}\n---\n# 主题 ${name}\n\n## 副标题演示\n\n- 要点一\n- 要点二\n- 要点三`
    const t0 = performance.now()
    const rr = marp2.render(themeMd)
    style2.textContent = rr.css
    th.innerHTML = rr.html
    const t1 = performance.now()
    let thumb
    try {
      thumb = await window.htmlToImage.toPng(th, { pixelRatio: 0.25, backgroundColor: '#ffffff', skipFonts: true })
      r.thumbnails[name] = { renderMs: +(t1 - t0).toFixed(1), thumbMs: +(performance.now() - t1).toFixed(1), bytes: thumb.length, dataUrl: thumb }
    } catch (e) {
      r.thumbnails[name] = { renderMs: +(t1 - t0).toFixed(1), error: String(e).slice(0, 300) }
    }
  }
  th.remove()
  return r
}, md, customCss)

for (const s of report.slides) {
  writeFileSync(out(`inline-visible-slide-${s.slide}@2x.png`), Buffer.from(s.dataUrl.split(',')[1], 'base64'))
  s.file = `inline-visible-slide-${s.slide}@2x.png`
  delete s.dataUrl
}
for (const [name, t] of Object.entries(report.thumbnails)) {
  if (t.dataUrl) {
    writeFileSync(out(`theme-thumb-${name}.png`), Buffer.from(t.dataUrl.split(',')[1], 'base64'))
    t.file = `theme-thumb-${name}.png`
    delete t.dataUrl
  }
}
writeFileSync(out('visible-capture-report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
await browser.close()

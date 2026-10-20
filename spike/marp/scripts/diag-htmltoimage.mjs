// 诊断 html-to-image 为何输出空白：简单 DOM / marp section / 可见位置 / 直接 section
import puppeteer from 'puppeteer-core'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const out = (f) => fileURLToPath(new URL(`../out/${f}`, import.meta.url))
const md = readFileSync(new URL('../samples/sample-browser.md', import.meta.url), 'utf8')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const page = await browser.newPage()
await page.setViewport({ width: 1400, height: 900 })
page.setDefaultTimeout(45000)
await page.setRequestInterception(true)
page.on('request', (r) => (/^https?:/.test(r.url()) ? r.abort() : r.continue()))
await page.setContent('<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0"></body></html>')
await page.addScriptTag({ path: out('marp-core.browser.min.js') })
await page.addScriptTag({ path: fileURLToPath(new URL('../node_modules/html-to-image/dist/html-to-image.js', import.meta.url)) })
await page.addScriptTag({ path: fileURLToPath(new URL('../node_modules/html2canvas/dist/html2canvas.min.js', import.meta.url)) })

const report = await page.evaluate(async (md) => {
  const { Marp } = window.MarpCore
  const r = { tests: [] }
  const save = async (name, fn) => {
    const t0 = performance.now()
    try {
      const url = await fn()
      r.tests.push({ name, ms: +(performance.now() - t0).toFixed(1), bytes: url.length, prefix: url.slice(0, 40), dataUrl: url })
    } catch (e) {
      r.tests.push({ name, ms: +(performance.now() - t0).toFixed(1), error: String(e).slice(0, 400) })
    }
  }

  // 1) 简单 div（可见）
  const simple = document.createElement('div')
  simple.style.cssText = 'width:640px;height:360px;background:#0b1f33;color:#fff;font:32px/1.4 "Microsoft YaHei",sans-serif;padding:24px'
  simple.textContent = '简单 DOM 截图测试：中文 Hello 123'
  document.body.appendChild(simple)
  await save('simple-visible', () => window.htmlToImage.toPng(simple, { pixelRatio: 2 }))

  // 2) marp 渲染（inlineSVG:false），放到可见位置
  const marp = new Marp({ inlineSVG: false, math: 'mathjax' })
  const res = marp.render(md)
  const style = document.createElement('style')
  style.textContent = res.css
  document.head.appendChild(style)
  const holder = document.createElement('div')
  holder.style.cssText = 'position:absolute;left:20px;top:400px;width:1280px;height:720px;overflow:hidden;background:#fff;transform:scale(0.5);transform-origin:top left'
  holder.innerHTML = res.html
  document.body.appendChild(holder)
  const section = holder.querySelector('section')
  await save('marp-holder-visible', () => window.htmlToImage.toPng(holder, { pixelRatio: 2, backgroundColor: '#ffffff' }))
  await save('marp-holder-skipFonts', () => window.htmlToImage.toPng(holder, { pixelRatio: 2, backgroundColor: '#ffffff', skipFonts: true }))
  await save('marp-section-direct', () => window.htmlToImage.toPng(section, { pixelRatio: 2, backgroundColor: '#ffffff' }))
  // html2canvas 对照
  await save('marp-holder-html2canvas', async () => {
    const c = await window.html2canvas(holder, { scale: 2, backgroundColor: '#ffffff', logging: false })
    return c.toDataURL('image/png')
  })
  // 3) 若直接 section 的父级没有 .marpit 呢？section 已在 holder 内，CSS 选择器 div.marpit > section 需要外层
  return r
}, md)

for (const t of report.tests) {
  if (t.dataUrl) {
    writeFileSync(out(`diag-${t.name}.png`), Buffer.from(t.dataUrl.split(',')[1], 'base64'))
    t.dataUrl = '(base64 removed)'
  }
}
writeFileSync(out('diag-htmltoimage.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
await browser.close()

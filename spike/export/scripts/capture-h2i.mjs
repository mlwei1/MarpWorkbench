/**
 * 对照通道：浏览器端 html-to-image 逐页 2x PNG（M0 遗留验证）。
 * 与 capture-cdp.mjs 同一份 capture.html，便于像素级/人工对比主题保真。
 *
 * 复现：node scripts/capture-h2i.mjs
 * 产物：out/h2i-slide-N.png + out/h2i-report.json
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer-core'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const outDir = path.join(ROOT, 'out')
const inputFile = path.join(outDir, 'capture.html')
const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const h2iPath = path.join(ROOT, 'node_modules', 'html-to-image', 'dist', 'html-to-image.js')

const report = { ok: false, inputFile }
const t0 = Date.now()
let browser
try {
  browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    args: ['--disable-gpu', '--no-first-run', '--no-default-browser-check', '--allow-file-access-from-files']
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 })
  await page.goto(pathToFileURL(inputFile).href, { waitUntil: 'load', timeout: 30000 })
  await page.waitForFunction('window.__MWB_READY__ === true', { timeout: 15000 })
  await page.addScriptTag({ path: h2iPath })

  // 逐页：可见容器 + 单页挂载（负坐标会导致 html-to-image 全白，见 marp-tech 实测）
  const result = await page.evaluate(async () => {
    const slides = [...document.querySelectorAll('div.marpit > svg[data-marpit-svg]')]
    const holder = document.createElement('div')
    holder.style.cssText =
      'position:fixed;left:0;top:0;width:1280px;height:720px;overflow:hidden;background:#fff;z-index:99999'
    const wrap = document.createElement('div')
    wrap.className = 'marpit'
    holder.appendChild(wrap)
    document.body.appendChild(holder)
    const images = []
    for (let i = 0; i < slides.length; i++) {
      wrap.innerHTML = ''
      wrap.appendChild(slides[i].cloneNode(true))
      const t = performance.now()
      try {
        const dataUrl = await window.htmlToImage.toPng(holder, {
          pixelRatio: 2,
          backgroundColor: '#ffffff',
          skipFonts: true
        })
        images.push({ index: i, ms: +(performance.now() - t).toFixed(1), dataUrl })
      } catch (e) {
        images.push({ index: i, ms: +(performance.now() - t).toFixed(1), error: String(e).slice(0, 300) })
      }
    }
    holder.remove()
    return { slides: slides.length, images }
  })
  report.slides = result.slides
  report.images = []
  for (const img of result.images) {
    if (!img.dataUrl) {
      report.images.push(img)
      continue
    }
    const buf = Buffer.from(img.dataUrl.split(',')[1], 'base64')
    const file = path.join(outDir, `h2i-slide-${img.index + 1}.png`)
    fs.writeFileSync(file, buf)
    report.images.push({
      index: img.index,
      file: path.relative(ROOT, file),
      bytes: buf.length,
      w: buf.readUInt32BE(16),
      h: buf.readUInt32BE(20),
      ms: img.ms
    })
  }
  report.ok = true
  report.totalMs = Date.now() - t0
} catch (err) {
  report.error = String(err && err.message ? err.message : err)
} finally {
  if (browser) await browser.close().catch(() => {})
}
fs.writeFileSync(path.join(outDir, 'h2i-report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
if (!report.ok) process.exit(1)

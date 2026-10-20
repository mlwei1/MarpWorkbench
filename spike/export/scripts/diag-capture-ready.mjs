/**
 * 验证：helper(data: URL) + ready 标记合并成同一段 JS 后，
 * - helper 确实执行（customElements 注册 + auto-scaling）
 * - window.__MWB_READY__ 能正常置位（CDP 截图等待条件）
 * 用法：node scripts/diag-capture-ready.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Marp } from '@marp-team/marp-core'
import puppeteer from 'puppeteer-core'
import { buildPage } from './print-page.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const REPO = path.resolve(ROOT, '..', '..')
const outDir = path.join(ROOT, 'out')
const bundle = fs.readFileSync(path.join(REPO, 'web', 'dist', 'marp-core.browser.js'), 'utf8')

const theme = fs.readFileSync(path.join(ROOT, 'themes', 'gradient-spike.css'), 'utf8')
const marp = new Marp({ html: true, script: false, math: { lib: 'mathjax' }, emoji: { shortcode: true, unicode: false } })
marp.themeSet.add(theme)
const markdown = fs.readFileSync(path.join(ROOT, 'sample-deck.md'), 'utf8')
const r = marp.render(markdown)

const htmlPath = path.join(outDir, 'capture-helper-ready.html')
fs.writeFileSync(
  htmlPath,
  buildPage({ html: r.html, css: r.css, title: 'ready test', width: 1280, height: 720, helperBundle: bundle, readyMarker: true })
)

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--disable-gpu', '--no-first-run', '--allow-file-access-from-files']
})
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 720 })
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)))
const t0 = Date.now()
await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load', timeout: 120000 })
let readyMs = null
try {
  await page.waitForFunction('window.__MWB_READY__ === true', { timeout: 20000, polling: 50 })
  readyMs = Date.now() - t0
} catch {
  /* timeout */
}
const state = await page.evaluate(() => ({
  helperApplied: window.__MWB_HELPER_APPLIED__,
  marpPreRegistered: !!customElements.get('marp-pre'),
  ready: window.__MWB_READY__,
  slides: document.querySelectorAll('div.marpit > svg[data-marpit-svg]').length,
  marpPreCount: document.querySelectorAll('marp-pre').length
}))
console.log(JSON.stringify({ readyMs, state, pageErrors: errors, htmlBytes: fs.statSync(htmlPath).size }, null, 2))
await browser.close()

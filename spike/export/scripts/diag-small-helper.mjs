/**
 * 验证：直接用 @marp-team/marp-core 自带的 `lib/browser.js`（9.3KB 自执行 IIFE）
 * 作为导出页 helper —— 是否注册 custom elements / 应用 auto-scaling / 就绪时间。
 *
 * 用法：node scripts/diag-small-helper.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Marp } from '@marp-team/marp-core'
import puppeteer from 'puppeteer-core'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const REPO = path.resolve(ROOT, '..', '..')
const outDir = path.join(ROOT, 'out')
const helperPath = path.join(REPO, 'web', 'node_modules', '@marp-team', 'marp-core', 'lib', 'browser.js')
const helper = fs.readFileSync(helperPath, 'utf8')
console.log('helper bytes:', helper.length, 'has <!--:', helper.includes('<!--'), "'</script':", helper.toLowerCase().includes('</script'))

const READY = `window.__MWB_READY__ = false;
(function () {
  function markReady() {
    requestAnimationFrame(function () { requestAnimationFrame(function () {
      requestAnimationFrame(function () { window.__MWB_READY__ = true; });
    }); });
  }
  var f = (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve();
  f.then(function () { setTimeout(markReady, 120); }).catch(markReady);
})();`

function page(html, css, title, withReady) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>
<style>@page{size:1280px 720px;margin:0}html,body{margin:0;padding:0;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}
div.marpit>svg[data-marpit-svg]{display:block;width:1280px;height:720px;margin:0}
@media print{div.marpit>svg[data-marpit-svg]{break-after:page;break-inside:avoid}div.marpit>svg[data-marpit-svg]:last-child{break-after:auto}}
${css}</style></head><body>${html}
<script>${helper.replaceAll('</script', '<\\/script')}</script>
${withReady ? `<script>${READY}<\/script>` : ''}
</body></html>`
}

// 密集代码块页（18 行）
const theme = fs.readFileSync(path.join(REPO, 'themes', 'business-blue.css'), 'utf8')
const marp = new Marp({ html: true, script: false, math: { lib: 'mathjax' }, emoji: { shortcode: true, unicode: false } })
marp.themeSet.add(theme)
const lines = ['---', 'marp: true', 'theme: business-blue', 'size: 16:9', '---', '', '# 长代码块', '', '```js']
for (let i = 1; i <= 18; i++) lines.push(`const line${i} = ${i} // 代码行`)
lines.push('```')
const r = marp.render(lines.join('\n'))
const htmlPath = path.join(outDir, 'small-helper-dense.html')
fs.writeFileSync(htmlPath, page(r.html, r.css, 'small helper dense', true))

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--disable-gpu', '--no-first-run', '--allow-file-access-from-files']
})
const p = await browser.newPage()
await p.setViewport({ width: 1280, height: 720 })
const errors = []
p.on('pageerror', (e) => errors.push(String(e).slice(0, 300)))
const t0 = Date.now()
await p.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load', timeout: 60000 })
let readyMs = null
try {
  await p.waitForFunction('window.__MWB_READY__ === true', { timeout: 15000, polling: 50 })
  readyMs = Date.now() - t0
} catch {}
const state = await p.evaluate(() => ({
  ready: window.__MWB_READY__,
  marpPreRegistered: !!customElements.get('marp-pre'),
  marpPreCount: document.querySelectorAll('marp-pre').length,
  preCount: document.querySelectorAll('pre').length,
  sectionScroll: (() => {
    const s = document.querySelector('section')
    return s ? [s.scrollHeight, s.clientHeight] : null
  })()
}))
console.log(JSON.stringify({ readyMs, state, pageErrors: errors, htmlBytes: fs.statSync(htmlPath).size }, null, 2))
await browser.close()

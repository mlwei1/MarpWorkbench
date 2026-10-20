/**
 * 诊断：打印页里 marp browser helper 是否真正生效（customElements / auto-scaling 元素状态）。
 * 用法：node scripts/diag-helper-runtime.mjs [html]
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer-core'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const html = path.resolve(process.argv[2] || path.join(ROOT, 'out', 'dense-with-helper.html'))
const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: 'new',
  args: ['--disable-gpu', '--no-first-run', '--allow-file-access-from-files']
})
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 720 })
page.on('console', (m) => console.log('[page]', m.type(), m.text().slice(0, 200)))
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)))
await page.goto(pathToFileURL(html).href, { waitUntil: 'load', timeout: 60000 })
try {
  await page.waitForFunction('window.__MWB_HELPER_APPLIED__ === true', { timeout: 20000 })
} catch {
  console.log('helper applied marker not set (timeout)')
}
await new Promise((r) => setTimeout(r, 500))
const diag = await page.evaluate(() => {
  const pre = document.querySelector('pre[is="marp-pre"]')
  const section = document.querySelector('section')
  const cs = pre ? getComputedStyle(pre) : null
  const secCs = section ? getComputedStyle(section) : null
  return {
    marpCoreBundle: typeof window.MarpCoreBundle,
    helperApplied: window.__MWB_HELPER_APPLIED__,
    marpPreRegistered: !!customElements.get('marp-pre'),
    marpAutoScalingRegistered: !!customElements.get('marp-auto-scaling'),
    customElements: ['marp-pre', 'marp-auto-scaling', 'marp-fitting-header'].map((n) => [n, !!customElements.get(n)]),
    pre: pre
      ? {
          fontSize: cs.fontSize,
          transform: cs.transform,
          scrollHeight: pre.scrollHeight,
          clientHeight: pre.clientHeight,
          rect: pre.getBoundingClientRect().toJSON(),
          outerStart: pre.outerHTML.slice(0, 300),
          shadow: pre.shadowRoot ? 'has-shadow' : 'no-shadow',
          upscaled: pre.getAttribute('data-upscaled')
        }
      : null,
    section: section
      ? {
          fontSize: secCs.fontSize,
          clientHeight: section.clientHeight,
          scrollHeight: section.scrollHeight,
          padding: secCs.padding,
          overflow: secCs.overflow
        }
      : null,
    rootVars: (() => {
      const out = {}
      for (const k of ['--marp-auto-scaling-svg-width', '--marp-auto-scaling-white-space', '--marp-auto-scaling-scale']) {
        out[k] = getComputedStyle(document.documentElement).getPropertyValue(k)
      }
      return out
    })()
  }
})
console.log(JSON.stringify(diag, null, 2))
await browser.close()

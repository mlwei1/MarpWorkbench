// 诊断：helper 生效后 auto-scaling 的 DOM 结果（pre 是否被替换/缩放），以及打印 PDF 差异
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer-core'

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--allow-file-access-from-files']
})
for (const f of ['dense-without-helper.html', 'dense-with-helper.html']) {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 720 })
  await page.goto(pathToFileURL(path.resolve('out', f)).href, { waitUntil: 'load', timeout: 120000 })
  await new Promise((r) => setTimeout(r, 800))
  const info = await page.evaluate(() => {
    const section = document.querySelector('section')
    const pre = document.querySelector('pre[is="marp-pre"], marp-pre, pre')
    const svg = document.querySelector('svg[data-marpit-svg]')
    const sec = getComputedStyle(section)
    return {
      marker: window.__MWB_HELPER_APPLIED__,
      marpPreRegistered: !!customElements.get('marp-pre'),
      hasPre: !!document.querySelector('pre'),
      preFontSize: pre ? getComputedStyle(pre).fontSize : null,
      preRect: pre ? { h: Math.round(pre.getBoundingClientRect().height), w: Math.round(pre.getBoundingClientRect().width) } : null,
      codeFontSize: (() => {
        const c = document.querySelector('pre code')
        return c ? getComputedStyle(c).fontSize : null
      })(),
      sectionOverflow: sec.overflow,
      sectionScroll: section ? [section.scrollHeight, section.clientHeight] : null,
      customElementsUsed: [...document.querySelectorAll('*')].filter((el) => el.tagName.includes('-')).map((el) => el.tagName.toLowerCase()).slice(0, 10),
      svgHeight: svg ? Math.round(svg.getBoundingClientRect().height) : null
    }
  })
  console.log(f, JSON.stringify(info, null, 2))
  await page.close()
}
await browser.close()

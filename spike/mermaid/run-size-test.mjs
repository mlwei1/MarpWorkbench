// Mermaid 尺寸引擎真实 Chrome 自测（M5.0-A / 契约 §1.4）：
//   默认放大（2 节点小图宽度提升）、s/m/l/xl/70%/900px 样式、非法/超 5 行指令回退 auto、
//   16:9 不溢出（含 xl 640px 竖向图）、renderMermaidPreview API（不写缓存/错误可读）。
// 用法：node spike/mermaid/run-size-test.mjs
// 产物：out/size-artifacts.json（供 run-print-test.mjs 打印 PDF 校验）、out/size-test-report.json、shots/size-*.png
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { startServer } from './serve.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..', '..')
const OUT = path.join(HERE, 'out')
const SHOTS = path.join(HERE, 'shots')
fs.mkdirSync(OUT, { recursive: true })
fs.mkdirSync(SHOTS, { recursive: true })

const requireFromMarp = createRequire(pathToFileURL(path.join(REPO, 'spike', 'marp', 'package.json')))
const puppeteer = requireFromMarp('puppeteer-core')

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean)
const chromePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p))
if (!chromePath) throw new Error('未找到 Chrome/Edge，可设置 CHROME_PATH')

const failures = []
const t0 = Date.now()
const server = await startServer(0)
console.log(`[run-size-test] server ${server.url}`)

execFileSync(process.execPath, [path.join(HERE, 'scripts', 'build-test-module.mjs')], { stdio: 'inherit', cwd: REPO })

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  args: ['--disable-gpu', '--no-first-run', '--no-default-browser-check', '--font-render-hinting=none'],
  defaultViewport: { width: 1400, height: 1000, deviceScaleFactor: 1 },
})
const chromeVersion = await browser.version()

const report = { source: 'spike/mermaid/run-size-test.mjs', chrome: chromeVersion, checks: [], ok: false }
const events = { origin: server.url, requests: [], consoleErrors: [], pageErrors: [] }

try {
  const page = await browser.newPage()
  page.on('request', (req) => events.requests.push(req.url()))
  page.on('console', (msg) => {
    if (msg.type() === 'error') events.consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => events.pageErrors.push(String(err && err.message ? err.message : err)))

  await page.goto(`${server.url}/page/size.html`, { waitUntil: 'load', timeout: 120000 })
  await page.waitForFunction('window.__DONE__ === true', { timeout: 240000, polling: 250 })
  const result = await page.evaluate(() => window.__RESULT__)
  const artifacts = await page.evaluate(() => window.__ARTIFACTS_B64__)
  report.checks = result.checks || []
  report.ok = !!result.ok
  report.fatal = result.fatal || null
  report.ms = result.ms || {}
  report.slides = result.slides || []
  report.smallDiagram = result.smallDiagram || null
  report.xlDiagram = result.xlDiagram || null
  report.xlWithHeading = result.xlWithHeading || null
  report.xlWithHeadingError = result.xlWithHeadingError || null
  report.net = {
    requestCount: events.requests.length,
    externalRequests: events.requests.filter((u) => !u.startsWith(events.origin)),
    consoleErrors: events.consoleErrors,
    pageErrors: events.pageErrors,
  }

  if (!result.ok) failures.push('size.html FAIL')
  if (report.net.externalRequests.length) failures.push(`外网请求：${report.net.externalRequests.slice(0, 3).join(', ')}`)
  if (report.net.pageErrors.length) failures.push(`JS 异常：${report.net.pageErrors.slice(0, 3).join(' | ')}`)
  if (report.net.consoleErrors.length) failures.push(`console error：${report.net.consoleErrors.slice(0, 3).join(' | ')}`)
  if (result.fatal) failures.push(`fatal：${String(result.fatal).slice(0, 300)}`)

  // 截图（整 deck + 每页）
  await page.evaluate(() => {
    document.getElementById('status').style.display = 'none'
  })
  const shots = []
  const fullPath = path.join(SHOTS, 'size-deck-full.png')
  await page.screenshot({ path: fullPath, fullPage: true })
  shots.push(fullPath)
  const slides = await page.evaluate(() =>
    Array.prototype.map.call(document.querySelectorAll('#deck svg[data-marpit-svg]'), (s, i) => {
      const r = s.getBoundingClientRect()
      return { index: i + 1, x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height }
    }),
  )
  const names = ['auto-small', 's', 'm', 'l', 'xl', '70pct', '900px', 'invalid-auto', 'line6-auto']
  for (const s of slides) {
    const file = path.join(SHOTS, `size-slide-${s.index}-${names[s.index - 1] || 'x'}.png`)
    await page.screenshot({ path: file, clip: { x: Math.max(0, s.x), y: Math.max(0, s.y), width: Math.min(s.w, 1400), height: Math.min(s.h, 1000) } })
    shots.push(file)
  }
  report.shots = shots.map((p) => path.relative(REPO, p))

  // 产物（供打印 PDF 校验）
  const artifactsPath = path.join(OUT, 'size-artifacts.json')
  fs.writeFileSync(
    artifactsPath,
    JSON.stringify(
      {
        source: 'spike/mermaid/run-size-test.mjs',
        browser: result.browser,
        chrome: chromePath,
        renderedHtml: Buffer.from(artifacts.renderedHtml || '', 'base64').toString('utf8'),
        rawMarpHtml: Buffer.from(artifacts.rawMarpHtml || '', 'base64').toString('utf8'),
        css: artifacts.css || '',
      },
      null,
      2,
    ),
  )
  report.artifacts = path.relative(REPO, artifactsPath)
  await page.close()
} finally {
  await browser.close()
  server.server.close()
}

report.ok = failures.length === 0
report.failures = failures
report.elapsedMs = Date.now() - t0
const reportPath = path.join(OUT, 'size-test-report.json')
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))

// 控制台摘要
const checks = report.checks
console.log('\n===== mermaid size test =====')
console.log(`chrome: ${report.chrome}  elapsed: ${report.elapsedMs} ms`)
console.log(`checks: ${checks.filter((c) => c.ok).length}/${checks.length}`)
for (const c of checks) if (!c.ok) console.log(`  ✗ ${c.name} => ${c.detail}`)
if (report.smallDiagram) console.log(`2 节点小图: natural=${report.smallDiagram.naturalWidth}px old=${report.smallDiagram.oldRenderedWidth}px new=${report.smallDiagram.newRenderedWidth}px (+${report.smallDiagram.increasePercent}%)`)
if (report.xlDiagram) console.log(`xl 竖向图（无标题页）: rendered=${report.xlDiagram.renderedWidth}x${report.xlDiagram.renderedHeight} content=${report.xlDiagram.contentWidth}x${report.xlDiagram.contentHeight} bottomPadding=${report.xlDiagram.fitBottomPadding} fitsSection=${report.xlDiagram.fitsSection} fitsContent=${report.xlDiagram.fitsContent}`)
if (report.xlWithHeading) console.log(`xl + 标题压力用例: rendered=${report.xlWithHeading.renderedWidth}x${report.xlWithHeading.renderedHeight} bottom=${report.xlWithHeading.svgBottom}/${report.xlWithHeading.sectionBottom} overflowsBy=${report.xlWithHeading.overflowsBy}px fitsSection=${report.xlWithHeading.fitsSection}`)
for (const s of report.slides) console.log(`  slide${s.slide} ${s.preset}: natural=${s.naturalWidth}x${s.naturalHeight} rendered=${s.renderedWidth}x${s.renderedHeight} fitBottomPadding=${s.fitBottomPadding} fitsSection=${s.fitsSection} fitsContent=${s.fitsContent}`)
console.log(`screenshots: ${report.shots.join(', ')}`)
console.log(`report: ${path.relative(REPO, reportPath)}`)
if (!report.ok) {
  console.log('\nFAILURES:')
  for (const f of failures) console.log(' - ' + f)
  process.exitCode = 1
} else {
  console.log('RESULT: PASS')
}

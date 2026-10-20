// mermaid 模块真实 Chrome 自测：真实 marp-core 渲染 → 模块替换 → DOM 校验 + 截图
// 用法：node spike/mermaid/run-render-test.mjs
//
// 覆盖（契约 §1.4）：
//  ① 真实 Chrome 里用 marp-core 渲染含 flowchart + sequence + 非法块的 deck；
//  ② `renderMermaidInHtml` 产出 2 个 .mwb-mermaid svg + 1 个错误提示（保留代码块）；
//  ③ 缓存/同步路径/重复代码块 id 唯一性/清缓存行为；
//  ④ 懒加载：无 mermaid 的 deck 0 次请求；有 mermaid 时恰好 1 次；
//  ⑤ 零外网请求（只允许 127.0.0.1）；
//  ⑥ 截图：整 deck + 每个 slide（spike/mermaid/shots/）；产物写入 out/artifacts.json 供打印测试复用。
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
const reports = {}

function collect(pageEvents, label) {
  const external = pageEvents.requests.filter((u) => !u.startsWith(pageEvents.origin))
  return {
    label,
    requestCount: pageEvents.requests.length,
    externalRequests: external,
    consoleErrors: pageEvents.consoleErrors,
    pageErrors: pageEvents.pageErrors,
    bundleRequests: pageEvents.requests.filter((u) => /\/mermaid\.browser\.js(\?|$)/.test(u)).length,
  }
}

async function runPage(browser, url, { waitMs = 180000 } = {}) {
  const page = await browser.newPage()
  const events = { origin: new URL(url).origin, requests: [], consoleErrors: [], pageErrors: [] }
  page.on('request', (req) => events.requests.push(req.url()))
  page.on('console', (msg) => {
    if (msg.type() === 'error') events.consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => events.pageErrors.push(String(err && err.message ? err.message : err)))
  await page.goto(url, { waitUntil: 'load', timeout: 120000 })
  await page.waitForFunction('window.__DONE__ === true', { timeout: waitMs, polling: 250 })
  const result = await page.evaluate(() => window.__RESULT__)
  let artifacts = null
  try {
    artifacts = await page.evaluate(() => window.__ARTIFACTS_B64__ || null)
  } catch {
    artifacts = null
  }
  return { page, events, result, artifacts }
}

const t0 = Date.now()
const server = await startServer(0)
console.log(`[run-render-test] server ${server.url}`)

// 1) 先构建模块测试包（真实 web/src/mermaid/*.ts）
execFileSync(process.execPath, [path.join(HERE, 'scripts', 'build-test-module.mjs')], { stdio: 'inherit', cwd: REPO })

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  args: ['--disable-gpu', '--no-first-run', '--no-default-browser-check', '--font-render-hinting=none'],
  defaultViewport: { width: 1400, height: 1000, deviceScaleFactor: 1 },
})
const chromeVersion = await browser.version()

try {
  // ---- 2) 懒加载页 ----
  const lazy = await runPage(browser, `${server.url}/page/lazy.html`)
  reports.lazy = {
    checks: lazy.result.checks,
    ok: lazy.result.ok,
    fatal: lazy.result.fatal || null,
    net: collect(lazy.events, 'lazy'),
  }
  if (!lazy.result.ok) failures.push('lazy.html FAIL')
  await lazy.page.close()

  // ---- 3) 主测试页 ----
  const main = await runPage(browser, `${server.url}/page/test.html`)
  reports.render = {
    checks: main.result.checks,
    ok: main.result.ok,
    fatal: main.result.fatal || null,
    ms: main.result.ms,
    overflow: main.result.overflow,
    net: collect(main.events, 'test'),
    browser: main.result.browser,
  }
  if (!main.result.ok) failures.push('test.html FAIL')

  // 零外网请求
  const mainNet = reports.render.net
  if (mainNet.externalRequests.length) failures.push(`test.html 出现外网请求：${mainNet.externalRequests.slice(0, 3).join(', ')}`)
  if (mainNet.pageErrors.length) failures.push(`test.html JS 异常：${mainNet.pageErrors.slice(0, 3).join(' | ')}`)
  if (mainNet.consoleErrors.length) failures.push(`test.html console error：${mainNet.consoleErrors.slice(0, 3).join(' | ')}`)
  if (reports.render.fatal) failures.push(`test.html fatal：${reports.render.fatal.slice(0, 300)}`)

  // ---- 4) 截图（整 deck + 每页） ----
  const page = main.page
  await page.evaluate(() => {
    document.getElementById('status').style.display = 'none'
  })
  const shots = []
  const fullPath = path.join(SHOTS, 'deck-full.png')
  await page.screenshot({ path: fullPath, fullPage: true })
  shots.push(fullPath)
  const slides = await page.evaluate(() =>
    Array.prototype.map.call(document.querySelectorAll('#deck svg[data-marpit-svg]'), (s, i) => {
      const r = s.getBoundingClientRect()
      return { index: i + 1, x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height }
    }),
  )
  const names = ['slide-1-flowchart', 'slide-2-sequence', 'slide-3-error']
  for (const s of slides) {
    const name = names[s.index - 1] || `slide-${s.index}`
    const file = path.join(SHOTS, `${name}.png`)
    await page.screenshot({
      path: file,
      clip: { x: Math.max(0, s.x), y: Math.max(0, s.y), width: Math.min(s.w, 1400), height: Math.min(s.h, 1000) },
    })
    shots.push(file)
  }
  reports.shots = shots.map((p) => path.relative(REPO, p))

  // ---- 5) 产物（打印/PDF 测试复用） ----
  const art = main.artifacts || {}
  const artifactsPath = path.join(OUT, 'artifacts.json')
  fs.writeFileSync(
    artifactsPath,
    JSON.stringify(
      {
        source: 'spike/mermaid/run-render-test.mjs',
        browser: reports.render.browser,
        chrome: chromePath,
        renderedHtml: Buffer.from(art.renderedHtml || '', 'base64').toString('utf8'),
        rawMarpHtml: Buffer.from(art.rawMarpHtml || '', 'base64').toString('utf8'),
        css: art.css || '',
      },
      null,
      2,
    ),
  )
  reports.artifacts = path.relative(REPO, artifactsPath)

  await page.close()
} finally {
  await browser.close()
  server.server.close()
}

reports.ok = failures.length === 0
reports.failures = failures
reports.elapsedMs = Date.now() - t0
reports.chrome = { path: chromePath, version: chromeVersion }
const reportPath = path.join(OUT, 'render-test-report.json')
fs.writeFileSync(reportPath, JSON.stringify(reports, null, 2))

// 控制台摘要
const renderChecks = reports.render.checks || []
const lazyChecks = reports.lazy.checks || []
console.log('\n===== mermaid render test =====')
console.log(`chrome: ${reports.chrome.version}  elapsed: ${reports.elapsedMs} ms`)
console.log(`render checks: ${renderChecks.filter((c) => c.ok).length}/${renderChecks.length}  lazy checks: ${lazyChecks.filter((c) => c.ok).length}/${lazyChecks.length}`)
for (const c of [...renderChecks, ...lazyChecks]) if (!c.ok) console.log(`  ✗ ${c.name}  => ${c.detail}`)
console.log(`net(test): requests=${reports.render.net.requestCount} mermaid-bundle=${reports.render.net.bundleRequests} external=${reports.render.net.externalRequests.length}`)
console.log(`net(lazy): requests=${reports.lazy.net.requestCount} bundle=${reports.lazy.net.bundleRequests} external=${reports.lazy.net.externalRequests.length}`)
if (reports.render.ms) console.log(`timings: ${JSON.stringify(reports.render.ms)}`)
console.log(`screenshots: ${reports.shots.join(', ')}`)
console.log(`report: ${path.relative(REPO, reportPath)}`)
if (!reports.ok) {
  console.log('\nFAILURES:')
  for (const f of failures) console.log(' - ' + f)
  process.exitCode = 1
} else {
  console.log('RESULT: PASS')
}

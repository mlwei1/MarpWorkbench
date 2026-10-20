// 打印 PDF 保真测试：真实 marp-core deck（含 mermaid 图）→ 打印页 → 无头 Chrome --print-to-pdf → 校验矢量/文本/尺寸
// 用法：node spike/mermaid/run-print-test.mjs
//
// 打印页规则与真实导出管线一致（spike/mermaid/build-print-page.mjs ≡ server/src/export/print_page.rs），
// Chrome 参数与 server/src/export/pdf.rs 一致（--headless=new --no-pdf-header-footer --virtual-time-budget=8000）。
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import { startServer } from './serve.mjs'
import { buildPrintPage } from './build-print-page.mjs'
import { findChrome, runChromePrint as runChromePrintCli } from './chrome-print.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..', '..')
const OUT = path.join(HERE, 'out')
const SHOTS = path.join(HERE, 'shots')
fs.mkdirSync(OUT, { recursive: true })
fs.mkdirSync(SHOTS, { recursive: true })

// 复用 spike/packaging 已安装的 pdfjs-dist（PDF 结构/操作符/文本校验，不新增依赖）
const requireFromPackaging = createRequire(pathToFileURL(path.join(REPO, 'spike', 'packaging', 'browser-print', 'verify.mjs')))
const pdfjs = await import(pathToFileURL(requireFromPackaging.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href)
const OPS = pdfjs.OPS
const pdfjsDir = path.dirname(requireFromPackaging.resolve('pdfjs-dist/legacy/build/pdf.mjs'))
const standardFontDataUrl = path.join(pdfjsDir, '..', '..', 'standard_fonts') + path.sep
// 注：PDF → PNG 光栅化验证在 Node 侧（pdfjs + @napi-rs/canvas）会原生崩溃，改用 Chrome 直接截图打印页
// （见 §5）；PDF 是否矢量由操作符流判定（constructPath 大量 + paintImage=0），比光栅化更可靠。
const requireFromMarp = createRequire(pathToFileURL(path.join(REPO, 'spike', 'marp', 'package.json')))
const puppeteer = requireFromMarp('puppeteer-core')

const chromePath = findChrome()

const checks = []
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail).slice(0, 600) })
const runChromePrint = (url, pdfPath) => runChromePrintCli({ url, pdfPath, chromePath })

const t0 = Date.now()
// 1) 读取 render test 的产物
const artifactsPath = path.join(OUT, 'artifacts.json')
if (!fs.existsSync(artifactsPath)) throw new Error('缺少 out/artifacts.json，请先运行 node spike/mermaid/run-render-test.mjs')
const artifacts = JSON.parse(fs.readFileSync(artifactsPath, 'utf8'))
check('artifacts 含已替换 mermaid 的 html', /class="mwb-mermaid"/.test(artifacts.renderedHtml) && /<svg/.test(artifacts.renderedHtml))
check('artifacts html 中 mermaid 代码块只剩错误块', (artifacts.renderedHtml.match(/class="language-mermaid"/g) || []).length === 1)

// 2) 生成打印页
const printHtml = buildPrintPage({ html: artifacts.renderedHtml, css: artifacts.css, title: 'mermaid 打印测试', readyMarker: true })
const printHtmlPath = path.join(OUT, 'print-deck.html')
fs.writeFileSync(printHtmlPath, printHtml)
check('打印页内联 browser helper', printHtml.includes('data-marpit-svg') && printHtml.length > 50000)

// 3) 起本地服务 + 无头 Chrome 打印（与导出管线同参数）
const server = await startServer(0)
const pdfPath = path.join(OUT, 'print-deck.pdf')
const print = await runChromePrint(`${server.url}/out/print-deck.html`, pdfPath)
server.server.close()
check('Chrome --print-to-pdf 生成 PDF', print.pdfExists && fs.statSync(pdfPath).size > 10 * 1024, JSON.stringify({ code: print.code, exists: print.pdfExists, stderr: print.stderrTail }))

// 4) PDF 校验：页数/尺寸/文本/矢量
const report = { pdfPath: path.relative(REPO, pdfPath), bytes: 0, pageCount: 0, pageSizes: [], printMs: print.pdfReadyMs ?? print.exitMs, printExitMs: print.exitMs, pages: [], checks, chrome: chromePath }
let textDump = []
if (print.pdfExists) {
  const buf = fs.readFileSync(pdfPath)
  report.bytes = buf.length
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf), useWorkerFetch: false, isEvalSupported: false, useSystemFonts: true, disableFontFace: true, standardFontDataUrl }).promise
  report.pageCount = pdf.numPages
  check('PDF 页数 = 3（与 deck 页数一致）', pdf.numPages === 3, pdf.numPages)
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const [, , W, H] = page.view
    report.pageSizes.push({ w: +W.toFixed(2), h: +H.toFixed(2) })
    const tc = await page.getTextContent()
    const text = tc.items.map((it) => ('str' in it ? it.str : '')).join('')
    textDump.push(text)
    const tcItems = tc.items.filter((it) => 'str' in it && it.str.trim()).length
    // 矢量操作符统计（constructPath=路径绘制；paintImage* = 位图；shadingFill=渐变）
    const ops = await page.getOperatorList()
    const counts = { constructPath: 0, fill: 0, stroke: 0, images: 0, shading: 0, ops: ops.fnArray.length }
    for (let k = 0; k < ops.fnArray.length; k++) {
      const fn = ops.fnArray[k]
      if (fn === OPS.constructPath) counts.constructPath++
      else if (fn === OPS.fill || fn === OPS.eoFill) counts.fill++
      else if (fn === OPS.stroke) counts.stroke++
      else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintJpegXObject) counts.images++
      else if (fn === OPS.shadingFill) counts.shading++
    }
    let textInPage = true
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const it of tc.items) {
      if (!('transform' in it)) continue
      minX = Math.min(minX, it.transform[4]); maxX = Math.max(maxX, it.transform[4] + it.width)
      minY = Math.min(minY, it.transform[5]); maxY = Math.max(maxY, it.transform[5] + it.height)
    }
    if (Number.isFinite(minX)) textInPage = minX >= -2 && maxX <= W + 2 && minY >= -2 && maxY <= H + 2
    report.pages.push({ page: i, pagePt: [+W.toFixed(2), +H.toFixed(2)], textLength: text.length, textItems: tcItems, textSample: text.slice(0, 120), vectorOps: counts, textInPage })
  }
  check('每页尺寸 = 960×540pt（=1280×720px 16:9）', report.pageSizes.every((s) => Math.abs(s.w - 960) < 0.6 && Math.abs(s.h - 540) < 0.6), JSON.stringify(report.pageSizes))
  // PDF 内嵌位图：mermaid v12 默认主题的节点阴影是 CSS drop-shadow filter，Chrome 打印 PDF 时会把
  // filter 结果光栅化成小位图（约 4x 分辨率）；几何/文字仍是矢量。判定标准：
  // 每页路径绘制足够多 + 文字可提取 + 嵌入位图数量少且都很小（非整页位图化）。
  const embedded = []
  const rawPdf = buf.toString('latin1')
  const imgRe = /\/Subtype\s*\/Image\s*\/Width\s+(\d+)\s*\/Height\s+(\d+)/g
  let im
  while ((im = imgRe.exec(rawPdf))) embedded.push({ w: +im[1], h: +im[2] })
  report.embeddedRasterImages = embedded
  const MAX_EMBED_AREA = 1_200_000
  check(
    '图主体为矢量（每页路径≥10 + 文本可提取）；仅节点阴影为 filter 光栅图（≤16 张、单张≤1.2MP）',
    report.pages.every((p) => p.vectorOps.constructPath >= 10 && p.textItems >= 3) && embedded.length <= 16 && embedded.every((x) => x.w * x.h <= MAX_EMBED_AREA),
    JSON.stringify({ pages: report.pages.map((p) => ({ p: p.page, path: p.vectorOps.constructPath, img: p.vectorOps.images, text: p.textItems })), embeddedCount: embedded.length, embedded: embedded.slice(0, 6) }),
  )
  check('无整页位图化（每张嵌入位图宽高均 < 页面像素 1280×720）', embedded.every((x) => x.w < 1280 && x.h < 720), JSON.stringify(embedded))
  check('mermaid 图文本可提取（flowchart 中文标签）', /开始/.test(textDump[0] || '') && /检查/.test(textDump[0] || '') && /发布上线/.test(textDump[0] || ''), (textDump[0] || '').slice(0, 200))
  check('sequence 图文本可提取（中文参与者/消息）', /用户/.test(textDump[1] || '') && /登录请求/.test(textDump[1] || ''), (textDump[1] || '').slice(0, 200))
  check('错误页保留原始代码 + 中文错误提示（文本可提取）', /graph LR/.test(textDump[2] || '') && /图表渲染失败/.test(textDump[2] || ''), (textDump[2] || '').slice(0, 200))
  check('无页眉页脚（无 URL/日期）', !/(https?:\/\/|file:\/\/|127\.0\.0\.1)/.test(textDump.join(' ')), '')
  check('所有文本坐标在页内（无裁切）', report.pages.every((p) => p.textInPage))
  await pdf.destroy()
}
report.textDump = textDump.map((t) => t.slice(0, 300))

// 5) 打印页 Chrome 截图（目检 PDF 对应的矢量源；PDF 内部矢量性由上面操作符判定）
report.pageShots = []
{
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--disable-gpu', '--no-first-run', '--no-default-browser-check', '--font-render-hinting=none'],
    defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
  })
  try {
    const server = await startServer(0)
    const page = await browser.newPage()
    await page.goto(`${server.url}/out/print-deck.html`, { waitUntil: 'load', timeout: 120000 })
    await page.waitForFunction('window.__MWB_READY__ === true', { timeout: 60000 }).catch(() => {})
    const rects = await page.evaluate(() =>
      Array.prototype.map.call(document.querySelectorAll('svg[data-marpit-svg]'), (s, i) => {
        const r = s.getBoundingClientRect()
        return { index: i + 1, x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height }
      }),
    )
    for (const r of rects) {
      const file = path.join(SHOTS, `print-page-${r.index}.png`)
      await page.screenshot({ path: file, clip: { x: r.x, y: r.y, width: r.w, height: r.h } })
      report.pageShots.push(path.relative(REPO, file))
    }
    await page.close()
    server.server.close()
  } catch (err) {
    report.pageShotsError = String(err && err.message ? err.message : err)
  } finally {
    await browser.close()
  }
}

report.ok = checks.every((c) => c.ok)
report.elapsedMs = Date.now() - t0
const reportPath = path.join(OUT, 'print-test-report.json')
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))

console.log('\n===== mermaid print/PDF test =====')
console.log(`print page: ${path.relative(REPO, printHtmlPath)}  pdf: ${path.relative(REPO, pdfPath)} (${(report.bytes / 1024).toFixed(1)} KB)`)
console.log(`chrome print: pdfReady=${report.printMs} ms (进程退出 ${report.printExitMs} ms); pages: ${report.pageCount} ${JSON.stringify(report.pageSizes)}`)
console.log(`checks: ${checks.filter((c) => c.ok).length}/${checks.length}`)
for (const c of checks) if (!c.ok) console.log(`  ✗ ${c.name} => ${c.detail}`)
for (const p of report.pages) console.log(`  p${p.page}: ops=${p.vectorOps.ops} path=${p.vectorOps.constructPath} fill=${p.vectorOps.fill} stroke=${p.vectorOps.stroke} images=${p.vectorOps.images} text=${p.textItems} items, sample="${(p.textSample || '').replace(/\n/g, ' ')}"`)
console.log(`page shots: ${report.pageShots.join(', ')}`)
console.log(`report: ${path.relative(REPO, reportPath)}`)
console.log(report.ok ? 'RESULT: PASS' : 'RESULT: FAIL')
if (!report.ok) process.exitCode = 1

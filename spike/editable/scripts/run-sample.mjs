/**
 * M4 可编辑 PPTX spike 全流程实测（真跑）：
 *   真实 marp-core 渲染（中文/列表/代码/表格/背景图/Mermaid/备注，含 4:3 deck）
 *   → 真实 Chrome 里调用 measureDeckForEditablePptx（隐藏 iframe）
 *   → 模拟 /api/export/capture：把 backgroundHtml/Css 渲染进页面，逐页 2x 截图拿 dataURL
 *   → 真实 Chrome 里调用 assembleEditablePptx（pptxgenjs 浏览器 bundle）→ 写 sample-editable.pptx
 *   → python-pptx 校验（页数/尺寸/背景 blipFill/文本/notes/a:tbl/run 字体）
 *   → LibreOffice headless 转 PDF 校验页数 + 首页 PNG 截图
 *
 * 运行：node spike/editable/scripts/run-sample.mjs [--skip-libreoffice] [--skip-4x3]
 * 产物：spike/editable/out/**（gitignored）
 */
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import puppeteer from 'puppeteer-core'
import { Marp } from '@marp-team/marp-core'
import { PDFDocument } from 'pdf-lib'
import { build as esbuild } from 'esbuild'

const here = path.dirname(fileURLToPath(import.meta.url))
const spikeDir = path.resolve(here, '..')
const root = path.resolve(spikeDir, '../..')
const harnessDir = path.join(spikeDir, 'harness')
const outDir = path.join(spikeDir, 'out')
mkdirSync(outDir, { recursive: true })

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PYTHON = 'C:\\Users\\52900\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe'
const SOFFICE = 'C:\\Program Files\\LibreOffice\\program\\soffice.exe'
const WEB = path.join(root, 'web')
const args = new Set(process.argv.slice(2))
/** LibreOffice 校验默认关闭：本机 agent 环境里 LO headless 的 PDF 导出会挂起（>3 分钟，已记录），
 *  最终 PDF 页数校验由 Lead 用超时/独立 profile 处理；需要本机尝试时加 --libreoffice。 */
const RUN_LIBREOFFICE = args.has('--libreoffice')
const SKIP_LIBREOFFICE = !RUN_LIBREOFFICE
const SKIP_4X3 = args.has('--skip-4x3')

const report = {
  env: {
    node: process.version,
    chrome: CHROME,
    marpCore: '4.4.0',
    pptxgenjs: '4.0.1',
    startedAt: new Date().toISOString(),
  },
  harness: {},
  decks: {},
  checks: [],
  ok: false,
}

function log(...a) {
  console.log('[spike-editable]', ...a)
}

function check(name, ok, detail = '') {
  report.checks.push({ name, ok: !!ok, detail })
  if (!ok) console.warn('[check FAIL]', name, detail)
  return !!ok
}

// ---------------------------------------------------------------------------
// marp 渲染（与 web/src/marp/renderer.ts 的 sanitize 保持一致）
// ---------------------------------------------------------------------------
const EXTERNAL_IMPORT_RE = /@import\s+(?:url\(\s*)?(?:['"]?)https?:\/\/[^;]*;?/gi
const EXTERNAL_URL_RE = /url\(\s*(?:['"]?)https?:\/\/[^)]*\)/gi
const sanitizeCss = (css) => css.replace(EXTERNAL_IMPORT_RE, '').replace(EXTERNAL_URL_RE, 'none')
const sanitizeHtml = (html) => html.replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')

function renderDeck(mdPath, themePath) {
  const md = readFileSync(path.join(harnessDir, mdPath), 'utf8')
  const themeCss = readFileSync(path.join(harnessDir, themePath), 'utf8')
  // 与 web/src/marp/renderer.ts 的 Marp 选项保持一致（离线：emoji 不转 twemoji 图片）
  const marp = new Marp({
    html: true,
    script: false,
    minifyCSS: true,
    math: { lib: 'mathjax', katexFontPath: '/katex/fonts/' },
    emoji: { shortcode: true, unicode: false },
  })
  marp.themeSet.add(themeCss)
  const started = performance.now()
  const res = marp.render(md)
  const ms = performance.now() - started
  const html = sanitizeHtml(res.html)
  const css = sanitizeCss(res.css)
  const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(html)
  const width = vb ? Math.round(parseFloat(vb[1])) : 1280
  const height = vb ? Math.round(parseFloat(vb[2])) : 720
  const comments = res.comments.map((arr) => arr.join('\n').trim())
  return { html, css, comments, width, height, renderMs: ms, htmlBytes: html.length, cssBytes: css.length }
}

// ---------------------------------------------------------------------------
// HTTP server（harness 页 / 静态资源）
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
}
const staticMap = {
  '/measure': { file: path.join(harnessDir, 'measure.html') },
  '/capture': { file: path.join(harnessDir, 'capture.html') },
  '/harness.bundle.js': { file: path.join(outDir, 'harness.bundle.js') },
  '/marp-core.browser.js': { file: path.join(WEB, 'public', 'marp-core.browser.js') },
  '/mermaid.browser.js': { file: path.join(WEB, 'public', 'mermaid.browser.js') },
  '/pptxgen.bundle.js': { file: path.join(WEB, 'node_modules', 'pptxgenjs', 'dist', 'pptxgen.bundle.js') },
}

function startServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = (req.url || '/').split('?')[0]
      if (url === '/favicon.ico') {
        res.writeHead(204)
        res.end()
        return
      }
      const entry = staticMap[url]
      if (entry && existsSync(entry.file)) {
        const ext = path.extname(entry.file)
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' })
        res.end(readFileSync(entry.file))
        return
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(`not found: ${url}`)
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

// ---------------------------------------------------------------------------
// 构建 harness bundle
// ---------------------------------------------------------------------------
async function buildHarness() {
  const started = performance.now()
  const result = await esbuild({
    entryPoints: [path.join(harnessDir, 'entry.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome120'],
    outfile: path.join(outDir, 'harness.bundle.js'),
    write: true,
    minify: false,
    sourcemap: false,
    logLevel: 'warning',
  })
  const stats = result.metafile ? null : null
  void stats
  const bytes = readFileSync(path.join(outDir, 'harness.bundle.js')).length
  const ms = Math.round(performance.now() - started)
  report.harness = { buildMs: ms, bundleBytes: bytes, bundleKb: Math.round(bytes / 102.4) / 10 }
  log(`harness bundle: ${(bytes / 1024).toFixed(1)} KB, build ${ms}ms`)
}

// ---------------------------------------------------------------------------
// 截图（背景）
// ---------------------------------------------------------------------------
async function captureBackgrounds(page, deck, label, { screenshot = true } = {}) {
  await page.bringToFront()
  await page.goto(serverBase + '/capture', { waitUntil: 'load' })
  await page.waitForFunction('window.__ready === true', { timeout: 15000 })
  const started = performance.now()
  const info = await page.evaluate(
    ({ html, css, width, height }) => window.__setContent(html, css, width, height),
    { html: deck.backgroundHtml, css: deck.backgroundCss, width: deck.width, height: deck.height },
  )
  await page.evaluate(() => window.__settleFrames())
  const handles = await page.$$('svg[data-marpit-svg]')
  const images = []
  for (let i = 0; i < handles.length; i++) {
    const buf = await handles[i].screenshot({ type: 'png', captureBeyondViewport: true })
    const file = path.join(outDir, `${label}-bg-slide-${i + 1}.png`)
    writeFileSync(file, buf)
    const dims = await handles[i].boundingBox()
    images.push({ index: i, dataUrl: `data:image/png;base64,${buf.toString('base64')}`, bytes: buf.length, w: Math.round(dims?.width || 0), h: Math.round(dims?.height || 0), file: path.basename(file) })
  }
  const ms = Math.round(performance.now() - started)
  log(`背景截图: ${images.length} 页, ${ms}ms, 平均 ${(images.reduce((s, x) => s + x.bytes, 0) / Math.max(1, images.length) / 1024).toFixed(0)} KB/页`)
  return { images, ms, info, pageCount: handles.length }
}

/** 用原始（文字可见）CSS 截一张图，作为视觉对照 */
async function shotRenderedDeck(page, deck, label) {
  await page.bringToFront()
  await page.goto(serverBase + '/capture', { waitUntil: 'load' })
  await page.waitForFunction('window.__ready === true', { timeout: 15000 })
  await page.evaluate(
    ({ html, css, width, height }) => window.__setContent(html, css, width, height),
    { html: deck.html, css: deck.css, width: deck.width, height: deck.height },
  )
  await page.evaluate(() => window.__settleFrames())
  const handles = await page.$$('svg[data-marpit-svg]')
  if (!handles.length) return null
  const buf = await handles[0].screenshot({ type: 'png' })
  const file = path.join(outDir, `${label}-rendered-slide-1.png`)
  writeFileSync(file, buf)
  return path.basename(file)
}

// ---------------------------------------------------------------------------
// LibreOffice / PDF / python 校验
// ---------------------------------------------------------------------------
function runPythonVerify(pptxPath, expect, tag) {
  const expectFile = path.join(outDir, `${tag}-expect.json`)
  const reportFile = path.join(outDir, `${tag}-python-report.json`)
  writeFileSync(expectFile, JSON.stringify(expect, null, 2))
  const started = performance.now()
  const result = spawnSync(PYTHON, [path.join(here, 'verify_pptx.py'), pptxPath, expectFile, reportFile], {
    encoding: 'utf8',
    timeout: 120000,
  })
  const ms = Math.round(performance.now() - started)
  let pythonReport = null
  try {
    pythonReport = JSON.parse(readFileSync(reportFile, 'utf8'))
  } catch {
    pythonReport = null
  }
  if (result.status !== 0) {
    console.warn('[python verify] stdout:', result.stdout)
    console.warn('[python verify] stderr:', result.stderr)
  }
  return { status: result.status, ms, stdout: (result.stdout || '').trim(), stderr: (result.stderr || '').trim(), report: pythonReport }
}

async function libreOfficeConvert(pptxPath, tag, toPdf = true) {
  const targetDir = path.join(outDir, 'lo')
  mkdirSync(targetDir, { recursive: true })
  const profileDir = path.join(outDir, 'lo-profile')
  mkdirSync(profileDir, { recursive: true })
  const profileUrl = `file:///${profileDir.replace(/\\/g, '/')}`
  const conv = toPdf ? 'pdf' : 'png'
  const started = performance.now()
  const result = spawnSync(
    SOFFICE,
    ['--headless', `-env:UserInstallation=${profileUrl}`, '--convert-to', conv, '--outdir', targetDir, pptxPath],
    { encoding: 'utf8', timeout: 120000 },
  )
  const ms = Math.round(performance.now() - started)
  const base = path.basename(pptxPath).replace(/\.pptx$/i, '')
  const converted = path.join(targetDir, `${base}.${conv}`)
  const info = {
    toPdf,
    status: result.status,
    ms,
    stderr: (result.stderr || '').trim().slice(0, 800),
    file: existsSync(converted) ? converted : null,
    bytes: existsSync(converted) ? readFileSync(converted).length : null,
  }
  if (toPdf && info.file) {
    try {
      const pdf = await PDFDocument.load(readFileSync(info.file))
      info.pages = pdf.getPageCount()
    } catch (err) {
      info.pdfError = String(err)
    }
  }
  return info
}

// ---------------------------------------------------------------------------
// 单个 deck 的完整流程
// ---------------------------------------------------------------------------
async function runDeck(pageMeasure, pageCapture, spec) {
  const label = spec.label
  log(`\n===== deck: ${label} (${spec.md}) =====`)
  const rendered = renderDeck(spec.md, spec.theme)
  const renderedInfo = {
    slides: (rendered.html.match(/data-marpit-svg/g) || []).length,
    htmlBytes: rendered.htmlBytes,
    cssBytes: rendered.cssBytes,
    width: rendered.width,
    height: rendered.height,
    comments: rendered.comments,
    renderMs: Math.round(rendered.renderMs * 10) / 10,
  }
  log(`marp 渲染: ${renderedInfo.slides} 页 ${rendered.width}×${rendered.height}, html ${renderedInfo.htmlBytes}B, css ${renderedInfo.cssBytes}B, ${renderedInfo.renderMs}ms`)

  // 1) mermaid 渲染（模拟 EditView.renderForExport 的异步步骤）
  await pageMeasure.bringToFront()
  await pageMeasure.goto(serverBase + '/measure', { waitUntil: 'load' })
  await pageMeasure.waitForFunction('window.__MwbHarness && window.__MwbHarness.ready', { timeout: 20000 })
  const mermaidStarted = performance.now()
  const mermaid = await pageMeasure.evaluate((html) => window.__MwbHarness.renderMermaid(html), rendered.html)
  const mermaidMs = Math.round(performance.now() - mermaidStarted)
  if (!mermaid.changed) log('mermaid: 无 mermaid 代码块（跳过）')
  else log(`mermaid: 已渲染内联 SVG，${mermaidMs}ms，html ${rendered.html.length} → ${mermaid.html.length}B`)

  // 2) measure（真实 Chrome + 隐藏 iframe）
  const measurePayload = {
    html: mermaid.html,
    css: rendered.css,
    opts: {
      width: rendered.width,
      height: rendered.height,
      comments: rendered.comments,
      title: spec.title,
    },
  }
  const measureStarted = performance.now()
  const measureRes = await pageMeasure.evaluate(
    (payload) => window.__MwbHarness.measure(payload.html, payload.css, payload.opts),
    measurePayload,
  )
  const measureMs = Math.round(performance.now() - measureStarted)
  const deck = measureRes.deck
  writeFileSync(path.join(outDir, `${label}-measured-deck.json`), JSON.stringify(deck, null, 2))
  const measuredInfo = {
    ms: measureMs,
    pageCount: deck.pageCount,
    width: deck.width,
    height: deck.height,
    stats: deck.stats,
    backgroundHtmlBytes: deck.backgroundHtml.length,
    backgroundCssBytes: deck.backgroundCss.length,
    perPage: deck.layouts.map((layout, i) => ({
      page: i + 1,
      texts: layout.texts.length,
      tables: layout.tables.length,
      runs: layout.texts.reduce((s, t) => s + t.runs.length, 0),
      sampleTexts: layout.texts.slice(0, 6).map((t) => t.runs.map((r) => r.text).join('').slice(0, 60)),
    })),
    firstBlocks: deck.layouts[0]?.texts.slice(0, 6).map((t) => ({
      x: t.x,
      y: t.y,
      w: t.w,
      h: t.h,
      align: t.align,
      fontSize: t.fontSize,
      fontFace: t.fontFace,
      color: t.color,
      bullet: t.bullet,
      runs: t.runs.map((r) => ({ text: r.text.slice(0, 40), color: r.color, bold: r.bold, fontSize: r.fontSize })),
    })),
  }
  log(`measure: ${deck.pageCount} 页, stats=${JSON.stringify(deck.stats)}, ${measureMs}ms`)
  report.decks[label] = { rendered: renderedInfo, mermaid: { changed: mermaid.changed, ms: mermaidMs }, measured: measuredInfo }

  if (deck.pageCount !== renderedInfo.slides) {
    check(`${label}_measure_pageCount`, false, `measure ${deck.pageCount} 页 ≠ 渲染 ${renderedInfo.slides} 页`)
  } else {
    check(`${label}_measure_pageCount`, true, `${deck.pageCount} 页`)
  }
  check(`${label}_measure_texts`, deck.stats.textBlocks >= deck.pageCount, `textBlocks=${deck.stats.textBlocks}`)
  check(`${label}_measure_runs`, deck.stats.runs >= deck.stats.textBlocks, `runs=${deck.stats.runs}`)
  check(`${label}_measure_pageSize`, deck.width === rendered.width && deck.height === rendered.height, `${deck.width}×${deck.height}`)
  // 防御：不应把未渲染的图片指令（`![bg](...)`）当文本导出
  const literalImageText = deck.layouts.some((layout) =>
    layout.texts.some((block) => /^!\[[^\]]*\]\([^\n]*\)$/.test(block.runs.map((r) => r.text).join('').trim())),
  )
  check(`${label}_no_literal_image_text`, !literalImageText, literalImageText ? '发现未渲染的图片指令文本' : '无')

  // 3) 背景截图（模拟 /api/export/capture）
  const capture = await captureBackgrounds(pageCapture, deck, label)
  const renderedShot = await shotRenderedDeck(pageCapture, { html: mermaid.html, css: rendered.css, width: rendered.width, height: rendered.height }, label)
  report.decks[label].capture = { ms: capture.ms, info: capture.info, images: capture.images.map(({ dataUrl, ...rest }) => rest), renderedShot }
  check(`${label}_capture_count`, capture.images.length === deck.pageCount, `截图 ${capture.images.length} 张 / ${deck.pageCount} 页`)
  if (typeof spec.expect.figuresMin === 'number') {
    check(`${label}_capture_figures`, (capture.info?.figures || 0) >= spec.expect.figuresMin, `figure 数 ${capture.info?.figures || 0}`)
  }

  // 4) assemble
  await pageMeasure.bringToFront()
  const assemble = await pageMeasure.evaluate(
    ({ deckJson, backgrounds, opts }) => window.__MwbHarness.assemble(deckJson, backgrounds, opts),
    { deckJson: deck, backgrounds: capture.images.map((img) => img.dataUrl), opts: { title: spec.title, comments: rendered.comments } },
  )
  const pptxPath = path.join(outDir, `${label}-editable.pptx`)
  writeFileSync(pptxPath, Buffer.from(assemble.base64, 'base64'))
  const bytes = readFileSync(pptxPath).length
  report.decks[label].assemble = { ms: Math.round(assemble.ms), stats: assemble.stats, progressLog: assemble.progressLog, bytes }
  log(`assemble: ${(bytes / 1024 / 1024).toFixed(2)} MB, ${Math.round(assemble.ms)}ms, stats=${JSON.stringify(assemble.stats)}`)
  check(`${label}_assemble_bytes`, bytes > 10000, `${bytes} B`)
  check(`${label}_assemble_slides`, assemble.stats.slides === deck.pageCount, `${assemble.stats.slides} 页`)
  check(`${label}_assemble_tables`, assemble.stats.tables === deck.stats.tables, `tables=${assemble.stats.tables} / measured ${deck.stats.tables}`)

  // 5) python-pptx 校验
  const py = runPythonVerify(pptxPath, spec.expect, label)
  report.decks[label].python = py
  const pyOk = py.status === 0 && py.report && py.report.summary && py.report.summary.failed === 0
  check(`${label}_python_verify`, pyOk, pyOk ? `checks ${py.report.summary.passed}/${py.report.summary.checks}` : (py.stderr || '').slice(0, 300))
  log(`python-pptx: ${pyOk ? 'PASS' : 'FAIL'} ${JSON.stringify(py.report?.summary || {})} ${py.ms}ms`)

  // 6) LibreOffice → PDF 页数 + 首页 PNG（默认跳过，见 RUN_LIBREOFFICE 注释）
  if (!SKIP_LIBREOFFICE && existsSync(SOFFICE)) {
    const pdf = await libreOfficeConvert(pptxPath, label, true)
    const png = await libreOfficeConvert(pptxPath, label, false)
    report.decks[label].libreoffice = { pdf, png }
    if (pdf.file && pdf.pages) {
      check(`${label}_libreoffice_pdf_pages`, pdf.pages === deck.pageCount, `PDF ${pdf.pages} 页 / deck ${deck.pageCount} 页`)
      log(`LibreOffice: PDF ${pdf.pages} 页 ${(pdf.bytes / 1024).toFixed(0)} KB (${pdf.ms}ms)；PNG 首页 ${png.file ? 'OK' : '缺失'}`)
    } else {
      report.libreofficeNote = `LibreOffice PDF 转换未完成（status=${pdf.status}, ${pdf.ms}ms）：${(pdf.stderr || '超时/挂起').slice(0, 200)}`
      log(`[warn] ${report.libreofficeNote}`)
    }
    if (png.file) {
      const base = path.basename(pptxPath).replace(/\.pptx$/i, '')
      const target = path.join(outDir, `${label}-pptx-slide-1.png`)
      try {
        renameSync(png.file, target)
        png.file = target
      } catch {
        /* ignore */
      }
    }
  }
  return { deck, rendered, pptxPath, capture }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
const server = await startServer()
const serverBase = `http://127.0.0.1:${server.address().port}`
log('harness server:', serverBase)

await buildHarness()

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  protocolTimeout: 300000,
  args: [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--mute-audio',
  ],
  defaultViewport: { width: 1440, height: 1000, deviceScaleFactor: 1 },
})
const pageMeasure = await browser.newPage()
const pageCapture = await browser.newPage()
const pageErrors = []
for (const [name, page] of [
  ['measure', pageMeasure],
  ['capture', pageCapture],
]) {
  page.on('pageerror', (err) => pageErrors.push({ page: name, error: String(err).slice(0, 500) }))
  page.on('console', (msg) => {
    if (msg.type() === 'error') pageErrors.push({ page: name, console: msg.text().slice(0, 500) })
  })
}
await pageMeasure.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1, isMobile: false })
await pageCapture.setViewport({ width: 1280, height: 720, deviceScaleFactor: 2, isMobile: false })

const SPECS = [
  {
    label: '16x9',
    md: 'sample.md',
    theme: 'theme-test.css',
    title: '可编辑PPTX实测-16x9',
    expect: {
      pages: 5,
      widthIn: 1280 / 96,
      heightIn: 7.5,
      backgroundMinBytes: 10000,
      bgImageSize: [2560, 1440],
      figuresMin: 1,
      allTextContains: ['MarpWorkbench 可编辑 PPTX', 'pptxgenjs', '组件', 'Mermaid', '第一层子项'],
      slideTextContains: [
        ['MarpWorkbench 可编辑 PPTX', '把幻灯片变成 PowerPoint 里能改的文字'],
        ['功能列表', '文字可编辑', '样式保留', 'pptxgenjs', '第一层子项', '自定义颜色 span', 'English mixed'],
        ['Mermaid 图表', '图表整体保留在高清底图中'],
        ['代码块', 'PptxGenJS', 'defineLayout', 'veryLongUrl', 'slide.addText'],
        ['表格与背景图', '组件', '状态', '说明', '可编辑', '底图'],
      ],
      notesContains: [[], ['列表、加粗'], ['Mermaid 图表作为底图'], ['auto-scaling'], ['表格 + 背景图']],
      notesPagesMin: 4,
      tablesMin: 1,
      runFontPropsMin: 2,
    },
  },
]
if (!SKIP_4X3) {
  SPECS.push({
    label: '4x3',
    md: 'sample-4x3.md',
    theme: 'theme-4x3.css',
    title: '可编辑PPTX实测-4x3',
    expect: {
      pages: 2,
      widthIn: 10,
      heightIn: 7.5,
      backgroundMinBytes: 10000,
      bgImageSize: [1920, 1440],
      allTextContains: ['4:3 可编辑 PPTX', '10×7.5in'],
      slideTextContains: [['4:3 可编辑 PPTX', '960 × 720'], ['列表与表格', '4:3 版面同样支持', '尺寸', '10×7.5in']],
      notesContains: [['4:3 备注'], ['4:3 备注']],
      notesPagesMin: 2,
      tablesMin: 1,
      runFontPropsMin: 2,
    },
  })
}

try {
  for (const spec of SPECS) {
    await pageCapture.setViewport({
      width: spec.expect.bgImageSize ? spec.expect.bgImageSize[0] / 2 : 1280,
      height: spec.expect.bgImageSize ? spec.expect.bgImageSize[1] / 2 : 720,
      deviceScaleFactor: 2,
      isMobile: false,
    })
    await runDeck(pageMeasure, pageCapture, spec)
  }
} catch (err) {
  console.error('[spike-editable] 运行失败:', err)
  report.error = String(err?.stack || err)
  check('pipeline', false, String(err?.message || err))
} finally {
  report.pageErrors = pageErrors
  // favicon 404 / 外部资源被 CSP 拦截属测试页噪声，不算导出错误
  const meaningfulErrors = pageErrors.filter((e) => {
    const text = String(e.console || e.error || '')
    return !/favicon/i.test(text)
  })
  check('no_page_errors', meaningfulErrors.length === 0, JSON.stringify(meaningfulErrors).slice(0, 500))
  report.ok = report.checks.every((c) => c.ok)
  report.finishedAt = new Date().toISOString()
  writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2))
  writeFileSync(path.join(outDir, 'report.md'), buildMarkdownReport(report))
  await browser.close()
  server.close()
  log(`\n==== 结果: ${report.ok ? 'PASS' : 'FAIL'}，报告：spike/editable/out/report.json ====`)
  log(report.checks.map((c) => `${c.ok ? '✅' : '❌'} ${c.name} ${c.detail}`).join('\n'))
  process.exitCode = report.ok ? 0 : 1
}

function buildMarkdownReport(r) {
  const lines = [`# M4 可编辑 PPTX spike 实测报告`, '', `- 时间：${r.env.startedAt} → ${r.finishedAt}`, `- 结果：**${r.ok ? 'PASS' : 'FAIL'}**`, '']
  for (const [label, deck] of Object.entries(r.decks)) {
    lines.push(`## ${label}`, '')
    lines.push(`- marp 渲染：${deck.rendered.slides} 页 ${deck.rendered.width}×${deck.rendered.height}，html ${deck.rendered.htmlBytes}B / css ${deck.rendered.cssBytes}B，${deck.rendered.renderMs}ms`)
    lines.push(`- measure：${deck.measured.pageCount} 页，stats ${JSON.stringify(deck.measured.stats)}，${deck.measured.ms}ms`)
    lines.push(`- 背景截图：${deck.capture.images.length} 张，${deck.capture.ms}ms，平均 ${(deck.capture.images.reduce((s, x) => s + x.bytes, 0) / Math.max(1, deck.capture.images.length) / 1024).toFixed(0)} KB/页，尺寸 ${deck.capture.images.map((i) => `${i.w}×${i.h}`).join(', ')}`)
    if (deck.assemble) {
      lines.push(`- assemble：${deck.assemble.stats.slides} 页 / 文本框 ${deck.assemble.stats.textBlocks} / 表格 ${deck.assemble.stats.tables} / ${(deck.assemble.bytes / 1024 / 1024).toFixed(2)} MB，${deck.assemble.ms}ms`)
    }
    if (deck.python?.report) {
      const p = deck.python.report
      lines.push(`- python-pptx：${p.slides.length} 页，尺寸 ${p.sizeInches.width}×${p.sizeInches.height} in，表格 ${p.summary.tables}，含字体 run ${p.summary.runFontProps}，notes 页 ${p.summary.notesPages}，checks ${p.summary.passed}/${p.summary.checks}`)
    }
    if (deck.libreoffice?.pdf) {
      lines.push(`- LibreOffice：PDF ${deck.libreoffice.pdf.pages ?? '?'} 页 ${deck.libreoffice.pdf.bytes ?? '?'} B（${deck.libreoffice.pdf.ms}ms）`)
    }
    lines.push('')
  }
  lines.push('## checks', '')
  for (const c of r.checks) lines.push(`- ${c.ok ? '✅' : '❌'} **${c.name}** ${c.detail}`)
  if (r.pageErrors?.length) {
    lines.push('', '## 页面错误', '', '```json', JSON.stringify(r.pageErrors, null, 2), '```')
  }
  return `${lines.join('\n')}\n`
}

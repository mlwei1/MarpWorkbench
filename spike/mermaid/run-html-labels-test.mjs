// htmlLabels 选型实测：false（SVG <text>） vs true（foreignObject HTML 标签）
// 同一份 flowchart 分别渲染/打印成 PDF，比较：PDF 文本可提取性、矢量操作符、内嵌位图、体积、观感截图
// 用法：node spike/mermaid/run-html-labels-test.mjs
//
// 结论会写进 docs/dev/mermaid.md §6，并决定 web/src/mermaid/bundle.ts 的 MERMAID_INIT_CONFIG.htmlLabels。
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import { startServer } from './serve.mjs'
import { findChrome, runChromePrint } from './chrome-print.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..', '..')
const OUT = path.join(HERE, 'out')
const SHOTS = path.join(HERE, 'shots')
fs.mkdirSync(OUT, { recursive: true })
fs.mkdirSync(SHOTS, { recursive: true })

const requireFromPackaging = createRequire(pathToFileURL(path.join(REPO, 'spike', 'packaging', 'browser-print', 'verify.mjs')))
const pdfjs = await import(pathToFileURL(requireFromPackaging.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href)
const OPS = pdfjs.OPS
const pdfjsDir = path.dirname(requireFromPackaging.resolve('pdfjs-dist/legacy/build/pdf.mjs'))
const standardFontDataUrl = path.join(pdfjsDir, '..', '..', 'standard_fonts') + path.sep
const requireFromMarp = createRequire(pathToFileURL(path.join(REPO, 'spike', 'marp', 'package.json')))
const puppeteer = requireFromMarp('puppeteer-core')
const chromePath = findChrome()

const PRESS_LABELS = ['开始', '检查', '发布上线', '修复', '通过', '不通过']

function buildLabelPrintPage(svg) {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>labels</title>
<style>
@page { size: 1280px 720px; margin: 0; }
html, body { margin: 0; padding: 0; background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.slide { width: 1280px; height: 720px; box-sizing: border-box; padding: 70px; display: flex; align-items: center; justify-content: center; }
.slide > svg { display: block; max-width: 100%; max-height: 100%; width: auto; height: auto; }
</style></head>
<body><div class="slide">${svg}</div></body></html>`
}

async function analyzePdf(pdfPath) {
  const buf = fs.readFileSync(pdfPath)
  const raw = buf.toString('latin1')
  const embedded = []
  const imgRe = /\/Subtype\s*\/Image\s*\/Width\s+(\d+)\s*\/Height\s+(\d+)/g
  let im
  while ((im = imgRe.exec(raw))) embedded.push({ w: +im[1], h: +im[2] })
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf), useWorkerFetch: false, isEvalSupported: false, useSystemFonts: true, disableFontFace: true, standardFontDataUrl }).promise
  const page = await pdf.getPage(1)
  const [, , W, H] = page.view
  const tc = await page.getTextContent()
  const text = tc.items.map((it) => ('str' in it ? it.str : '')).join('')
  const ops = await page.getOperatorList()
  let constructPath = 0
  let images = 0
  for (let k = 0; k < ops.fnArray.length; k++) {
    const fn = ops.fnArray[k]
    if (fn === OPS.constructPath) constructPath++
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintJpegXObject) images++
  }
  await pdf.destroy()
  return {
    pdfPath: path.relative(REPO, pdfPath),
    bytes: buf.length,
    pageSize: { w: +W.toFixed(2), h: +H.toFixed(2) },
    pageCount: pdf.numPages,
    text,
    textItems: tc.items.filter((it) => 'str' in it && it.str.trim()).length,
    labelsFound: PRESS_LABELS.filter((l) => text.includes(l)),
    labelsMissing: PRESS_LABELS.filter((l) => !text.includes(l)),
    vector: { constructPath, images, totalOps: ops.fnArray.length },
    embeddedImages: embedded,
  }
}

const run = async () => {
  const report = { chrome: chromePath, checks: [], htmlLabels: {}, decision: '', shots: [] }
  const check = (name, ok, detail) => report.checks.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail).slice(0, 500) })

  // 1) 真实 Chrome 渲染两种模式
  const server = await startServer(0)
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--disable-gpu', '--no-first-run', '--no-default-browser-check', '--font-render-hinting=none'],
    defaultViewport: { width: 1500, height: 900, deviceScaleFactor: 1 },
  })
  let artifacts
  let pageResult
  try {
    const page = await browser.newPage()
    await page.goto(`${server.url}/page/labels.html`, { waitUntil: 'load', timeout: 120000 })
    await page.waitForFunction('window.__DONE__ === true', { timeout: 180000, polling: 200 })
    pageResult = await page.evaluate(() => window.__RESULT__)
    artifacts = await page.evaluate(() => window.__ARTIFACTS_B64__)
    report.htmlLabels = {
      off: { bytes: pageResult.sizes.offBytes, foreignObjects: pageResult.sizes.offForeignObjects, textElements: pageResult.sizes.offTextElements },
      on: { bytes: pageResult.sizes.onBytes, foreignObjects: pageResult.sizes.onForeignObjects, textElements: pageResult.sizes.onTextElements },
    }
    check('labels 页面渲染成功', !!pageResult.ok, JSON.stringify(pageResult.checks.filter((c) => !c.ok)))
    check('htmlLabels:false → 无 foreignObject', pageResult.sizes.offForeignObjects === 0, pageResult.sizes.offForeignObjects)
    check('htmlLabels:true → 有 foreignObject', pageResult.sizes.onForeignObjects > 0, pageResult.sizes.onForeignObjects)
    for (const mode of ['off', 'on']) {
      const el = await page.$(`#${mode} .canvas`)
      const file = path.join(SHOTS, `labels-${mode}.png`)
      await el.screenshot({ path: file })
      report.shots.push(path.relative(REPO, file))
    }
    await page.close()
  } finally {
    await browser.close()
  }

  // 2) 分别构打印页 + Chrome 打印
  const svgOff = Buffer.from(artifacts.off, 'base64').toString('utf8')
  const svgOn = Buffer.from(artifacts.on, 'base64').toString('utf8')
  report.print = {}
  for (const mode of ['off', 'on']) {
    const html = buildLabelPrintPage(mode === 'off' ? svgOff : svgOn)
    const htmlPath = path.join(OUT, `labels-${mode}.html`)
    fs.writeFileSync(htmlPath, html)
    const pdfPath = path.join(OUT, `labels-${mode}.pdf`)
    const r = await runChromePrint({ url: `${server.url}/out/labels-${mode}.html`, pdfPath, chromePath })
    const analysis = r.pdfExists ? await analyzePdf(pdfPath) : null
    report.print[mode] = { ...r, analysis }
    check(`htmlLabels:${mode} PDF 生成（1 页 960×540pt）`, !!analysis && analysis.pageCount === 1 && Math.abs(analysis.pageSize.w - 960) < 0.6 && Math.abs(analysis.pageSize.h - 540) < 0.6, JSON.stringify(analysis && analysis.pageSize))
    if (analysis) {
      check(`htmlLabels:${mode} 中文标签在 PDF 文本层可提取`, analysis.labelsMissing.length === 0, 'missing=' + analysis.labelsMissing.join(','))
      check(`htmlLabels:${mode} 主体为矢量路径`, analysis.vector.constructPath > 10, 'paths=' + analysis.vector.constructPath)
    }
  }
  server.server.close()

  // 3) 决策：两种在 Chrome 155 打印 PDF 里文本都可提取、主体都矢量（实测相当）。
  //    选 htmlLabels:false（契约 §1.2 默认建议）——理由：标签是 SVG <text>，完全不依赖 foreignObject，
  //    跨浏览器/PDF 后端更稳；标签仍有系统字体、可选中；代价是不支持 HTML/markdown 富文本标签。
  //    htmlLabels:true 作为备选（若将来用户需要 `**bold**` / HTML 标签），改 bundle.ts 一行即可。
  const off = report.print.off.analysis
  const on = report.print.on.analysis
  const offAll = off && off.labelsMissing.length === 0
  const onAll = on && on.labelsMissing.length === 0
  if (offAll) {
    report.decision =
      'htmlLabels:false —— SVG <text> 标签（无 foreignObject）；Chrome 155 打印 PDF 实测：标签 6/6 可提取为文本、主体矢量、体积相当。' +
      (onAll ? ' htmlLabels:true 同样通过（6/6 可提取），作为需要富文本标签时的备选。' : '')
  } else if (onAll) {
    report.decision = 'htmlLabels:true —— foreignObject 打印文本可提取（false 模式反而有缺字，需复查）'
  } else {
    report.decision = '两种模式 PDF 文本可提取性均有缺失，需进一步排查（默认 false）'
  }
  check('决策已给出', !!report.decision)
  report.ok = report.checks.every((c) => c.ok)
  const reportPath = path.join(OUT, 'labels-report.json')
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))

  console.log('\n===== mermaid htmlLabels 对比 =====')
  console.log(`svg bytes: off=${report.htmlLabels.off.bytes} on=${report.htmlLabels.on.bytes}`)
  for (const mode of ['off', 'on']) {
    const a = report.print[mode].analysis
    if (!a) { console.log(`  ${mode}: PDF 失败`); continue }
    console.log(`  ${mode}: pdf=${a.bytes} bytes, textItems=${a.textItems}, labelsFound=${a.labelsFound.length}/${PRESS_LABELS.length}, paths=${a.vector.constructPath}, images=${a.vector.images}, embeddedRaster=${a.embeddedImages.length}`)
    console.log(`       text="${a.text.slice(0, 100).replace(/\n/g, ' ')}"`)
  }
  console.log(`checks: ${report.checks.filter((c) => c.ok).length}/${report.checks.length}`)
  for (const c of report.checks) if (!c.ok) console.log(`  ✗ ${c.name} => ${c.detail}`)
  console.log(`decision: ${report.decision}`)
  console.log(`shots: ${report.shots.join(', ')}`)
  console.log(`report: ${path.relative(REPO, reportPath)}`)
  console.log(report.ok ? 'RESULT: PASS' : 'RESULT: FAIL')
  if (!report.ok) process.exitCode = 1
}

run().catch((err) => {
  console.error(err)
  process.exitCode = 1
})

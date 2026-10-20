// 打印背景抽查：把主题渲染结果按导出打印页规则打印成 PDF，检查页数/尺寸/字节（深色 & 渐变主题）
// 运行：node spike/themes/print-check.mjs
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const req = createRequire(join(root, 'spike', 'marp', 'package.json'))
const { PDFDocument } = req('pdf-lib')

const outDir = join(here, 'out')
mkdirSync(outDir, { recursive: true })
const chrome = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find(existsSync)

const printCss = `
@page { size: 1280px 720px; margin: 0; }
html, body { margin: 0; padding: 0; }
.marpit > svg { display: block; break-after: page; }
.marpit > svg:last-child { break-after: auto; }
* { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
`

const results = {}
for (const theme of ['gradient-vivid', 'tech-dark', 'business-blue', 'academic-white']) {
  const src = join(outDir, `${theme}.html`)
  if (!existsSync(src)) {
    results[theme] = { error: '源 HTML 不存在，请先跑 render-themes.mjs' }
    continue
  }
  const html = readFileSync(src, 'utf8')
    .replace('</head>', `<style>${printCss}</style></head>`)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
  const htmlPath = join(outDir, `print-${theme}.html`)
  writeFileSync(htmlPath, html)
  const pdfPath = join(outDir, `print-${theme}.pdf`)
  try {
    await new Promise((resolve, reject) => {
      const p = spawn(chrome, [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-pdf-header-footer',
        '--virtual-time-budget=6000',
        `--user-data-dir=${join(outDir, '.chrome-print-tmp')}`,
        `--print-to-pdf=${pdfPath}`,
        pathToFileURL(htmlPath).href,
      ])
      p.on('error', reject)
      p.on('exit', () => resolve())
    })
    // 轮询：文件存在且大小稳定
    let last = 0
    for (let i = 0; i < 40; i++) {
      const size = existsSync(pdfPath) ? statSync(pdfPath).size : 0
      if (size > 0 && size === last) break
      last = size
      await new Promise((r) => setTimeout(r, 300))
    }
    const bytes = statSync(pdfPath).size
    const doc = await PDFDocument.load(readFileSync(pdfPath))
    const pages = doc.getPages()
    results[theme] = {
      pdf: `spike/themes/out/print-${theme}.pdf`,
      bytes,
      pageCount: pages.length,
      sizePt: pages[0] ? [Math.round(pages[0].getWidth()), Math.round(pages[0].getHeight())] : null,
    }
  } catch (e) {
    results[theme] = { error: String(e?.message ?? e), pdf: pdfPath }
  }
}
writeFileSync(join(outDir, 'print-check.json'), JSON.stringify(results, null, 2))
console.log(JSON.stringify(results, null, 2))

/**
 * 诊断：内容密集页（长列表 + 长代码块）在「静态打印页」是否被裁切；
 * 内联 marp-core.browser.js + 调用 browser() 后是否恢复 auto-scaling。
 *
 * 复现：node scripts/diag-autoscaling-pdf.mjs
 * 产物：out/dense-without-helper.pdf / out/dense-with-helper.pdf + 页面 PNG + 文本提取对比
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { Marp } from '@marp-team/marp-core'
import { buildPage } from './print-page.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const REPO = path.resolve(ROOT, '..', '..')
const outDir = path.join(ROOT, 'out')

const theme = fs.readFileSync(path.join(REPO, 'themes', 'business-blue.css'), 'utf8')
const marp = new Marp({
  html: true,
  script: false,
  minifyCSS: true,
  math: { lib: 'mathjax' },
  emoji: { shortcode: true, unicode: false }
})
marp.themeSet.add(theme)

const lines = ['---', 'marp: true', 'theme: business-blue', 'paginate: true', 'size: 16:9', '---', '']
lines.push('# 内容密集页（auto-scaling 诊断）', '')
for (let i = 1; i <= 14; i++) lines.push(`- 列表项 ${i}：这是一段比较长的中文内容，用来测试超高内容是否会被裁切。`)
lines.push('')
lines.push('```js')
for (let i = 1; i <= 12; i++) lines.push(`const line${i} = ${i} // 代码行`)
lines.push('```')
lines.push('')
lines.push('（本页最后一行：如果被裁切，这里会消失）')
const markdown = lines.join('\n')
const r = marp.render(markdown)

const bundle = fs.readFileSync(path.join(REPO, 'web', 'dist', 'marp-core.browser.js'), 'utf8')
const variants = [
  { name: 'dense-without-helper', helperBundle: null },
  { name: 'dense-with-helper', helperBundle: bundle }
]

const results = []
for (const v of variants) {
  const htmlPath = path.join(outDir, `${v.name}.html`)
  const pdfPath = path.join(outDir, `${v.name}.pdf`)
  fs.writeFileSync(
    htmlPath,
    buildPage({
      html: r.html,
      css: r.css,
      title: v.name,
      width: 1280,
      height: 720,
      helperBundle: v.helperBundle || undefined
    })
  )
  const t0 = Date.now()
  const run = spawnSync(
    process.execPath,
    [path.join(__dirname, 'export-pdf.mjs'), '--browser=chrome', `--in=${htmlPath}`, `--out=${pdfPath}`],
    { encoding: 'utf8' }
  )
  const elapsed = Date.now() - t0
  let pdfInfo = null
  try {
    pdfInfo = JSON.parse(run.stdout)
  } catch {
    /* ignore */
  }
  results.push({ name: v.name, htmlBytes: fs.statSync(htmlPath).size, pdfBytes: fs.existsSync(pdfPath) ? fs.statSync(pdfPath).size : 0, elapsed, pdfOk: pdfInfo?.ok })
}
fs.writeFileSync(path.join(outDir, 'diag-autoscaling-report.json'), JSON.stringify(results, null, 2))
console.log(JSON.stringify(results, null, 2))

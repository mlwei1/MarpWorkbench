/**
 * 诊断 2：代码块 auto-scaling 是否必须（长代码块页），以及 helper 对正常 3 页 deck 的耗时影响。
 * 产物：out/fit-*.pdf / out/helper-3page.pdf / out/diag-fit-report.json
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
const bundle = fs.readFileSync(path.join(REPO, 'web', 'dist', 'marp-core.browser.js'), 'utf8')

function makeMarp(themeCss) {
  const marp = new Marp({
    html: true,
    script: false,
    minifyCSS: true,
    math: { lib: 'mathjax' },
    emoji: { shortcode: true, unicode: false }
  })
  marp.themeSet.add(themeCss)
  return marp
}

function printVariant(name, r, withHelper) {
  const htmlPath = path.join(outDir, `${name}.html`)
  const pdfPath = path.join(outDir, `${name}.pdf`)
  fs.writeFileSync(
    htmlPath,
    buildPage({
      html: r.html,
      css: r.css,
      title: name,
      width: 1280,
      height: 720,
      helperBundle: withHelper ? bundle : undefined
    })
  )
  const t0 = Date.now()
  const run = spawnSync(
    process.execPath,
    [path.join(__dirname, 'export-pdf.mjs'), '--browser=chrome', `--in=${htmlPath}`, `--out=${pdfPath}`],
    { encoding: 'utf8' }
  )
  let pdfInfo = null
  try {
    pdfInfo = JSON.parse(run.stdout)
  } catch {}
  return {
    name,
    withHelper,
    htmlBytes: fs.statSync(htmlPath).size,
    pdfBytes: fs.existsSync(pdfPath) ? fs.statSync(pdfPath).size : 0,
    chromeWallMs: Date.now() - t0,
    chromeReportedMs: pdfInfo?.ms,
    ok: pdfInfo?.ok
  }
}

const results = []
const theme = fs.readFileSync(path.join(REPO, 'themes', 'business-blue.css'), 'utf8')

// ---- 用例 A：长代码块（18 行）+ 短标题，验证 auto-scaling 是否避免裁切 ----
{
  const lines = ['---', 'marp: true', 'theme: business-blue', 'size: 16:9', '---', '', '# 长代码块', '', '```js']
  for (let i = 1; i <= 18; i++) lines.push(`const line${i} = ${i} // 代码行`)
  lines.push('```')
  const r = makeMarp(theme).render(lines.join('\n'))
  results.push(printVariant('fit-codeblock-no-helper', r, false))
  results.push(printVariant('fit-codeblock-helper', r, true))

  // 提取文本判断是否裁切
  for (const suffix of ['fit-codeblock-no-helper', 'fit-codeblock-helper']) {
    const f = path.join(outDir, suffix + '.pdf')
    if (!fs.existsSync(f)) continue
    const extract = spawnSync(
      process.execPath,
      [
        '-e',
        `import('pdfjs-dist/legacy/build/pdf.mjs').then(async ({getDocument})=>{const fs=await import('node:fs');const data=new Uint8Array(fs.readFileSync(${JSON.stringify(f)}));const doc=await getDocument({data,useWorkerFetch:false,disableFontFace:true}).promise;const p=await doc.getPage(1);const tc=await p.getTextContent();const t=tc.items.map(i=>i.str||'').join('');console.log(JSON.stringify({chars:t.length,line1:t.includes('line1'),line18:t.includes('line18'),tail:t.slice(-60)}))})`
      ],
      { encoding: 'utf8', cwd: ROOT }
    )
    try {
      results.push({ name: suffix + '.text', ...JSON.parse(extract.stdout) })
    } catch {
      results.push({ name: suffix + '.text', error: extract.stderr?.slice(0, 300) })
    }
  }
}

// ---- 用例 B：正常 3 页样例 deck，量 helper 的耗时代价 ----
{
  const sample = fs.readFileSync(path.join(ROOT, 'sample-deck.md'), 'utf8')
  const spikeTheme = fs.readFileSync(path.join(ROOT, 'themes', 'gradient-spike.css'), 'utf8')
  const r = makeMarp(spikeTheme).render(sample)
  results.push(printVariant('helper-3page-no-helper', r, false))
  results.push(printVariant('helper-3page-with-helper', r, true))
}

fs.writeFileSync(path.join(outDir, 'diag-fit-report.json'), JSON.stringify(results, null, 2))
console.log(JSON.stringify(results, null, 2))

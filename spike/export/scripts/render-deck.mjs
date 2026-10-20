/**
 * 用 marp-core 渲染样例 deck（模拟前端 render(): {html, css, comments}），
 * 并生成 print.html / capture.html（静态打印页，供 headless 打印与 CDP 截图）。
 *
 * 运行：node scripts/render-deck.mjs
 * 产物：out/render.json、out/print.html、out/capture.html
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Marp } from '@marp-team/marp-core'
import { buildPage, DEFAULT_WIDTH, DEFAULT_HEIGHT } from './print-page.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const outDir = path.join(ROOT, 'out')
fs.mkdirSync(outDir, { recursive: true })

const markdown = fs.readFileSync(path.join(ROOT, 'sample-deck.md'), 'utf8')
const themeCss = fs.readFileSync(path.join(ROOT, 'themes', 'gradient-spike.css'), 'utf8')

// 与前端 web/src/marp/renderer.ts 相同的 marp 配置（离线：mathjax / 无 twemoji CDN）
const marp = new Marp({
  html: true,
  script: false,
  minifyCSS: true,
  math: { lib: 'mathjax', katexFontPath: '/katex/fonts/' },
  emoji: { shortcode: true, unicode: false }
})
marp.themeSet.add(themeCss)

const result = marp.render(markdown)
const html = result.html
const css = result.css
const comments = result.comments.map((arr) => arr.join('\n').trim())
const slides = (html.match(/data-marpit-svg/g) || []).length
const viewBox = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(html)
const width = viewBox ? Math.round(parseFloat(viewBox[1])) : DEFAULT_WIDTH
const height = viewBox ? Math.round(parseFloat(viewBox[2])) : DEFAULT_HEIGHT

const render = {
  title: '导出管线实测(3页)',
  html,
  css,
  comments,
  width,
  height,
  slides,
  source: 'spike/export/sample-deck.md',
  theme: 'export-spike',
  renderMs: 0
}
fs.writeFileSync(path.join(outDir, 'render.json'), JSON.stringify(render, null, 2))
fs.writeFileSync(path.join(outDir, 'print.html'), buildPage({ ...render, title: render.title }))
fs.writeFileSync(
  path.join(outDir, 'capture.html'),
  buildPage({ ...render, title: render.title, readyMarker: true })
)

console.log(
  JSON.stringify(
    {
      slides,
      width,
      height,
      htmlBytes: Buffer.byteLength(html),
      cssBytes: Buffer.byteLength(css),
      comments: comments.map((c) => c.slice(0, 40)),
      files: ['out/render.json', 'out/print.html', 'out/capture.html']
    },
    null,
    2
  )
)

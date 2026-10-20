// marp-core 渲染实测：中文/代码/公式/备注/分页/主题
import { Marp } from '@marp-team/marp-core'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'

const md = readFileSync(new URL('../samples/sample.md', import.meta.url), 'utf8')
mkdirSync(new URL('../out/', import.meta.url), { recursive: true })
const outDir = new URL('../out/', import.meta.url)

const count = (s, re) => (s.match(re) || []).length
const report = { env: { node: process.version }, render: {}, checks: {}, themes: {}, customTheme: {} }

// ---- 1) 基础渲染（含 math: katex、备注、transition）----
const marp = new Marp()
let t = performance.now()
const first = marp.render(md)
report.render.coldRenderMs = +(performance.now() - t).toFixed(1)
t = performance.now()
const result = marp.render(md)
report.render.warmRenderMs = +(performance.now() - t).toFixed(1)

report.render.htmlBytes = Buffer.byteLength(result.html)
report.render.cssBytes = Buffer.byteLength(result.css)
report.render.slideCount = count(result.html, /<svg[^>]*data-marpit-svg/g)
report.render.sectionCount = count(result.html, /<section/g)
report.render.commentsPerSlide = result.comments.map((c) => c.length)
report.render.notesText = result.comments.map((c) => c.join(' | '))
report.render.hasKatexMarkup = /class="katex/.test(result.html)
report.render.hasKatexFontRef = /KaTeX_/.test(result.css)
report.render.hasChinese = /中文段落/.test(result.html)
report.render.hasInlineScript = /<script/.test(result.html)
report.render.inlineScriptBytes = count(result.html, /<script[^>]*>/g)
report.render.hasTransitionAttr = /data-transition="fade"/.test(result.html)
report.render.hasPaginate = /paginate/.test(result.html)
report.render.htmlHead = result.html.slice(0, 300)

// 分页/过渡由 front-matter 决定：列出 data-* 属性
report.render.slideAttrs = [...result.html.matchAll(/<section([^>]*)>/g)].map((m) =>
  m[1].replace(/\s+/g, ' ').trim().slice(0, 200),
)

// notes 提取（Marpit: comments[i] 即第 i 页备注数组）
report.render.notesLengths = result.comments.map((c) => c.join('\n').length)

// ---- 2) 内置主题 ----
for (const theme of ['default', 'gaia', 'uncover']) {
  const m = new Marp()
  const r = m.render(`---\ntheme: ${theme}\n---\n# 主题 ${theme}\n\n## 副标题\n\n- 要点`)
  const t0 = performance.now()
  const r2 = m.render(`---\ntheme: ${theme}\n---\n# 主题 ${theme}\n\n## 副标题`)
  report.themes[theme] = {
    cssBytes: Buffer.byteLength(r2.css),
    htmlBytes: Buffer.byteLength(r2.html),
    renderMs: +(performance.now() - t0).toFixed(1),
    sectionClass: (r.html.match(/class="([^"]*)"/) || [])[1],
    firstRule: r.css.slice(0, 160),
  }
}

// ---- 3) ThemeSet / 自定义主题 ----
const custom = `/*
 * @theme custom-spike
 * @size 4:3 960px 720px
 * @auto-scaling true
 */
@import 'default';

section {
  background: #0b1f33;
  color: #e6f1ff;
  font-family: 'Microsoft YaHei', sans-serif;
}
`
const m2 = new Marp()
const addedTheme = m2.themeSet.add(custom)
report.customTheme.themeName = addedTheme.name
report.customTheme.parsedMeta = { ...addedTheme.meta }
report.customTheme.widthHeight = [addedTheme.width, addedTheme.height]
report.customTheme.sizePx = [addedTheme.widthPixel, addedTheme.heightPixel]
report.customTheme.importRules = addedTheme.importRules.map((r) => r.value)

const r3 = m2.render(`---\ntheme: custom-spike\n---\n# 自定义主题\n\n中文测试`)
report.customTheme.render = {
  htmlBytes: Buffer.byteLength(r3.html),
  cssBytes: Buffer.byteLength(r3.css),
  hasCustomBg: /#0b1f33/i.test(r3.css),
  hasMicrosoftYaHei: /Microsoft YaHei/i.test(r3.css),
  hasImportResolved: !/@import/.test(r3.css),
  hasDefaultThemeRules: /--color-background|font-family/.test(r3.css),
  cssStart: r3.css.slice(0, 200),
}

// 主题集合枚举（用于主题画廊读取元信息）
report.customTheme.themeSetSize = m2.themeSet.size
report.customTheme.themes = [...m2.themeSet.themes()].map((th) => ({
  name: th.name,
  width: th.width,
  height: th.height,
  widthPixel: th.widthPixel,
  heightPixel: th.heightPixel,
  meta: { ...th.meta },
}))

// 多主题并存：同一实例注册两个自定义主题，分别渲染
const m3 = new Marp()
m3.themeSet.add(`/* @theme theme-a */\nsection { background: #111; }`)
m3.themeSet.add(`/* @theme theme-b */\nsection { background: #eee; }`)
const ra = m3.render(`---\ntheme: theme-a\n---\n# A`)
const rb = m3.render(`---\ntheme: theme-b\n---\n# B`)
report.customTheme.multiTheme = {
  themeSetSize: m3.themeSet.size,
  cssBytesA: Buffer.byteLength(ra.css),
  cssBytesB: Buffer.byteLength(rb.css),
  cssAHas111: /#111/.test(ra.css),
  cssBHasEee: /#eee/.test(rb.css),
  cssAContainsB: /#eee/.test(ra.css),
}

// ---- 4) 生成完整 HTML（供 Chrome headless print-to-pdf / 截图）----
const fullHtml = (r, themeName) => `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>marp spike ${themeName}</title>
<style>
html, body { margin: 0; padding: 0; background: #fff; }
${r.css}
</style>
${r.html.includes('<script') ? '' : ''}
</head>
<body>${r.html}</body>
</html>`

const m4 = new Marp()
const rDef = m4.render(readFileSync(new URL('../samples/sample.md', import.meta.url), 'utf8'))
writeFileSync(new URL('sample-default.html', outDir), fullHtml(rDef, 'default'))
const rGaia = new Marp().render(
  readFileSync(new URL('../samples/sample.md', import.meta.url), 'utf8').replace('theme: default', 'theme: gaia'),
)
writeFileSync(new URL('sample-gaia.html', outDir), fullHtml(rGaia, 'gaia'))
report.render.exportedHtmlBytes = {
  default: Buffer.byteLength(fullHtml(rDef, 'default')),
  gaia: Buffer.byteLength(fullHtml(rGaia, 'gaia')),
}

// ---- 5) html:true / html:false / math mathjax ----
const htmlTestMd = '<div class="x">raw <b>HTML</b></div>'
const safe = new Marp().render(htmlTestMd).html
const unsafe = new Marp({ html: true }).render(htmlTestMd).html
const mathjax = new Marp({ math: 'mathjax' }).render('$$ a^2 + b^2 = c^2 $$')
report.checks.htmlAllowlist = {
  defaultAllowsBold: /<b>/.test(safe),
  htmlTrueAllowsDiv: /<div class="x">/.test(unsafe),
  mathjaxRendered: /mjx-container|MathJax/.test(mathjax.html),
  mathjaxCssBytes: Buffer.byteLength(mathjax.css),
}

writeFileSync(new URL('render-report.json', outDir), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))

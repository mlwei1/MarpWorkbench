// 诊断：marp.render() 是否输出 auto-scaling 自定义元素；主题 @auto-scaling 情况。
// 运行：node scripts/diag-autoscaling.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Marp } from '@marp-team/marp-core'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const REPO = path.resolve(ROOT, '..', '..')

const themePath = path.join(REPO, 'themes', 'business-blue.css')
const theme = fs.readFileSync(themePath, 'utf8')

const marp = new Marp({
  html: true,
  script: false,
  minifyCSS: true,
  math: { lib: 'mathjax' },
  emoji: { shortcode: true, unicode: false }
})
marp.themeSet.add(theme)

const lines = []
lines.push('---', 'marp: true', 'theme: business-blue', 'paginate: true', 'size: 16:9', '---', '')
lines.push('# 很长的内容页', '')
for (let i = 1; i <= 14; i++) lines.push(`- 列表项 ${i}：这是一段比较长的中文内容，用来测试超高内容是否会被裁切。`)
lines.push('')
lines.push('```js')
for (let i = 1; i <= 12; i++) lines.push(`const line${i} = ${i} // 代码行`)
lines.push('```')

const dense = lines.join('\n')
const r = marp.render(dense)
const html = r.html
console.log('slides:', (html.match(/data-marpit-svg/g) || []).length)
console.log('html bytes:', html.length)
for (const k of ['marp-auto-scaling', 'data-marpit-auto-scaling', 'marp-fitting-header', 'auto-scaling']) {
  console.log(' contains', k, '=>', html.includes(k))
}
const metaMatch = theme.match(/@auto-scaling[^\n]*/)
console.log('theme @auto-scaling:', metaMatch ? metaMatch[0] : '(none)')

// 同时测试默认主题（export-spike 渐变主题无 auto-scaling）
const spikeTheme = fs.readFileSync(path.join(ROOT, 'themes', 'gradient-spike.css'), 'utf8')
const m2 = new Marp({ html: true, script: false, math: { lib: 'mathjax' }, emoji: { shortcode: true, unicode: false } })
m2.themeSet.add(spikeTheme)
const r2 = m2.render(dense.replace('business-blue', 'export-spike'))
console.log('spike theme html has marp-auto-scaling:', r2.html.includes('marp-auto-scaling'))
fs.writeFileSync(path.join(ROOT, 'out', 'diag-dense-business-blue.html'), r.html)
fs.writeFileSync(path.join(ROOT, 'out', 'diag-dense-export-spike.html'), r2.html)
console.log('wrote out/diag-dense-*.html')

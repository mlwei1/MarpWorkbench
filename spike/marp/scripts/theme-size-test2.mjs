// 最终确认：size 指令 → SVG viewBox；主题 width/height 元数据
import { Marp } from '@marp-team/marp-core'
import { readFileSync } from 'node:fs'

const custom = readFileSync(new URL('../themes/custom-spike.css', import.meta.url), 'utf8')
const viewBox = (r) => (r.html.match(/viewBox="([^"]+)"/) || [])[1]
const out = {}

const marp = new Marp()
for (const [name, md] of Object.entries({
  default: '---\ntheme: default\n---\n# A',
  default43: '---\ntheme: default\nsize: 4:3\n---\n# A',
  gaia: '---\ntheme: gaia\n---\n# A',
  gaia43: '---\ntheme: gaia\nsize: 4:3\n---\n# A',
})) {
  out[name] = { viewBox: viewBox(marp.render(md)) }
}
out.builtinThemes = [...marp.themeSet.themes()].map((t) => ({
  name: t.name,
  width: t.width,
  height: t.height,
  widthPixel: t.widthPixel,
  heightPixel: t.heightPixel,
  meta: t.meta,
}))

const m2 = new Marp()
m2.themeSet.add(custom)
const th = [...m2.themeSet.themes()].find((t) => t.name === 'company-cn')
out.companyCn = { width: th.width, height: th.height, widthPixel: th.widthPixel, heightPixel: th.heightPixel, meta: th.meta }
out.companyCnRender = {
  normal: viewBox(m2.render('---\ntheme: company-cn\n---\n# A')),
  size43: viewBox(m2.render('---\ntheme: company-cn\nsize: 4:3\n---\n# A')),
}
// 主题名解析：CSS 注释 meta
out.reservedCheck = { themeNameFromMeta: th.name, importRules: th.importRules.map((r) => r.value) }
console.log(JSON.stringify(out, null, 2))

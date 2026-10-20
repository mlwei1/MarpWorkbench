// 自定义主题 @size 与 size 指令实测
import { Marp } from '@marp-team/marp-core'
import { readFileSync } from 'node:fs'

const custom = readFileSync(new URL('../themes/custom-spike.css', import.meta.url), 'utf8')
const marp = new Marp()
marp.themeSet.add(custom)
const r = {}
r.themeMeta = [...marp.themeSet.themes()].find((t) => t.name === 'company-cn').meta
r.noSizeDirective = marp.render('---\ntheme: company-cn\n---\n# A').css.match(/section\{width:(\d+)px;height:(\d+)px/)?.[0]
r.withSize43 = marp.render('---\ntheme: company-cn\nsize: 4:3\n---\n# A').css.match(/section\{width:(\d+)px;height:(\d+)px/)?.[0]
r.withSize169 = marp.render('---\ntheme: company-cn\nsize: 16:9\n---\n# A').css.match(/section\{width:(\d+)px;height:(\d+)px/)?.[0]
r.builtinDefault = new Marp().render('---\ntheme: default\n---\n# A').css.match(/section\{width:(\d+)px;height:(\d+)px/)?.[0]
r.builtin43 = new Marp().render('---\ntheme: default\nsize: 4:3\n---\n# A').css.match(/section\{width:(\d+)px;height:(\d+)px/)?.[0]
// 只有 @size 4:3、不 import default 的最小自定义主题
const minimal = `/* @theme only43 */\n@size 4:3 960px 720px;\nsection { background: #123; color: #fff; }`
const m2 = new Marp()
const t = m2.themeSet.add(minimal)
r.minimalThemeMeta = t.meta
r.minimalThemeWH = [t.width, t.height, t.widthPixel, t.heightPixel]
r.minimalRender = m2.render('---\ntheme: only43\n---\n# B').css.match(/section\{width:(\d+)px;height:(\d+)px/)?.[0]
console.log(JSON.stringify(r, null, 2))

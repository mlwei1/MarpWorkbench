// 探针：确认 Marp/Marpit 主题注释元信息解析规则、默认主题关键 CSS、hljs 类名
// 运行：node spike/themes/_probe.mjs
import { createRequire } from 'node:module'
const require = createRequire(new URL('../marp/package.json', import.meta.url))
const { Marp } = require('@marp-team/marp-core')

const variantA = `/* @theme probe-a */
/* @import 'default'; */
/* @name 探针甲 */
/* @tags 测试,甲 */
/* @size 16:9 1280px 720px */
/* @auto-scaling false */

section { background: #fafafa; }
`
const variantB = `/*
 * @theme probe-b
 * @name 探针乙
 * @tags 测试,乙
 * @size 4:3 960px 720px
 * @auto-scaling true
 */
@import 'default';

section { background: #fafafa; }
`

const marp = new Marp()
for (const [label, css] of [['A(分行注释)', variantA], ['B(单块注释)', variantB]]) {
  try {
    const added = marp.themeSet.add(css)
    console.log(label, {
      name: added.name,
      meta: { ...added.meta },
      width: added.width,
      height: added.height,
      widthPixel: added.widthPixel,
      heightPixel: added.heightPixel,
      importRules: added.importRules.map((r) => r.value),
    })
  } catch (e) {
    console.log(label, 'ERROR', e.message)
  }
}

// 渲染默认主题看关键 CSS
const m = new Marp()
const r = m.render(`---\ntheme: default\npaginate: true\nheader: '页眉'\nfooter: '页脚'\n---\n# 标题\n\n正文 \`inline\`\n\n\`\`\`js\nconst a = 1\n\`\`\`\n\n> 引用\n\n| a | b |\n| - | - |\n| 1 | 2 |\n`)
const probe = (label, re) => {
  const m2 = r.css.match(re)
  console.log(`\n## ${label} (${m2 ? m2.length : 0})`)
  if (m2) console.log(m2.slice(0, 6).join('\n---\n').slice(0, 2500))
}
probe('section::after', /section::after[^{]*\{[^}]*\}/g)
probe('header/footer', /section\s*>\s*(header|footer)[^{]*\{[^}]*\}/g)
probe('pre', /(^|\n)\s*pre[^{]*\{[^}]*\}/g)
probe('hljs', /\.hljs[^{]*\{[^}]*\}/g)
probe('table', /(^|\n)\s*(table|thead|td|th)[^{]*\{[^}]*\}/g)
console.log('\nhtml snippet:', r.html.slice(0, 400))

/**
 * 诊断：M2 插入器生成的 Marp 图片/表格语法是否被 marp-core 4.4.0 正确解析。
 * 用法：node scripts/diag-image-syntax.mjs
 */
import { Marp } from '@marp-team/marp-core'

const marp = new Marp({
  html: true,
  script: false,
  math: { lib: 'mathjax' },
  emoji: { shortcode: true, unicode: false }
})

const cases = {
  '普通图片 w:50%': '# 标题\n\n![w:50%](assets/photo.png)\n',
  '普通图片 原图': '# 标题\n\n![].png)(assets/photo.png)\n'.replace('![].png)', '!'),
  '背景 整页 cover 默认': '![bg](assets/photo.png)\n\n# 标题\n',
  '背景 left:40% + opacity': '![bg left:40% opacity:.5](assets/photo.png)\n\n# 标题\n',
  '背景 right:30% + contain': '![bg right:30% contain](assets/photo.png)\n\n# 标题\n',
  '背景 fit': '![bg fit](assets/photo.png)\n\n# 标题\n',
  '背景 高级 blur+grayscale': '![bg left:40% opacity:.5 blur:5px grayscale](assets/photo.png)\n\n# 标题\n',
  '普通图 blur 滤镜': '![w:50% blur:5px](assets/photo.png)\n',
  '表格 对齐+首列加粗': '| **表头1** | 表头2 | 表头3 |\n| :--- | :---: | ---: |\n| **内容 1** | 内容 2 | 内容 3 |\n'
}

const report = {}
for (const [name, md] of Object.entries(cases)) {
  const r = marp.render(md)
  const html = r.html
  const section = /<section[^>]*>/.exec(html)?.[0] || ''
  const imgs = [...html.matchAll(/<img[^>]*>/g)].map((m) => m[0])
  report[name] = {
    sectionAttrs: section.replace(/\s+/g, ' ').slice(0, 400),
    imgs: imgs.map((s) => s.slice(0, 240)),
    hasTable: html.includes('<table>'),
    tableAlign: [...html.matchAll(/<t[hd][^>]*style="[^"]*"/g)].map((m) => m[0]).slice(0, 4)
  }
}
console.log(JSON.stringify(report, null, 2))

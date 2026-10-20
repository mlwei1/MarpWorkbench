/**
 * frontmatter.ts 自测（无测试框架，断言 + 退出码）
 * 运行：node --experimental-strip-types web/scripts/test-frontmatter.ts
 */
import {
  findImageDirectives,
  getFrontMatterData,
  getPageBackground,
  getSlideDirective,
  insertAtPageStart,
  pageStartLine,
  replaceImageDirective,
  setFrontMatterField,
  setSlideDirective,
} from '../src/marp/frontmatter.ts'

let failed = 0
function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    console.log(`✅ ${name}`)
  } else {
    failed++
    console.log(`❌ ${name}\n   actual:   ${a}\n   expected: ${e}`)
  }
}
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`✅ ${name}`)
  else {
    failed++
    console.log(`❌ ${name} — ${detail}`)
  }
}

const base = `---
marp: true
theme: business-blue
# 这是一条注释，必须保留
paginate: true
header: "旧页眉"
custom: keep-me
---

<!-- _class: lead -->

# 第一页

内容

---

## 第二页

- a
- b

---

## 第三页
`

// ---- front-matter 通用读写 ----
const data = getFrontMatterData(base)
eq('读取 front-matter 字段', data.theme, 'business-blue')
eq('读取保留自定义字段', data.custom, 'keep-me')

const setSize = setFrontMatterField(base, 'size', '4:3')
ok('设置新字段 size', setSize.includes('size: 4:3'))
ok('保留未知字段 custom', setSize.includes('custom: keep-me'))
ok('保留注释', setSize.includes('# 这是一条注释，必须保留'))
ok('保留字段顺序（theme 在 paginate 前）', setSize.indexOf('theme:') < setSize.indexOf('paginate:'))
eq('设置后仍可读回', getFrontMatterData(setSize).size, '4:3')

const changedTheme = setFrontMatterField(base, 'theme', 'tech-dark')
eq('修改已有字段', getFrontMatterData(changedTheme).theme, 'tech-dark')
ok('只改目标行（其它行不变）', changedTheme.replace('theme: tech-dark', 'theme: business-blue') === base)

const removed = setFrontMatterField(base, 'header', null)
ok('删除字段', !removed.includes('header:'))
eq('删除后读回 null', getFrontMatterData(removed).header, undefined)
ok('删除不破坏其它字段', removed.includes('theme: business-blue') && removed.includes('custom: keep-me'))

const quoteHeader = setFrontMatterField(base, 'header', '2024 年度：总结')
eq('含冒号值自动加引号并可读回', getFrontMatterData(quoteHeader).header, '2024 年度：总结')

const multiline = setFrontMatterField(base, 'footer', '第一行\n第二行')
ok('换行值被合并为单行（禁止非法 YAML）', !getFrontMatterData(multiline).footer?.includes('\n'))

const noFm = setFrontMatterField('# 标题\n\n内容', 'header', '页眉')
ok('无 front-matter 时自动补 marp: true', noFm.startsWith('---\nmarp: true'))
eq('自动补后 header 可读', getFrontMatterData(noFm).header, '页眉')

// ---- 页起始行 / 分页 ----
const lineOf = (md: string, marker: string): number => md.split('\n').findIndex((l) => l.includes(marker)) + 1
eq('pageStartLine(1) 指向第一页首个非空行（指令行）', pageStartLine(base, 1), lineOf(base, '<!-- _class: lead -->'))
eq('pageStartLine(2) 指向第二页首行', pageStartLine(base, 2), lineOf(base, '## 第二页'))
eq('pageStartLine(3) 指向第三页首行', pageStartLine(base, 3), lineOf(base, '## 第三页'))
eq('pageStartLine 不指向空白行', base.split('\n')[pageStartLine(base, 2) - 1].trim() !== '', true)

// ---- 页内指令 ----
eq('读取第 1 页 _class', getSlideDirective(base, 1, 'class'), 'lead')
eq('读取不存在的指令', getSlideDirective(base, 2, 'class'), null)

const p2class = setSlideDirective(base, 2, 'class', 'invert')
ok('第 2 页新增 _class 指令', p2class.includes('<!-- _class: invert -->'))
eq('新增后可读回', getSlideDirective(p2class, 2, 'class'), 'invert')
ok('原有第 1 页指令不受影响', getSlideDirective(p2class, 1, 'class') === 'lead')

const p1paginate = setSlideDirective(base, 1, 'paginate', 'false')
eq('新增 _paginate', getSlideDirective(p1paginate, 1, 'paginate'), 'false')
const p1paginateRemoved = setSlideDirective(p1paginate, 1, 'paginate', null)
eq('删除 _paginate', getSlideDirective(p1paginateRemoved, 1, 'paginate'), null)
eq('删除后第 1 页 class 仍在', getSlideDirective(p1paginateRemoved, 1, 'class'), 'lead')

const p1classRemoved = setSlideDirective(base, 1, 'class', null)
eq('删除第 1 页 _class', getSlideDirective(p1classRemoved, 1, 'class'), null)
ok('删除指令后无连续空行', !p1classRemoved.includes('\n\n\n'))

// 多行指令块
const multiDirective = `---
marp: true
theme: default
---

<!--
_class: lead
_paginate: false
-->

# 标题
`
eq('多行注释读取 _class', getSlideDirective(multiDirective, 1, 'class'), 'lead')
eq('多行注释读取 _paginate', getSlideDirective(multiDirective, 1, 'paginate'), 'false')
const multiChanged = setSlideDirective(multiDirective, 1, 'paginate', 'true')
eq('多行注释修改 _paginate', getSlideDirective(multiChanged, 1, 'paginate'), 'true')
eq('多行注释其它指令保留', getSlideDirective(multiChanged, 1, 'class'), 'lead')
const multiRemoved = setSlideDirective(multiDirective, 1, 'class', null)
eq('多行注释删除一个指令', getSlideDirective(multiRemoved, 1, 'class'), null)
eq('多行注释删除后其它保留', getSlideDirective(multiRemoved, 1, 'paginate'), 'false')

// ---- 页首插入 ----
const bgSnippet = '![bg left:40% opacity:.5](assets/a.png)'
const p2Insert = insertAtPageStart(base, 2, bgSnippet)
const p2Lines = p2Insert.split('\n')
ok('insertAtPageStart(2) 插入背景图', p2Insert.includes(bgSnippet))
const bgIdx = p2Lines.findIndex((l) => l.includes('![bg left:40%'))
ok('背景图位于第 2 页（在 --- 之后）', bgIdx > p2Lines.indexOf('---'), `bgIdx=${bgIdx}`)
ok('背景图后有内容', p2Lines[bgIdx + 1].trim() === '' || p2Lines[bgIdx + 1].includes('##'))

const p1Insert = insertAtPageStart(base, 1, bgSnippet)
ok('insertAtPageStart(1) 插入背景图', p1Insert.includes(bgSnippet))
ok('第 1 页插入后 _class 指令仍在', getSlideDirective(p1Insert, 1, 'class') === 'lead')

// ---- 图片指令 ----
const imageMd = `---
marp: true
theme: default
---

![w:50%](assets/photo.png)

---

![bg left:40% opacity:.5](assets/bg.png)

![bg](assets/bg2.jpg)

---

![]()
`
const imgs = findImageDirectives(imageMd)
eq('图片指令数量', imgs.length, 3)
eq('图片 1 修饰符', imgs[0].modifiers, ['w:50%'])
eq('图片 1 页', imgs[0].page, 1)
eq('图片 2 修饰符', imgs[1].modifiers, ['bg', 'left:40%', 'opacity:.5'])
eq('图片 2 页', imgs[1].page, 2)
eq('图片 2 路径', imgs[1].path, 'assets/bg.png')
eq('图片 3 页', imgs[2].page, 2)
eq('当前页背景图', getPageBackground(imageMd, 2)?.path, 'assets/bg2.jpg')
eq('第 1 页无背景图', getPageBackground(imageMd, 1), null)

const replaced = replaceImageDirective(imageMd, imgs[1].offset, '![bg left:50% opacity:.3](assets/bg.png)')
ok('替换背景图指令', replaced.includes('![bg left:50% opacity:.3](assets/bg.png)'))
ok('替换后其它图片保留', replaced.includes('![w:50%](assets/photo.png)') && replaced.includes('![bg](assets/bg2.jpg)'))

const removedBg = replaceImageDirective(imageMd, imgs[1].offset, null)
ok('删除背景图指令', !removedBg.includes('bg left:40%'))
ok('删除后其它行保留', removedBg.includes('![bg](assets/bg2.jpg)') && removedBg.includes('![w:50%](assets/photo.png)'))

// ---- 代码围栏中的 --- 不应被当分页 ----
const fenced = `---
marp: true
theme: default
---

\`\`\`md
---
不是分页
---
\`\`\`

---

# 真正的第二页
`
eq('代码围栏内 --- 不算分页', pageStartLine(fenced, 2), lineOf(fenced, '# 真正的第二页'))

console.log('')
if (failed > 0) {
  console.log(`❌ ${failed} 项失败`)
  process.exit(1)
} else {
  console.log('✅ 全部通过')
}

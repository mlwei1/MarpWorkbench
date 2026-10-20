---
marp: true
theme: business-blue
paginate: true
header: 'MarpWorkbench · 主题视觉验收'
footer: 'sample-deck.md'
---

<!-- _class: lead -->

# 用 Markdown 做一份好看的幻灯片

## 6 套内置主题 · 真实 marp-core 渲染验收

### MarpWorkbench 2026

---

## 中文排版与行内元素

这是一段中文正文，用于检查字重、行高与换行：**加粗强调**、*斜体强调*、行内代码 `marp.render(md)` 与 [链接样式](#)。

### 三级标题：为什么主题很重要

- 列表项一：主题应该点一下就能换
- 列表项二：预览和导出必须长得一样
- 列表项三：中文不能变成方块或衬线错配

> 引用块：好的主题让内容自己说话，而不是让作者去调 CSS。

---

## 代码块配色

```js
import { Marp } from '@marp-team/marp-core'

const marp = new Marp({ html: true, math: 'mathjax', script: false })
const { html, css } = marp.render('# Hello, MarpWorkbench')

// 代码块的背景、文字与高亮 token 必须与主题协调
export function applyTheme(name) {
  return `theme: ${name}`
}
```

- `theme:` 写在 front-matter 里
- 深色主题要保证打印背景正确
- 代码字号约为正文的 0.6~0.65 倍

---

## 表格与多元素混排

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 封面页 | 通过 | `_class: lead` + 大标题 |
| 代码高亮 | 通过 | 深色/浅色两套 token |
| 表格 | 通过 | 与主题配色协调 |
| 页脚页码 | 通过 | front-matter 控制 |

---

## 收尾页的小结

1. 每套主题都覆盖 `section / lead / h1-h3 / code / pre / table / blockquote / 页眉页脚页码`
2. 全部离线：零外网字体与图片，中文使用系统字体栈 `Microsoft YaHei` / `PingFang SC`
3. 主题 CSS 均可被官方 Marp CLI / VS Code 插件原样渲染（标准 Marp 主题）

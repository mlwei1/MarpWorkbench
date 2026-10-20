---
marp: true
theme: default
paginate: true
header: 'Marp 技术调研'
footer: 'spike/marp 离线样例'
---

<!-- _class: lead -->

# 基于 Marp 的 Windows 桌面应用

## 离线导出实测 · 中文 / 代码 / 备注

---

## 中文与代码块

这是一段中文段落，用于验证 CJK 字体、换行与排版。行内代码：`marp.render(md)`。

```js
const marp = new Marp()
const { html, css, comments } = marp.render('# Hello')
console.log(html.length)
```

- 列表项一：主题切换
- 列表项二：导出 PDF / PPTX

<!-- 这是第 2 页的备注：介绍中文与代码块。 -->

---

## 表格页

| 能力 | 结论 |
| --- | --- |
| Markdown 渲染 | 正常 |
| 主题切换 | 正常 |

<!-- 最后一页备注：表格与收尾。 -->

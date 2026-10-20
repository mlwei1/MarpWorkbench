---
marp: true
theme: default
paginate: true
math: katex
header: 'Marp 技术调研'
footer: 'spike/marp 实测样例'
transition: fade
---

<!-- _class: lead -->

# 基于 Marp 的 Windows 桌面应用

## 技术调研实测 · 中文 / 代码 / 公式 / 备注

---

## 中文与代码

这是一段中文段落，用于验证 CJK 字体、换行与排版。行内代码：`marp.render(md)`。

```js
const marp = new Marp({ math: 'katex' })
const { html, css, comments } = marp.render('# Hello')
console.log(html.length, css.length, comments.length)
```

- 列表项一：主题切换
- 列表项二：导出 PDF / PPTX

<!-- 这是第 2 页的备注：介绍中文与代码块。 -->

---

## 数学公式

行内公式 $E = mc^2$，以及块级公式：

$$
\int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}
$$

> 引用块用于检查样式继承。

<!--
多行备注：
- 公式由 KaTeX 渲染
- 备注需要能按页提取
-->

---

## 表格与最后一页

| 能力 | 结论 |
| --- | --- |
| Markdown 渲染 | 正常 |
| 主题切换 | 正常 |

<!-- 最后一页备注：表格与收尾。 -->

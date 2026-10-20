/** 新建 deck 的模板内容（新建/导入/mock 共用；theme 由 settings.defaultTheme 决定） */

export const FALLBACK_THEME = 'business-blue'

export function blankTemplate(theme: string): string {
  return `---
marp: true
theme: ${theme}
paginate: true
---

# 新演示文稿

<!-- 在左侧写 Markdown，右侧实时预览。用 --- 分页。 -->

---

## 第二页

- 要点一
- 要点二
`
}

export function titleTemplate(theme: string): string {
  return `---
marp: true
theme: ${theme}
paginate: true
---

<!-- _class: lead -->

# 演示标题

## 副标题 / 汇报人 / 日期

---

## 目录

1. 背景与目标
2. 方案与进展
3. 下一步计划
`
}

export function sampleTemplate(theme: string): string {
  return `---
marp: true
theme: ${theme}
paginate: true
math: mathjax
header: 'MarpWorkbench 示例'
footer: '左侧编辑 · 右侧预览'
---

<!-- _class: lead -->

# MarpWorkbench 示例

## 中文 · 代码 · 公式 · 备注

---

## 中文与代码

这是一段中文段落，用于验证字体、换行与排版。行内代码：\`marp.render(md)\`。

\`\`\`js
const { html, css, comments } = marp.render(markdown)
preview.innerHTML = html
\`\`\`

- 左侧写 Markdown
- 右侧实时预览
- 改 \`theme:\` 一键换主题

<!-- 这是第 2 页的演讲者备注（导出 PPTX 时写入 notes）。 -->

---

## 数学公式

行内公式 $E = mc^2$，以及块级公式：

$$
\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}
$$

| 能力 | 状态 |
| --- | --- |
| 实时预览 | ✅ |
| 主题切换 | ✅ |

<!-- 第 3 页备注：MathJax 公式离线可用。 -->
`
}

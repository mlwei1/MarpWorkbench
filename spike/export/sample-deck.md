---
marp: true
theme: export-spike
paginate: true
size: 16:9
header: 'MarpWorkbench 导出实测'
footer: 'export-eng · M1'
---

<!-- _class: lead -->

# 导出管线实测

## PDF / PPTX · 中文 / 代码 / 渐变主题

<!-- 第 1 页备注：封面页，验证渐变背景与中文标题。 -->

---

## 中文与代码

这是中文段落，用于验证 CJK 字体嵌入、换行与打印颜色。行内代码 `marp.render(md)`。

```js
const marp = new Marp({ html: true, script: false })
const { html, css, comments } = marp.render(markdown)
console.log(html.length, css.length, comments.length)
```

- 列表：Chrome 无头打印（--print-to-pdf）
- 列表：CDP 原生截图（2x）

<!-- 第 2 页备注：中文 + 代码高亮背景 + 列表。 -->

---

## 表格与收尾

| 通道 | 保真度 |
| --- | --- |
| CDP 原生截图 | 100% |
| html-to-image | 代码高亮 / 渐变丢失 |

> 引用块：验证主题样式与备注写入。

<!-- 第 3 页备注：表格 + 引用块，最后一页不分页。 -->

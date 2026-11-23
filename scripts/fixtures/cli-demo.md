---
marp: true
theme: business-blue
paginate: true
size: 16:9
header: 'MarpWorkbench CLI'
footer: '2026'
---

<!-- _class: lead -->

# CLI 一键生成 PPT

## Markdown → PPTX / PDF / HTML

---

## 结论先行

- AI 写标准 Marp Markdown
- 一条命令直接导出
- PPTX 支持图片版与可编辑版

<!-- 备注：CLI 的目标是让 AI 的产出直接可用。 -->

---

## 三个使用步骤

1. 把 `AI_WRITING_GUIDE.md` 给 AI，生成 `deck.md`
2. 运行 `MarpWorkbench.exe --export deck.md --format pptx-editable`
3. 打开输出的 `.pptx`

---

## 数据表格

| 指标 | 数值 | 说明 |
| --- | --- | --- |
| 页数 | 10 | 演示 |
| 格式 | 4 种 | pptx/可编辑/pdf/html |
| 平台 | Windows | 单文件 |

---

## 代码示例

```powershell
MarpWorkbench.exe --export .\deck.md `
  --format pptx-editable `
  --out .\deck.pptx
```

---

## Mermaid 图

```mermaid
%% mwb-size: l
graph LR
  A[Markdown] --> B[CLI] --> C[PPTX]
```

---

> 让 AI 负责内容，让工具负责排版。

---

## 风险与边界

- 导出仍依赖本机 Chrome/Edge
- 可编辑版的背景是高清底图
- 首次导出需启动浏览器，约 10–20 秒

---

## 下一步

1. 用 AI 生成第一版 md
2. 用主题/属性面板微调
3. CLI 批量导出

---

## 谢谢

<!-- 备注：CLI 验收用示例 deck。 -->

# M4 验收报告 —— PPTX 可编辑导出（Beta）

> 日期：2026-11-22 ｜ 状态：**通过（Lead 验收）** ｜ 契约：`docs/UI_CONTRACT_M4_PPTX_EDITABLE.md`
> 用户需求原话："添加ppt可编辑导出功能"

---

## 1. 需求与方案

| 项 | 内容 |
|---|---|
| 需求 | 导出的 PPTX 能像普通 PowerPoint 一样编辑，而不是整页图片 |
| 方案 | **两层**：每页背景 = Marp 主题高清底图（文字透明化、表格隐藏）+ 前景 = 从渲染 DOM 的计算样式提取的**真正的 PowerPoint 文本 / 列表 / 代码 / 表格对象**，备注写入 notes |
| 为什么不做"全矢量" | Marp 主题大量依赖 CSS 背景/渐变/装饰/Mermaid SVG，完全用 PPT 原生形状重建会明显丢版式；两层方案在**版式保真**与**可编辑**间取平衡 |
| 入口 | 导出面板新增「PPTX 可编辑（Beta）」格式卡；文件名 `<deck 名>-可编辑.pptx`；默认仍是版式 100% 保真的图片版 |

### 能力边界（UI 与文档均已明示）

- ✅ 可编辑：标题、正文、列表、引用、代码（逐 token 颜色/等宽字体）、表格（原生 PPT 表格）、备注
- ⚠️ 底图不可编辑：主题背景/装饰、图片、Mermaid、页码
- ⚠️ 近似：PowerPoint 字体度量差异可能造成轻微换行/偏移；表格边框为近似；阴影/渐变文字/transform 不保留
- ✅ 尺寸：16:9 → 13.333×7.5in；4:3 → 10×7.5in（按 deck 实测动态定义）

---

## 2. 交付物

| 类别 | 内容 |
|---|---|
| 布局提取/组装模块 | `web/src/export/editable/**`（`types/layout/assemble/css/index`）：隐藏 iframe 渲染 → 逐 `svg[data-marpit-svg]`/section 抽文本块（li bullet、pre 逐 span 彩色 run、`<br>`、内联 code 底色、auto-scaling 字号）+ 表格（colW/rowH/fill/bold/border）→ 生成背景覆盖 CSS；pptxgenjs 动态布局 + addText/addTable/addNotes |
| 导出面板集成 | `web/src/export/ExportPanel.vue`：新格式卡、懒加载模块、资源内联、`/api/export/capture` 背景截图（≤10 页 PNG / >10 页 JPEG q90，scale 2）、进度/错误/回退提示、下载 |
| 服务端 | 无改动（复用现有截图 API） |
| 文档 | `docs/UI_CONTRACT_M4_PPTX_EDITABLE.md`、`docs/dev/editable-pptx.md`、`docs/dev/export.md` §15、README 中英文、本报告 |
| 自测工程 | `spike/editable/**`（真实 Chrome + marp-core + pptxgenjs + python-pptx 16:9/4:3 样例）、`spike/export/scripts/verify-editable-export.mjs` |
| 验收脚本 | `scripts/verify-editable-pptx.mjs` + `scripts/dev/check-editable-pptx.py`（真实 exe + Chrome + python-pptx） |

---

## 3. 验收结果（真实 exe 12.41MB + Chrome 155 + python-pptx 1.0.2）

| 验收项 | 结果 |
|---|---|
| **Lead M4 集成 E2E** `node scripts/verify-editable-pptx.mjs` | **23/23 ✅**（另 LibreOffice 1 项跳过，见 §4） |
| export-eng 端到端（13 页） | 21/21 ✅（解包 13 页、sldSz 13.333×7.5in、13 页 blipFill、1 个 `<a:tbl>`、中文可提取、13 notesSlides、50 处字体 run） |
| 模块自测（16:9 5 页 + 4:3 2 页） | 22/22 ✅；python-pptx **57/57**（16:9）/ **24/24**（4:3） |
| M1 回归 | 13/13 ✅ |
| M2 回归 | 26/26 ✅ |
| M3 回归 | 21/21 ✅ |
| M3.1 回归 | 14/14 ✅ |
| API 冒烟 | 12/12 ✅ |

**Lead E2E 覆盖**（13 页 deck：中文标题/列表/代码/表格/背景图/Mermaid/引用/备注）：
- 预览中 Mermaid 正确渲染（专门覆盖"deck 前面有 js 代码块、后面才是 mermaid"的场景）；
- 面板出现「PPTX 可编辑（Beta）」并成功导出；
- `.pptx` 可被 python-pptx 打开：13 页、13.333×7.5in、**13/13 页有背景图片（blipFill）**、1 个原生表格、文本包含标题/列表/代码/表格表头/末页文字（494→456 字符量级）、notes 含"讲稿"；
- 文件名含 `-可编辑.pptx`；面板显示"可编辑"结果文案；零前端 JS 错误。

**性能/体积（本机）**：13 页导出约 10s（含背景截图）；简单背景 deck 约 **0.53MB**；含照片/复杂背景的 5 页样例 **5.74MB**（体积主要取决于底图，符合预期）。

**截图**（本地保留，不进 git）：`spike/visual-m4/2026-11-22T06-59-28/01-export-formats.png`（格式卡）、`02-editable-selected.png`、`03-export-done.png`；样例渲染图 `spike/editable/out/16x9-pptx-slide-1.png`。

---

## 4. 已知限制 / 环境说明

1. **底图不可编辑**：背景、装饰、图片、Mermaid、页码为高清底图（UI/README 已标注 Beta 与边界）。
2. **字体度量**：PowerPoint 与浏览器字体度量不同，文字可能出现轻微换行/位置偏移；目标机缺字体时 PowerPoint 自动替换。
3. **表格**：重建为 PPT 表格，边框/内边距为近似；合并单元格等复杂表格暂未支持。
4. **LibreOffice 校验**：本机 `soffice --headless` 在 agent 环境会挂起（>90s 无输出），验收脚本将其作为**可选跳过**；PPTX 结构合法性由 python-pptx 解析 + OOXML 校验兜底。真实 PowerPoint 打开效果建议人工抽查一次。
5. **文件更大**：可编辑版包含每页高清底图，体积高于图片版；13 页/复杂主题可能 10–25MB。

## 5. 顺手修复

- **Mermaid 多代码块 bug**：`hasMermaid` 旧实现只检查**第一个** `<code>` 块；当 deck 先出现 js/ts 代码块、后面才出现 ```mermaid 时，mermaid bundle 不会被加载。已修复（扫描全部 code 块），并在 M4 E2E 增加专门用例（`混合代码块 deck 的 Mermaid 也渲染`）。
- 通过 M3 回归（21/21）确认 mermaid 原有行为未破坏。

## 6. 复现命令

```powershell
pnpm run build            # 构建 web + exe（版本 0.2.0）
pnpm run verify:editable  # M4 验收：真实 exe + Chrome + python-pptx（23 项）
```

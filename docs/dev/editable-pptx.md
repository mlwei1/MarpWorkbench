# PPTX 可编辑导出（M4-A：DOM→可编辑 PPTX 布局提取与组装）

> 状态：M4-A 完成并实测通过（2026-11-22）｜ owner：editable-ppt-eng（task-17）
> 契约：`docs/UI_CONTRACT_M4_PPTX_EDITABLE.md` §1 / §2.1 / §5（本文件记录实现细节、与契约的少量偏差、实测数据与已知限制）
> 代码：`web/src/export/editable/**`｜自测：`spike/editable/**`｜面板集成：export-eng 的 `web/src/export/ExportPanel.vue`（M4-B，不在本文件范围）

---

## 0. TL;DR

| 项 | 结论 |
|---|---|
| 产物 | 每页 = 高清背景图（文字透明化）+ **真正的 PowerPoint 文本 / 表格对象** + 演讲者备注；背景/图片/Mermaid/公式/页码是底图不可编辑 |
| 版面 | 按 deck 实测尺寸动态定义：16:9 → `13.333…×7.5 in`（sldSz 12192000×6858000）、4:3 → `10×7.5 in`；px/96 → 英寸 |
| 模块 | 纯前端 TS，无 Vue 依赖；`measureDeckForEditablePptx`（需要浏览器 DOM）+ `assembleEditablePptx`（只依赖调用方传入的 pptxgenjs） |
| 实测（5 页 16:9，中文/列表/代码/表格/背景图/Mermaid/备注） | measure **0.7–1.5s**（17 文本块 / 1 表格 / 65 run）；assemble **1.0–2.9s** → **5.74MB**（同机多次波动）；python-pptx **57/57** 校验通过；背景图 5/5 页 `blipFill` |
| 实测（2 页 4:3） | measure **0.28–0.62s**；assemble **0.27–0.50s** → **1.58MB**；python-pptx **24/24**；尺寸 10×7.5 in |
| 耗时预算（Lead 验收：13 页 ≤60s） | 本机 5 页全链路（marp 渲染 + measure + 背景截图 + assemble + python 校验）≈ 9s；13 页预计 measurement/assemble 各 <3s，主要成本仍是服务端背景截图（PNG ≤10 页 / JPEG >10 页，见 `docs/dev/export.md` §3.2） |

---

## 1. 集成 API（export-eng / ExportPanel）

入口：`web/src/export/editable/index.ts`（具名导出 + default 对象，可 `import.meta.glob` 懒加载）

```ts
export async function measureDeckForEditablePptx(
  html: string,                 // marp-core 渲染结果；调用方须先把 deck 资产 + 网络图 inline 成 dataURL
  css: string,                  // marp-core 渲染的 CSS
  opts: { width: number; height: number; comments?: string[]; title?: string },
): Promise<MeasuredDeck>

export async function assembleEditablePptx(
  deck: MeasuredDeck,
  backgrounds: string[],        // dataURL 列表，长度必须 = deck.pageCount，顺序 = layouts 顺序
  opts: {
    title?: string
    pptxgenjs: any              // 传**构造函数**（(await import('pptxgenjs')).default）或已实例化对象
    comments?: string[]
    onProgress?: (pct: number, label: string) => void   // 组装阶段 5→95→100
  },
): Promise<{ blob: Blob; stats: { slides: number; textBlocks: number; tables: number; bytes: number } }>
```

`MeasuredDeck`：

```ts
{
  layouts: { texts: EditableTextBlock[]; tables: EditableTableBlock[] }[]  // 每页一项
  backgroundHtml: string     // = 原始 html（资源已 inline）
  backgroundCss: string      // = css + 文字透明/表格隐藏/Mermaid 恢复覆盖样式
  pageCount: number
  width: number; height: number      // 标称尺寸（1280×720 / 960×720 …）
  stats: { textBlocks: number; tables: number; runs: number }
}
```

集成要点（与 export-eng 已对齐）：

1. `measure` 必须在真有 DOM 的浏览器里调用（内部创建隐藏 iframe；不依赖 Vue）。`assemble` 无 DOM 依赖，可在浏览器/Node 跑。
2. `backgroundHtml/backgroundCss` **原样** POST `/api/export/capture`；capture 的模板/`marp browser helper`（auto-scaling）与测量侧保持一致。
3. capture 时请用 `deck.width/deck.height`（不是 props 默认值），否则 4:3 deck 的背景会被按 16:9 拉伸/裁剪。
4. capture 返回的 `images` 按 `index` 升序、数量必须 = `pageCount`（`assemble` 内部会校验，数量不符抛可读错误）。
5. 面板下载走 `blob`：`a.download = "<title>-可编辑.pptx"`。失败文案自带阶段：`版式测量失败：…` / `PPTX 组装失败（第 N 页）：…`。
6. pptxgenjs 由调用方传入（不新增依赖）；组装内部 `defineLayout` + `layout` 均按 deck 尺寸动态计算，不会污染调用方已有版面。

---

## 2. 数据流

```
markdown --marp-core--> { html, css, comments }        （前端渲染层，资源已 inline）
        │
        ├─ measureDeckForEditablePptx(html, css, {width,height})
        │     ├─ 隐藏 iframe 渲染 html/css → 等字体/布局稳定（含 marp helper auto-scaling）
        │     ├─ 逐 svg[data-marpit-svg] 抽 section 的文本块 / 表格块 → layouts
        │     └─ backgroundHtml = html；backgroundCss = css + 覆盖样式（文字透明/表格隐藏）
        │
        ├─ POST /api/export/capture {html: backgroundHtml, css: backgroundCss, scale:2}
        │     └─ 返回每页背景图 URL → 面板 fetch 成 dataURL[]（长度 = pageCount）
        │
        └─ assembleEditablePptx(deck, backgrounds, {pptxgenjs, comments, onProgress})
              └─ pptxgenjs：defineLayout(width/96, height/96) → 每页 background + addText/addTable
                 + addNotes → write({outputType:'blob'})
```

---

## 3. 算法：`measureDeckForEditablePptx`（`layout.ts`）

1. **隐藏测量页**：创建 `position:fixed; left:-10000px; top:0; width:<W>px; height:<H>px; visibility:hidden; opacity:0; pointer-events:none` 的 iframe（契约 §2.1.1），`srcdoc` 注入：
   - 固定基础样式 `html,body{margin:0;padding:0;overflow:hidden}` + `div.marpit > svg[data-marpit-svg]{display:block;width:<W>px;height:<H>px}`（与服务端打印/截图页规则一致，保证坐标 1:1）；
   - 主题 CSS + 渲染 HTML；
   - CSP：`default-src 'none'; script-src 'self' 'unsafe-eval'; style-src 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:`——只允许同源 marp helper 脚本，deck 里的内联脚本/事件处理器、外网图片一律禁止（`html:true` 时的安全兜底）。
   - 先设 `srcdoc` 再挂载 DOM（否则 `onload` 会被 `about:blank` 的首次加载提前触发）。
2. **等稳定**：`iframe.onload` → `document.fonts.ready`（4s 超时兜底）→ 在 **iframe 内** 加载 `/marp-core.browser.js` 并调用 `MarpCoreBundle.MarpCore.browser(body)`（与服务端 capture 页同款 auto-scaling；`customElements` 是 per-window 的，所以必须用 iframe realm 的函数）→ 轮询 `svg` 尺寸连续两次一致（≤4s）。
   - rAF 均带 `setTimeout` 兜底（后台标签页 rAF 可能被暂停，不能依赖）。
3. **逐页取内容区**：`svg[data-marpit-svg]` 的 `getBoundingClientRect()` 作为页原点；内容 section 优先 `section[data-marpit-advanced-background="content"]`，否则第一个 `foreignObject section`（`bg left/right` 的伪背景层不会被重复抽取）。
4. **递归抽文本块**：
   - 块级（`display: block/flex/grid/list-item/table…`）元素递归；无块级子元素时整块抽成一个 `EditableTextBlock`；混合内容（如 `li` 内嵌 `ul`）先抽直接 inline 文本、再递归子列表。
   - run 样式取文本所在元素的 computed style：`fontWeight>=600→bold`、italic、underline、line-through、`color→RRGGBB`、`fontSize(px)×0.75×autoScale→pt`、`fontFamily` 第一个非 generic（monospace→Consolas、serif→Times New Roman、sans-serif→Segoe UI；`Microsoft YaHei` 等真实字体保留）、内联 `code` 的 `background-color→highlight`、`<br>`/pre 内 `\n` → `breakLine:true`。
   - `pre/code`：保留空白、逐 span（highlight.js token）颜色 run；`auto-scaling`（`marp-pre` 的 shadow DOM）用 `svgRect.width / viewBox.width` 求缩放系数，字号/行高按视觉尺寸换算，长代码行与底图对齐。
   - 几何：x/w 取元素内容盒（去 border+padding），y/h 取文本 Range 的 bbox（多行并集）；`pre` 用文本实际 bbox；`li` 标记 `bullet:true`。
   - 跳过：`display:none`/`visibility:hidden`/`opacity:0`/宽高<1、`svg`、`img`、`picture`、`.mwb-mermaid`、MathJax/KaTeX（`mjx-container`/`.katex`）、`script/style` 等；文本颜色 alpha=0（透明/渐变文字）跳过。
   - **防御**：整块文本恰好是一行未渲染的图片指令（`![...](...)`）时跳过（markdown-it 拒绝 `data:image/svg+xml` 时会退化成字面文本；正常 app 里 marp 会渲染成 `<figure>`）。
5. **表格块**：`table` → `tr/td/th`；`colW` 取首行各 cell 实际宽度、`rowH` 取各行高度；`fill` 取 cell computed `background-color`；`th`/`fontWeight>=600` → bold；`align` 取 computed `text-align`；边框色取首个 cell `borderTopColor`（缺省 `D9D9D9`）。**注意**：GitHub 风格 base CSS 会把 `table` 设为 `display:block`（此时 table 元素宽度 ≠ 表格网格宽度），实现用**行盒并集**作为表格几何（本样例实测：table 元素 1152px，真实网格 279px）。表格子树不再抽文本块。
6. **返回**：`backgroundHtml = html`；`backgroundCss = css + 覆盖样式`；`stats`。

### 3.1 背景覆盖样式（`css.ts`，契约 §2.1.5 的落地与偏差）

- 隐藏文字：对 `h1-h6/p/li/blockquote/pre/code/td/th/figcaption/summary/span/header/footer/div/dt/dd/caption/label/…` 设 `-webkit-text-fill-color: transparent !important; text-shadow: none; text-decoration-color: transparent`；
- `section table { visibility: hidden !important; }`（表格会重建为 PPT 表格对象）；
- `section li::marker { color: transparent }`（项目符号由 PowerPoint 重建）；
- Mermaid / MathJax / SVG text 恢复文字填充（`-webkit-text-fill-color: currentcolor`）；
- 页码 `section::after` 不在隐藏列表里 → 保留在底图。

**与契约 §2.1.5 示例的偏差（有理由）**：契约示例用 `color: transparent`，实测会让 `fill="currentColor"` 的 MathJax SVG 公式一起变透明（marp-core 4.4 的 mathjax 输出就是 currentColor SVG），且 `revert` 救不回来（`color` 是继承属性，父级 transparent 仍是 transparent）。因此改为**只隐藏文字填充**（Chrome/Edge 截图足够），保留 `color` 给 SVG currentColor；主题若用 `background-clip:text` 渐变文字仍会丢失（已知限制）。

### 3.2 auto-scaling 一致性（关键坑）

服务端 capture 页会注入 marp browser helper，`<pre is="marp-pre">` 被升级为 `<marp-pre>` + shadow DOM + SVG 缩放（`data-auto-scaling="downscale-only"`）。测量侧若不做同样处理，长代码块的字号/换行会与底图错位。实现：在测量 iframe 里 `script src=/marp-core.browser.js` 后用 iframe realm 的 `browser()` 应用；抽 pre 文本时用 `shadowRoot 内 svg` 的 `rect.width / viewBox.width` 作为缩放系数乘到字号/行高上（本样例长 URL 行触发 downscale，代码 run 实测 `20px → 10.74pt`，与底图一致）。helper 加载失败时降级为不缩放并 `console.warn`（普通短代码无差异）。

---

## 4. 算法：`assembleEditablePptx`（`assemble.ts`）

1. 校验：`layouts` 非空；`backgrounds.length === pageCount`（不符 → `PPTX 组装失败：背景图数量与页数不一致…`）；`pptxgenjs` 可用。
2. `new PptxGenJS()`（传实例则直接用）；`pptx.title = title`；`defineLayout({ name: 'MWB_<W>x<H>', width: W/96, height: H/96 })` 并 `pptx.layout`。
3. 每页：`slide.background = { data: backgrounds[i] }` → 文本（`slide.addText(runs, opts)`）→ 表格（`slide.addTable(rows, opts)`）→ `slide.addNotes(comments[i])`（仅有内容时）。
   - 文本 opts：`x/y/w/h`（px/96）、`margin:0`、`valign:'top'`、`fit:'none'`、`wrap:true`、`align`、`fontFace/fontSize/color/bold/italic`、`lineSpacing`（pt，来自 computed line-height）、`charSpacing`（pt，来自 letter-spacing）；`li` → `bullet:{indent:12}` 并在 x 上补偿 12pt（否则文字会右移；悬挂缩进 = 12pt，约等于主题 marker 宽度）。
   - run：`{ text, options }[]`，逐 run 保留 bold/italic/underline/`{style:'sng'}`/strike/color/fontFace/fontSize/`highlight`/`breakLine`；最后一个 run 不写 `breakLine`（避免空段落）。
   - 表格 opts：`x/y/w`、`colW`（英寸数组）、`rowH`、`border:{type:'solid',pt:0.5,color}`、`margin:0`、`valign:'middle'`、`autoPage:false`；cell 选项bold/fill/align/color/fontFace/fontSize。
4. `await pptx.write({ outputType: 'blob' })`（兼容 `write('blob')` 老写法）；返回 Blob + stats。blob 在少数环境可能返回 ArrayBuffer/Uint8Array/base64，内部统一兜底转 Blob。
5. 进度：每页回调 `5 + round((i+1)/pages*90)`，最后 97/100；每 5 页 `await setTimeout(0)` 让出主线程。

---

## 5. 支持 / 不支持（产品边界，需同步到 UI 文案）

| 支持（可编辑） | 不支持（底图/近似） |
|---|---|
| 标题/正文/列表（含嵌套、项目符号）、引用块 | 背景、装饰图、图片、Mermaid、公式（MathJax SVG）、页码 = 底图不可编辑 |
| 粗体/斜体/删除线/下划线、颜色、字体、字号、行距/字距 | 阴影、渐变文字、`background-clip:text`、transform/动画、复杂 outline |
| 代码块：等宽字体 + highlight.js 逐 span 颜色 + 代码块底色（底图） | 代码块内部的非文本元素；auto-scaling 极端内容仍可能换行差异 |
| 内联 code：等宽 + 原文颜色 + 底色 highlight | 内联 code 的圆角/边框等细节（只保留底色） |
| 表格：行列/列宽/行高/单元格填充/表头加粗/对齐/边框色 | 表格圆角/斜线/合并单元格（colspan/rowspan 退化为均分列宽）、单元格内混排样式按首个 run 简化 |
| 演讲者备注写入 notes（与图片版一致） | PDF/备注书签（不属于本模块） |
| 4:3 / 16:9 / 自定义 `@size`（按 width/96、height/96 动态版面） | 小于 1px / 透明的文本（不可见元素按契约跳过） |

---

## 6. 测试命令（spike 自测，必须真跑）

```powershell
# 全流程：真实 marp-core 渲染（5 页 16:9：中文/列表/Mermaid/代码/表格/背景图/备注 + 2 页 4:3）
#   → 真实 Chrome 里 measure（隐藏 iframe）→ 模拟 /api/export/capture 逐页 2x 截图
#   → 真实 Chrome + pptxgenjs 浏览器 bundle assemble → 写 out/*.pptx
#   → python-pptx 校验（页数/尺寸/背景 blipFill/文本/表格/notes/字体 run/形状越界）
node spike/editable/scripts/run-sample.mjs
# 只跑 16:9：node spike/editable/scripts/run-sample.mjs --skip-4x3
# 可选：本机尝试 LibreOffice 转 PDF/PNG（默认关闭，见下方已知限制）
node spike/editable/scripts/run-sample.mjs --libreoffice
```

产物（`spike/editable/out/`，gitignored）：

| 文件 | 说明 |
|---|---|
| `16x9-editable.pptx` / `4x3-editable.pptx` | 可编辑 PPTX 样品 |
| `16x9-python-report.json` / `4x3-python-report.json` | python-pptx 逐项校验（页/尺寸/blipFill/a:t/a:tbl/notes/run 字体/形状越界） |
| `16x9-bg-slide-N.png` / `4x3-bg-slide-N.png` | 背景图层（2x，文字已透明）截图 |
| `16x9-rendered-slide-1.png` | 原始渲染（文字可见）对照 |
| `16x9-pptx-slide-1.png` | 早期单次 LibreOffice 导出的**首页**渲染图（PPTX 真实渲染证据；后续 LO 校验以 Lead 为准） |
| `16x9-measured-deck.json` / `4x3-measured-deck.json` | 测量结果（几何/run/表格）便于排查 |
| `report.json` / `report.md` | 本次实测汇总（检查项、耗时、字节数） |

单独复现 python 校验：`python spike/editable/scripts/verify_pptx.py <pptx> <expect.json> [report.json]`（见 `run-sample.mjs` 生成的 `<label>-expect.json`）。

环境：Windows、Node 22.13、Chrome 155、pptxgenjs 4.0.1、python-pptx 1.0.2、marp-core 4.4.0。

---

## 7. 实测数据（2026-11-22，本机）

### 7.1 16:9（5 页：封面/列表/Mermaid/代码/表格+背景图，中文 + 每页备注）

| 阶段 | 数据 |
|---|---|
| marp 渲染 | 5 页 1280×720，html 16.4KB（含内联 mermaid SVG）/ css 52.3KB，1120ms |
| measure | **738ms**；17 文本块 / 1 表格 / 65 run（5 页：3 / 8 / 2 / 3 / 1+表格） |
| 背景截图（模拟 capture） | 5 张 2560×1440 PNG，平均 1.15MB/页，共 **5.39s**（含页面渲染/wait） |
| assemble | **1031ms**，5 页 / 17 文本框 / 1 表格 → **6,020,788 B（5.74MB）** |
| python-pptx | **57/57 通过**：5 页、13.333×7.5 in、每页 `blipFill` + 背景图 2560×1440、notes 5 页、`a:tbl` 1、含 fontSize+fontFace 的 run 65、全部文本形状在页面范围内、标题/列表/代码/表头文本命中 |
| 首页渲染（LO，早期一次） | 见 `out/16x9-pptx-slide-1.png`：背景渐变 + 可编辑标题/副标题/日期，位置与预览基本一致（预览对照 `out/16x9-rendered-slide-1.png`） |

### 7.2 4:3（2 页：封面 + 列表/表格，中文备注）

| 阶段 | 数据 |
|---|---|
| marp 渲染 | 2 页 960×720 |
| measure | **279ms**；6 文本块 / 1 表格 / 6 run |
| 背景截图 | 2 张 1920×1440 PNG，**1.4s** |
| assemble | **269ms** → **1,654,594 B（1.58MB）** |
| python-pptx | **24/24 通过**：2 页、**10×7.5 in**、每页 blipFill、notes 2 页、`a:tbl` 1、文本命中 |

> 13 页预算推算：measure ≈1–2s + assemble ≈1.5–3s + 背景截图（服务端口径：≤10 页 PNG / >10 页 JPEG q90，`docs/dev/export.md` §3.2）→ 远低于 60s/25MB 预算（体积随页数与截图格式增长，PNG 通道每页约 1.2MB）。

---

## 8. 已知限制 / 风险

1. **LibreOffice 校验**：本 agent 环境里 `soffice --headless --convert-to pdf` 会挂起（>3 分钟；`--convert-to png` 早期一次成功 23.7s，之后也复现挂起），已停用默认流程（`--libreoffice` 才尝试）。**PPTX→PDF 页数校验由 Lead 用超时/独立 profile 最终验收**；PPTX 结构合法性目前由 python-pptx 57/57 + OOXML 解包指标保证。
2. 文本位置按 DOM 几何 + px/96 换算；PowerPoint/LibreOffice 的字体度量与浏览器不同，**换行/轻微偏移**可能发生（本样例首页目检一致）。目标机缺字体时 PowerPoint 自动替换。
3. 只有「文字填充」被透明化；主题用 `background-clip:text` 渐变文字、或颜色为透明的文本会被跳过（底图里也透明 → 该段文字丢失，属已知近似差异）。
4. Mermaid/公式/图片/页码/背景都是底图不可编辑（产品定义，契约 §1/§5）；Mermaid 的 HTML 标签型文本靠 `-webkit-text-fill-color: currentcolor` 恢复。
5. 表格：colspan/rowspan 退化为均分列宽；单元格内混排样式按首个 run 简化；边框为统一 0.5pt 实线近似。
6. `bullet` 用 pptxgenjs `{indent:12}` 悬挂缩进并在 x 上补偿 12pt（约 16px）；主题 marker 若用特殊符号/更大间距，项目符号位置会有小差异（文字位置与 DOM 对齐）。
7. auto-scaling：测量侧依赖同源 `/marp-core.browser.js` 在 iframe 内加载成功；若该资源缺失（异常构建/dev 环境），长代码块可能与底图错位（普通短代码无影响），`console.warn` 提示。
8. 背景图体积：每页一张 2x 底图（PNG ≈1.2MB/页）→ PPTX 比图片版略大（图片版也是底图，仅少文本对象）；>10 页面板改用 JPEG q90 可显著降体积（服务端 capture 既有策略）。
9. **依赖 mermaid 模块的已知问题（非本模块）**：`web/src/mermaid/replace.ts::hasMermaid` 只检查 HTML 中**第一个**带 class 的 `<code>` 块；若 deck 里前面还有普通高亮代码块，mermaid 可能不被渲染 → 此时 mermaid 代码块会作为可编辑文本导出（回退可接受，但建议 mermaid-eng 修为全局检测）。
10. 安全性：测量 iframe 带 CSP（禁 deck 内联脚本/外网资源），但仍是同源 iframe；deck 内 `html:true` 原始 HTML 的 `onerror` 等内联事件被 CSP 阻断。

---

## 9. 与契约的偏差记录

| 契约 | 实现 | 原因 |
|---|---|---|
| §2.1.5 覆盖样式用 `color: transparent` | 只用 `-webkit-text-fill-color: transparent`（+ 表格隐藏/marker 隐藏/mermaid 恢复），并增加 `header/footer/div/…` 选择器 | `color: transparent` 会让 `fill="currentColor"` 的 MathJax SVG 公式变透明且无法 revert；Chrome/Edge 截图下 fill-color 已足够隐藏文字 |
| §2.1.5 背景选择器列表 | 增补 `section header/footer/div/dt/dd/caption/label/…` | marp 的 data-header/footer 与用户 raw HTML 也要隐藏，否则与可编辑文本重影 |
| §2.1.6 表格 `colW/rowH` 取元素 rect | 取行盒并集 + 首行 cell 宽度 | 主题 base CSS 可能 `table{display:block}`，table 元素宽度 ≠ 表格网格宽度（实测 1152 vs 279） |
| §2.1.2 页原点 `svg.getBoundingClientRect()` | 同 + 用 `rect.width/标称宽` 做 pageScale 容错 | 防御主题/容器导致的 SVG 缩放 |
| §2.1.3 `li` 用 PowerPoint bullet | 是（`{indent:12}` + x 补偿） | pptxgenjs 4.0.1 支持 bullet；补偿避免文字右移 |

---

## 10. 后续可做（M4+，不在本任务范围）

1. `measure` 与 capture 复用同一隐藏浏览器进程/CDP 会话（省去服务端二次渲染背景的成本）。
2. 表格 rich text（单元格内 runs 目前合并为文本）——需要 pptxgenjs 支持 cell 内多 run（可用 `addText` 到精确位置模拟）。
3. 图片对象化（把 `<img>` 也导出为 PPT 图片对象并保留位置）——当前保留在底图，可减少背景体积但增加复杂度。
4. 自动检测 PowerPoint 字体度量偏差，做 ≤2% 的位置微调（需要跨字体回归样本）。

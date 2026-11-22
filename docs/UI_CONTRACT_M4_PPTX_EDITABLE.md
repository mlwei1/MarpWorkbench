# M4 功能契约：PPTX 可编辑导出（文字/表格可编辑，背景保真）

> 状态：v1（2026-11-22）｜ 来源：用户需求"添加ppt可编辑导出功能"
> 现有导出：PPTX 图片版（逐页 2x 截图当背景，不可编辑）、PDF、HTML。
> 新增：**PPTX 可编辑版（Beta）**——在 PowerPoint 里文字可改、表格可改、备注保留，同时版式/主题保真。

---

## 1. 目标与产品定义

| 项 | 定义 |
|---|---|
| 用户体验 | 导出面板新增格式「**PPTX 可编辑（Beta）**」。导出后得到 `.pptx`：每页背景保持 Marp 主题原样（渲染成高清底图），**文字/列表/代码/表格是真正的 PowerPoint 文本与表格对象**，可以选中、修改、改字体字号颜色；演讲者备注写入 notes。 |
| 保真策略 | **背景层 = 当前页的高清截图（2x，文字已透明化）**；**前景层 = 从 DOM 计算样式提取的文本/表格对象**。这样主题背景、渐变、装饰图、Mermaid、页码保持像素级一致，文字可编辑。 |
| 与图片版区别 | 图片版整页不可编辑；可编辑版背景仍是底图（不可编辑），**文字与表格可编辑**。UI 与文档需明确标注该边界。 |
| 不支持（明确写进 UI/文档） | 背景/装饰图/Mermaid/页码是底图不可编辑；内联样式只保留粗体/斜体/删除线/颜色/内联代码底色；复杂 transform/动画不保留；字体需目标机存在或自动替换。 |

### 导出产物规格

- 幻灯片尺寸 = deck 实际尺寸：16:9 → 13.333×7.5 in；4:3 → 10×7.5 in（按 `width/height` 传入值 /96 英寸）。
- 每页：`slide.background = { data: backgroundDataUrl }`（覆盖整页的图片填充）+ 文本/表格 shape。
- 文本：`addText(runs, { x,y,w,h, fontFace, fontSize, color, bold, italic, underline, align, valign:'top', margin:0, wrap:true, fit:'none', lineSpacing?, charSpacing? })`；位置按 DOM 几何 px/96 换算英寸。
- 表格：`addTable(rows, { x,y,w, colW, rowH, fontFace, fontSize, color, border })`，单元格填充取计算样式背景色。
- 备注：`slide.addNotes(comments[i] || '')`（与图片版一致）。
- 文件名：`<deck 名>-可编辑.pptx`。

---

## 2. 模块划分（两个 owner，文件不相交）

### 2.1 `web/src/export/editable/**`（owner: editable-ppt-eng 新成员）

纯前端模块，不依赖 Vue/组件，可在浏览器与 puppeteer 测试页中运行：

```ts
export interface EditableRun {
  text: string
  bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean
  color?: string            // 'RRGGBB'
  fontFace?: string
  fontSize?: number         // pt
  highlight?: string        // 内联代码底色
  breakLine?: boolean
}
export interface EditableTextBlock {
  kind: 'text'
  x: number; y: number; w: number; h: number      // px（1280×720 坐标系）
  runs: EditableRun[]
  align?: 'left' | 'center' | 'right' | 'justify'
  valign?: 'top' | 'middle' | 'bottom'
  lineSpacing?: number       // pt
  charSpacing?: number       // pt
  bullet?: boolean           // li 项
  /** 段落级默认样式（runs 未覆盖时） */
  fontFace?: string; fontSize?: number; color?: string; bold?: boolean; italic?: boolean
}
export interface EditableTableCell {
  runs: EditableRun[]
  bold?: boolean
  fill?: string              // 'RRGGBB'
  align?: 'left' | 'center' | 'right'
}
export interface EditableTableBlock {
  kind: 'table'
  x: number; y: number; w: number; h: number
  colW: number[]             // px
  rowH: number[]             // px
  rows: { cells: EditableTableCell[]; fill?: string }[]
  fontSize?: number
  fontFace?: string
  color?: string
  borderColor?: string
}
export interface SlideEditableLayout {
  texts: EditableTextBlock[]
  tables: EditableTableBlock[]
}
export interface MeasuredDeck {
  layouts: SlideEditableLayout[]
  /** 用于服务端截背景：html + CSS 已注入"文字透明/表格隐藏"覆盖样式；调用方需先 inline 资源 */
  backgroundHtml: string
  backgroundCss: string
  pageCount: number
  width: number; height: number
  stats: { textBlocks: number; tables: number; runs: number }
}

export async function measureDeckForEditablePptx(
  html: string, css: string,
  opts: { width: number; height: number; comments?: string[]; title?: string },
): Promise<MeasuredDeck>

export async function assembleEditablePptx(
  deck: MeasuredDeck,
  backgrounds: string[],     // data URL / base64，长度 = pageCount，与 layouts 顺序一致
  opts: { title?: string; pptxgenjs: any; comments?: string[]; onProgress?: (pct: number, label: string) => void },
): Promise<{ blob: Blob; stats: { slides: number; textBlocks: number; tables: number; bytes: number } }>
```

实现要求：
1. **测量**：模块内部创建隐藏 iframe（`position:fixed; left:-10000px; top:0; width:<width>px; border:0; visibility:hidden`），srcdoc 注入 `html/css`（与预览同一份，资源须已 inline）；等待 `iframe.onload` + `document.fonts.ready` + 2 次 rAF；不得影响宿主页面 UI/滚动。
2. 遍历每张 `svg[data-marpit-svg]`：以 svg 的 `getBoundingClientRect()` 为页原点；取内容 `section`（优先 `section[data-marpit-advanced-background="content"]`，否则第一个 `foreignObject section`）。
3. 文本块抽取规则：
   - 递归遍历；遇到块级子元素（display 为 block/flex/grid/list-item/table 等）则递归，否则若元素内有非空文本则生成一个 `EditableTextBlock`（`li` 标记 bullet；`pre/code` 内文本用等宽字体、逐 span 颜色 run）。
   - 跳过：不可见元素（display:none / visibility:hidden / opacity:0 / 宽高<1）、`svg`、`img`、`picture`、`.mwb-mermaid`、`.mwb-mermaid *`、`script/style`。
   - 几何：用 `Range` 包裹元素内容取 bbox（多行并集），无文本时用元素 rect；坐标相对页原点，px→英寸由 assemble 负责（/96）。
   - run 样式取**所在元素**的 computed style：fontWeight≥600→bold、fontStyle italic、textDecoration、color、fontSize（px）、fontFamily（取第一个非 generic；generic 映射：monospace→Consolas、serif→Times New Roman、sans-serif→Segoe UI）、内联 `code` 的 background-color→highlight；`<br>` → 追加 `breakLine:true` 的 run；空白折叠但保留中文/英文间空格。
   - 文本颜色透明（`rgba(0,0,0,0)` / alpha 0）跳过。
4. 表格：`table` 元素生成 `EditableTableBlock`（`tr/td/th` → cells；colW/rowH 取各列/行 rect 尺寸；fill 取单元格 computed background-color；header 行 bold；边框色取 computed borderTopColor 或 `D9D9D9`）。**不要**把表格文字重复抽成 text blocks（table 子树跳过）。
5. 背景 HTML：`backgroundHtml = html` + 注入覆盖样式（追加在 css 末尾）：
   ```css
   section h1, section h2, section h3, section h4, section h5, section h6,
   section p, section li, section blockquote, section pre, section code,
   section td, section th, section figcaption, section summary, section span {
     color: transparent !important;
     -webkit-text-fill-color: transparent !important;
     text-shadow: none !important;
   }
   section table { visibility: hidden !important; }
   section .mwb-mermaid, section .mwb-mermaid * { color: revert !important; -webkit-text-fill-color: revert !important; }
   ```
   （页码 `section::after` 保留在底图；Mermaid/图片/背景/装饰保留。）
   注意：如某主题文字用 `background-clip:text` 等，接受近似差异并写文档。
6. **组装**：动态 `pptx.defineLayout({name:'MWB_WxH', width: width/96, height: height/96})`；每页先 `slide.background={data: backgrounds[i]}`，再按 layouts 添加文本/表格，最后 `slide.addNotes(comments[i]||'')`。文本 shape 选项见 §1；`bullet` 用 pptxgenjs 段落 bullet（若 4.0.1 不支持则文本前缀 "• " 并写文档）。表格边框 `{type:'solid', color:borderColor, pt:0.5}`，无填充时透明。
7. 错误：测量/组装抛错时给出可读 Error（含阶段）；单页失败不要静默吞掉（整次导出失败并提示）。

### 2.2 `web/src/export/ExportPanel.vue`（owner: export-eng）

1. `Format` 增加 `'pptx-editable'`；UI 增加第三张格式卡「PPTX 可编辑（Beta）」：标题 + 一句说明「文字/表格可在 PowerPoint 中编辑；背景、图片、Mermaid、页码为高清底图」+ 黄色 Beta 提示；默认仍选图片版。
2. `startExport()` 分支 `exportEditablePptx()`：
   - 取 `render()`（await，已含 Mermaid/资产/远程图内联；沿用现有 inline 逻辑；如 `render` 返回 html/css/comments）。
   - 动态 `import('../../export/editable/index')`（或相对路径）调用 `measureDeckForEditablePptx(html, css, {width,height,comments,title})`。
   - 把 `backgroundHtml/Css` POST `/api/export/capture`（format：页数≤10 用 png，>10 用 jpeg q90；沿用现有 API/token），拿 `images[].url` → fetch 成 dataURL 数组。
   - `assembleEditablePptx(deck, backgrounds, {title, pptxgenjs, comments, onProgress})` → `pptx.writeFile({fileName})` 下载（或 assemble 返回 Blob 由面板下载，二选一，面板文档写清）。
   - 进度文案：测量版式 → 生成背景（x/N）→ 组装 PPTX → 完成；结果文案显示「N 页 · 文本框 M · 表格 K · 可编辑（图片/背景为底图）」。
   - 失败：`EXPORT_FAILED` 可读提示，提供回退「改用图片版」。
3. 文件名：`<title>-可编辑.pptx`；与图片版区分。
4. `docs/dev/export.md` 增加「可编辑 PPTX」章节：原理、能力边界、API、测试命令、已知限制；README/UI 文案同步（告知用户这是 Beta 且边界）。

---

## 3. 验收（Lead 自动化）

脚本 `scripts/verify-editable-pptx.mjs`（真实 exe + Chrome + 下载文件 + python-pptx 校验）：

1. 创建 13 页 deck（中文标题/列表/代码块/表格/背景图/Mermaid/备注），打开编辑器 → 导出面板 → 选「PPTX 可编辑」→ 导出 → 等下载完成。
2. 断言面板出现完成文案与统计；无 JS 错误。
3. 用 python-pptx 打开 `.pptx`：
   - `len(prs.slides) == 13`；`prs.slide_width/height` ≈ 13.333×7.5 in（16:9）。
   - 每页 background XML 含 `blipFill`（有底图）；notes 页含指定备注文本。
   - 所有 `<a:t>` 文本合并后包含：每页中文标题、列表条目、代码片段、表格表头（≥ 指定字符串集合，允许空白差异）。
   - 至少 1 个 `<a:tbl>` 表格对象；至少 2 个含 `fontSize`/`fontFace` 的 run。
4. 用 LibreOffice headless 把 pptx 转 PDF（`soffice --headless --convert-to pdf`），断言成功且页数=13（证明 PowerPoint 结构合法/可打开）。
5. 体积/耗时记录：13 页目标 ≤ 25MB、≤ 60s（本机）。
6. 回归：图片版 PPTX / PDF / HTML 仍正常（M1/M2/M3 脚本全绿）。
7. 截图：导出面板可编辑选项、导出完成、用 python-pptx 或 LibreOffice 渲染的首页预览（可选）。

---

## 4. 写范围

| 路径 | owner |
|---|---|
| `web/src/export/editable/**`、`docs/dev/editable-pptx.md`、`spike/editable/**` | editable-ppt-eng |
| `web/src/export/ExportPanel.vue`、`docs/dev/export.md` | export-eng |
| `scripts/verify-editable-pptx.mjs`、文档汇总、版本号/构建/发布 | Lead |

不执行 git commit；不改对方文件；不新增运行时依赖（pptxgenjs 已在 web 依赖中，浏览器端已使用）。

---

## 5. 已知限制（必须写入 UI 与文档）

- 背景/装饰/图片/Mermaid/页码 = 底图，不可编辑。
- 文本位置按 DOM 测量，PowerPoint 字体度量差异可能造成轻微换行/偏移。
- 内联样式保留粗/斜/删除线/颜色/内联代码底色；其它（阴影、渐变文字、transform）不保留。
- 表格重建为 PPT 表格，边框/内边距为近似。
- 文件比图片版更大（每页一张高清底图）。
- 目标机缺字体时 PowerPoint 自动替换。

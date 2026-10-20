# M2 界面契约与分工（非 Markdown 用户友好）

> 状态：v1，2026-10-20 ｜ 目标：把"改 YAML / 手写 Markdown 语法"的操作变成**可以点、可以拖、可以预览**的 UI。
> 接口唯一依据本文件；`docs/API_CONTRACT.md` 仍然有效（本文件只加 UI 契约与新增 API）。
> 验收：`docs/M2_ACCEPTANCE.md`（完成后写）+ 扩展 `scripts/visual-e2e.mjs`。

---

## 0. 目标与产品原则

用户原话："插入表格功能优化，主题的 class 选择优化，页眉页脚之类的属性优化，可以用手点，然后图片插入优化（包括使用 bg 功能、透明的功能、左置右置占比功能），反正就是能让一般不懂 MARKDOWN 的用户也能轻松使用。"

原则：
1. **只产出标准 Marp Markdown**：所有 UI 操作最终落到 front-matter / Marp 指令（`<!-- _class: lead -->`、`![bg left:40% opacity:.5](...)`、GFM 表格），保证能拷回 VS Code/marp-cli。
2. **不破坏源码习惯**：高级用户仍可直接改 Markdown；属性面板双向同步、只改涉及字段、保留未知字段与注释顺序。
3. **点选优先**：常用操作 ≤2 次点击；有预览/撤销提示；错误可读。
4. **零外网**：图片只走本地资产接口；上传失败要有可读提示。

---

## 1. 布局改造（由 frontend-core/marp-tech 实施）

```
┌ topbar：← 工作区 | 标题 | 保存状态 | 主题下拉 | 主题画廊 | 属性 | 保存 | 导出 ┐
├ toolbar（新）：H1 H2 H3 ▾ | B I S | 列表 引用 代码 公式 分页 | 图片 表格 | 撤销/重做 ┤
├──────────────┬────────────────────────────┬──────────────────────────────┤
│ 左栏（可折叠）│ 编辑区（CodeMirror 6）      │ 预览（iframe，现有）          │
│ 大纲 / 幻灯片 │                            │                              │
│ 缩略图导航    │                            │                              │
├──────────────┴────────────────────────────┴──────────────────────────────┤
│ statusbar：第 x/y 页 · rev · 快捷键提示 · 试穿状态                          │
└──────────────────────────────────────────────────────────────────────────┘
右栏（可折叠）属性面板：主题 / 尺寸 / 页码 / 页眉 / 页脚 / 全局 class / 本页 class / 背景图 / 高级
```

- 左右栏宽度 240–320px，可折叠（按钮在 topbar 或栏头）；折叠状态存 localStorage。
- 属性面板与导出弹窗/主题画廊互斥（弹窗打开时不显示属性面板或置于弹窗下）。
- 所有新组件懒加载（`defineAsyncComponent`），不拖慢首屏。

---

## 2. 组件契约（所有组件路径固定，props/emits 不可随意改）

### 2.1 `web/src/outline/SlideNavigator.vue`（owner: outline-eng）

```ts
props: {
  markdown: string          // 当前 Markdown 全文
  html: string              // renderer 渲染出的完整 HTML（含全部 <svg data-marpit-svg>）
  css: string               // 对应主题 CSS（含 marp-core 注入样式）
  pageCount: number
  currentPage: number       // 1-based
  width: number             // 1280（用于缩放计算）
  height: number            // 720
}
emits: {
  jump: [page: number, line?: number]   // 大纲/缩略图点击：跳到该页；line 为大纲标题所在行（1-based）
}
```
- 两个 tab：**大纲**（按标题树，显示页码，当前页高亮，点击跳转）、**幻灯片**（缩略图列表，当前页高亮，点击跳转）。
- 缩略图必须**主题真实渲染**、不能破坏主预览；推荐做法：一个隐藏 iframe `srcdoc` 注入 `html/css` + 缩放 CSS + 点击脚本（postMessage 回传页码），组件内 `transform: scale` 展示；若用其他方案需保证不污染全局 CSS。
- 空 deck/无标题要有空态提示；100 页不卡（懒加载/分帧渲染）。
- 大纲解析：跳过 front-matter 与代码围栏；`#` 层级；`#` 到 `######`；同一页多个标题都列出。

### 2.2 `web/src/inspector/PropertyInspector.vue`（owner: frontend-core/marp-tech）

```ts
props: {
  markdown: string
  currentPage: number
  pageCount: number
  themes: ThemeMeta[]       // 来自 app.themes
  currentTheme: string
}
emits: {
  update: [markdown: string]                 // 应用新全文（父组件负责保存/渲染）
  openGallery: []
  openThemeEditor: [name: string]            // 打开主题编辑器
  pickBackground: []                          // 父组件打开图片插入器（mode=background）
}
```
必须支持（全部双向同步、点选/输入、即时生效）：
| 分组 | 控件 | 写入方式 |
|---|---|---|
| 主题 | 下拉 + 「画廊」「编辑主题」按钮 | front-matter `theme` |
| 尺寸 | 16:9 / 4:3 分段按钮 | front-matter `size: 16:9` / `4:3` |
| 页码 | 总开关 Toggle；「仅本页」三态（默认/显示/隐藏） | `paginate: true/false`；本页 `<!-- _paginate: false -->` |
| 页眉/页脚 | 文本框（global）+「仅本页」开关 + 清空 | `header:` / `footer:`（带引号转义）；本页 `_header`/`_footer` |
| 全局 class | 多选 chips：`lead` `invert` `center` + 自定义输入 | front-matter `class: lead invert` |
| 本页 class | 单选 chips + 自定义；「清除本页 class」 | 页首 `<!-- _class: xxx -->` |
| 背景图 | 显示当前页是否有背景图；「选择背景图」（emit pickBackground）、「移除背景图」、适配 cover/contain/fit、透明度滑杆 0–100% | 当前页页首 `![bg ...](path)`（含 opacity/size 修饰符） |
- 修改必须**只动目标字段**：保留未知 front-matter 字段、原顺序、注释；不重新格式化整篇。
- 非法输入（如 header 含换行）要转义或禁止并提示。
- 空 deck、无 front-matter 时能自动补 `marp: true`（首行）。
- 所有写入产生一次 `update`，父组件做 800ms 防抖保存 + 重渲染（与现有逻辑一致）。

### 2.3 `web/src/insert/ImageInsertDialog.vue`（owner: export-eng）

```ts
props: {
  deckId: string
  markdown: string
  currentPage: number
  initialMode?: 'image' | 'background'   // 默认 image
}
emits: {
  insert: [result: { snippet: string; mode: 'image' | 'background' }]
  close: []
}
```
- 图片来源：选择文件 / 拖拽 / 粘贴；也支持输入本地路径或 URL（URL 提示离线不可用）。
- 上传：`POST /api/decks/:id/assets`（multipart，字段 `file`）→ 返回 `{path:'assets/x.png'}`；失败可读提示。
- 选项（直接生成标准 Marp 图片语法）：
  1. **普通图片**：宽度 原图 / 25% / 50% / 75% / 100%（`![w:50%](assets/x.png)`）
  2. **背景图**：整页 / 左侧 / 右侧；左右模式有**占比滑杆 20–70%**（默认 40 → `![bg left:40%](...)`）
  3. **背景适配**：cover / contain / fit（默认 cover）
  4. **透明度**：0–100% → `opacity:.5`（0 不写）
  5. 可选：模糊 `blur:5px`、灰度 `grayscale`（高级折叠）
- 对话框内**实时预览**：用 `renderer` + 当前页内容合成候选 Markdown 渲染（可复用 `web/src/insert/compose.ts`）；预览区显示"插入后效果"。
- `snippet` 规则：
  - `image`：返回单独一行 `![w:50%](assets/x.png)`，父组件插入到**光标处**。
  - `background`：返回 `![bg left:40% opacity:.5](assets/x.png)`，父组件插入到**当前页页首**（页首 = 页起始行，front-matter 之后；插在第一页时注意 front-matter 在文件头，页首仍为 front-matter 后的第一行）。
- 上传后不要重复上传（同文件再次插入可直接用已有 path）。

### 2.4 `web/src/insert/TableInsertDialog.vue`（owner: export-eng）

```ts
props: { markdown: string; currentPage: number }
emits: { insert: [snippet: string]; close: [] }
```
- 行列选择器：hover 网格选 N×M（1–12），显示尺寸提示；或数字输入。
- 选项：首行表头（默认开）、对齐（左/中/右）、首列加粗（可选）。
- 生成标准 GFM 表格（每格占位文字可编辑：`表头1` 或留空）；返回完整表格块 + 前后空行。
- 对话框内预览表格样式（可用简单的 HTML 预览，不必调用渲染器）。

### 2.5 `web/src/themes/ThemeEditor.vue`（owner: ux-competitors）

```ts
props: { name?: string; css: string; markdown: string; mode?: 'create' | 'edit' }
emits: { save: [payload: { name: string; css: string; asCopy?: boolean }]; close: [] }
```
- 名称输入（编辑模式可改名 → 另存为新主题），CSS 编辑（等宽字体 textarea 即可，带行号加分）。
- 实时预览：把 CSS 临时注册进 `renderer`（临时名 `__mwb_preview__`），渲染当前 deck 第 1–2 页缩放预览；保存前不影响正式主题列表。
- 校验：必须含 `@theme <name>`；与名称一致；非法时行内错误 + 禁用保存。
- 保存动作由父组件（ThemeGallery）执行：`POST /api/themes`（新建/复制）或 `PUT /api/themes/:oldName`（编辑）。
- 关闭前若有改动，确认放弃。

### 2.6 `web/src/themes/ThemeGallery.vue`（owner: ux-competitors，扩展）

在现有功能上增加：
- 「＋ 导入主题」：选择/拖拽 `.css` → `POST /api/themes` → 刷新主题列表 → 自动应用/提示。
- 「＋ 新建主题」：基于当前主题 CSS（读 `renderer.getThemeCss` 或 `GET /api/themes/:name/css`）打开 ThemeEditor（mode=create）。
- 卡片菜单：「编辑」（我的主题）/「另存为」（内置主题复制）/「导出 CSS」（下载）/「删除」（我的主题，confirm）。
- props 增加：`onSaved?: () => void`（或 emit `changed`）；保持现有 props（themes/current/markdown/render）兼容。
- 依赖 API 函数（由 marp-tech 在 `web/src/api/index.ts` 提供）：`getThemeCss(name)`, `createTheme(css, fileName?)`, `saveTheme(name, css)`, `deleteTheme(name)`。

### 2.7 编辑区与工具栏（owner: frontend-core/marp-tech）

`web/src/editor/CodeMirrorEditor.vue` 增加 `defineExpose` API：
```ts
interface EditorApi {
  focus(): void
  getCursorLine(): number
  setCursor(line: number, ch?: number): void
  scrollToLine(line: number): void
  insertText(text: string, opts?: { block?: boolean; atCursor?: boolean }): void
  format(cmd: 'bold'|'italic'|'strike'|'h1'|'h2'|'h3'|'ul'|'ol'|'quote'|'codeblock'|'inlinecode'|'hr'): void
  undo(): void; redo(): void
}
```
- `web/src/insert/EditorToolbar.vue`（owner: marp-tech，因为要用 CM 命令）：
  - 按钮：H1/H2/H3 ▾、B、I、S、无序列表、有序列表、引用、行内代码、代码块、公式、分页线、图片、表格、撤销、重做。
  - 图片/表格按钮 emit `openImage` / `openTable`（由 EditView 打开对应 Dialog）。
- `web/src/insert/pasteDrop.ts`（owner: export-eng）：`attachImagePasteDrop(el, { onFiles })`，拦截图片粘贴/拖拽（非图片放行），返回解绑函数。

### 2.8 EditView 挂载（owner: marp-tech）

- 增加状态：`leftOpen/rightOpen`、`imageDialogOpen/imageMode`、`tableDialogOpen`、`themeEditorName`。
- 左栏挂 `SlideNavigator`：传入渲染结果（preview.html/css）与当前页；`@jump` → 光标 `setCursor(line)` + 滚动 + page 更新。
- 右栏挂 `PropertyInspector`；`@update` → 设置 content（不改光标）→ 保存/渲染；`@openGallery` → 打开画廊；`@openThemeEditor` → 打开主题编辑器；`@pickBackground` → 打开图片对话框（mode=background）。
- 工具栏挂 `EditorToolbar`；图片/表格按钮 → 打开对话框。
- 图片 Dialog `@insert`：mode=image → `editor.insertText(snippet)`；mode=background → 插入到当前页页首（用 frontmatter 帮助函数）并重渲染。
- 表格 Dialog `@insert` → `editor.insertText(snippet, {block:true})`。
- 主题编辑器：由 ThemeGallery 内部挂载或 EditView 挂载（二者择一，推荐 ThemeGallery 内部，减少 EditView 复杂度）。
- 监听粘贴/拖拽：在编辑器容器上挂 `attachImagePasteDrop` → 上传后直接插入普通图片（`![w:60%]` 默认），不弹对话框（快捷路径）。

---

## 3. 数据/API 新增（owner: frontend-core/marp-tech）

`web/src/api/index.ts` 增加：
```ts
uploadAsset(deckId: string, file: File): Promise<{ path: string; url: string; bytes: number }>  // multipart POST /api/decks/:id/assets
getThemeCss(name: string): Promise<string>            // GET /api/themes/:name/css
createTheme(css: string, fileName?: string): Promise<ThemeMeta>  // POST /api/themes
saveTheme(name: string, css: string): Promise<ThemeMeta>         // PUT /api/themes/:name
deleteTheme(name: string): Promise<void>              // DELETE /api/themes/:name
```
（服务端端点已全部实现，M1 已验证；新增的 `uploadAsset` 需注意不要手写 Content-Type，使用 FormData。）

`web/src/marp/frontmatter.ts` 增加（owner: marp-tech）：
```ts
getFrontMatterData(md): Record<string,string>
setFrontMatterField(md, key, value: string | null): string        // null 删除；保留未知字段/顺序
setSlideDirective(md, page /*1-based*/, key, value: string | null): string  // 页首 <!-- _key: value -->
getSlideDirective(md, page, key): string | null
pageStartLine(md, page): number        // 1-based
insertAtPageStart(md, page, snippet): string
findImageDirectives(md): Array<{ page: number; raw: string; path: string; modifiers: string[] }>
```
注意：`<!-- _class: lead -->` 必须在页首（可与其他指令同块或单独行）；删除时清理空行。

---

## 4. 6 套新主题（owner: ux-competitors）

在现有 6 套基础上补齐到 12 套（全部原创、零外链、系统中文字体栈、打印背景正确）：
`startup-orange`（创业橙/路演）、`data-teal`（数据青/数据汇报）、`dark-neon`（暗夜霓虹/发布会）、`paper-warm`（暖纸/阅读长文）、`chinese-ink`（中国风水墨）、`nature-green`（自然绿/环保教育）。
- 每套按 `docs/API_CONTRACT.md` §3 注释头 + 覆盖 section/lead/h1-3/code/pre/table/blockquote/页码页脚；深色主题保证打印背景；更新 `themes/index.json`。
- 用 `spike/marp` 渲染 + 无头 Chrome 打印验证，截图放 `spike/themes/shots/`，报告写 `docs/dev/themes.md` 附录。

---

## 5. 验收（Lead 会扩展 `scripts/visual-e2e.mjs`）

1. 12 套主题全部出现在画廊；切换每套预览无回退 toast。
2. 属性面板：改主题/尺寸/页码/页眉/页脚/全局 class/本页 class → Markdown 正确变化，预览立即变化；未知 front-matter 字段保留。
3. 大纲：≥3 个标题按层级显示，点击跳转正确页；缩略图数量=页数，点击跳转，主题正确。
4. 图片：上传 PNG → 插入普通图（w:xx%）；插入背景图 left:40% + opacity → 生成的 `![bg left:40% opacity:.5](assets/..)` 能被渲染；粘贴/拖拽图片直接入库并插入。
5. 表格：插入 3×3 带表头表格，源码为 GFM，预览渲染为表格；对齐选项生效。
6. 主题编辑器：导入外部 CSS → 画廊出现「我的主题」；编辑保存后 `GET /api/themes` 包含；删除后消失。
7. 无 JS 错误、无外网请求；`pnpm --dir web build` + `cargo build --release` 通过；exe 双击可用。
8. 截图：属性面板、大纲、图片插入器（bg 选项）、表格插入器、主题编辑器 各一张。

---

## 6. 写范围（避免冲突）

| 目录/文件 | owner |
|---|---|
| `web/src/outline/**` | outline-eng |
| `web/src/inspector/**`、`web/src/editor/**`、`web/src/views/EditView.vue`、`web/src/api/**`、`web/src/marp/frontmatter.ts`、`web/src/types.ts`、`web/src/styles/main.css`、`web/src/integrations/**` | marp-tech |
| `web/src/insert/**`（除 EditorToolbar.vue） | export-eng |
| `web/src/themes/**`、`themes/**` | ux-competitors |
| `web/src/insert/EditorToolbar.vue` | marp-tech（依赖 CM 命令） |
| `web/src/components/**` 如需公共小组件 | 先问 Lead |
| 构建/验收脚本、文档、git | Lead |

样式：新组件样式写在各自 SFC `<style scoped>`；需要复用全局变量/按钮类（`.btn` `.muted` `.modal-mask` `.modal-panel` 已在 `main.css`）直接用。**不要改 `main.css`**（marp-tech 统一加布局样式）；新组件不要引入 UI 库。

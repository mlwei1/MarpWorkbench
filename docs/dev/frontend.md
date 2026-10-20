# 前端开发说明（M1 · frontend-core）

> 所有者：frontend-core（task-5）｜ 范围：`web/**`（除 `web/src/export/**`、`web/src/themes/**`）、`scripts/build-marp-browser.mjs`、本文件
> 接口唯一依据：[`docs/API_CONTRACT.md`](../API_CONTRACT.md) ｜ 产品计划：[`docs/PROJECT_PLAN.md`](../PROJECT_PLAN.md) §6 ｜ 渲染实测：[`docs/research/marp-tech.md`](../research/marp-tech.md) §2/§3/§6

## 1. 技术栈与产物

- Vite 7 + Vue 3（`<script setup>`）+ TypeScript + CodeMirror 6 + vue-router。
- marp 渲染：`@marp-team/marp-core@4.4.0` 在**浏览器端**运行（esbuild 打成 IIFE，`web/public/marp-core.browser.js`）。
- 导出：前端只负责渲染出 `{html, css, comments}` 并交给导出面板（export-eng）；PDF/PPTX 生成在 Rust 服务端。
- 构建产物：`web/dist/`（`index.html` + `assets/*` + `marp-core.browser.js` + `katex/fonts/*`），由 Rust 服务 `rust-embed` 内嵌。

## 2. 快速开始

```powershell
# 0) 一次性：安装前端依赖（首次需批准 esbuild 的安装脚本，否则 pnpm 会报 ERR_PNPM_IGNORED_BUILDS）
pnpm --dir web install
pnpm --dir web approve-builds esbuild     # 只需一次；之后 install 退出码为 0

# 1) 构建 marp-core 浏览器包（输出 web/public/marp-core.browser.js + katex 字体）
pnpm run build:marp          # = node scripts/build-marp-browser.mjs（约 50–80s，3.67MB min / 1.14MB gzip）

# 2) 构建前端
pnpm --dir web build         # 产物 web/dist/

# 3) 开发（不依赖后端：内置 mock API）
pnpm --dir web dev           # http://localhost:5173  （dev 且无 token 时自动 mock）

# 4) 开发（连真实 Rust 服务）
$env:MWB_DEV_BACKEND='http://127.0.0.1:8899'   # 先启动服务并拿到端口
pnpm --dir web dev:real      # 浏览器地址要带真实 token：http://localhost:5173/?token=xxx
```

- marp bundle 全局约定（契约 §2.2）：`window.MarpCoreBundle.MarpCore = { Marp, browser }`。
  - 入口：`web/build/marp-browser-entry.js`；构建脚本：`scripts/build-marp-browser.mjs`。
  - 脚本从 `web/node_modules` 解析 esbuild（根目录无需安装依赖）。
- 首次 `pnpm --dir web install` 若出现 `ERR_PNPM_IGNORED_BUILDS`：执行 `pnpm --dir web approve-builds esbuild` 即可（已记入 `web/pnpm-workspace.yaml` 的 `onlyBuiltDependencies`，但本机 pnpm 12 仍需显式审批一次）。

## 3. 目录结构（web/）

```
web/
├─ index.html
├─ vite.config.ts            # base '/'，dev:real 时把 /api 代理到 MWB_DEV_BACKEND
├─ public/
│  ├─ marp-core.browser.js   # 构建期生成（git 忽略）
│  └─ katex/fonts/*.woff2    # 构建期生成：离线 KaTeX 字体（20 个，254KB）
├─ build/marp-browser-entry.js
├─ scripts/verify-ui.mjs     # 无头 Chrome 验收脚本（见 §7）
└─ src/
   ├─ main.ts / router.ts / App.vue / types.ts
   ├─ api/
   │  ├─ client.ts           # token 引导、fetch 封装、mock 开关
   │  ├─ index.ts            # 契约 API 封装
   │  ├─ mock.ts             # 纯前端 mock API（localStorage 持久化）
   │  └─ errors.ts           # ApiError / readableError
   ├─ marp/
   │  ├─ renderer.ts         # 单例 Marp 实例、主题注册、CSS/HTML 清洗、render()
   │  ├─ frontmatter.ts      # theme 读写、页数/光标页计算、Marp 文档识别
   │  └─ templates.ts        # 新建模板（blank/title/sample）
   ├─ editor/
   │  ├─ CodeMirrorEditor.vue
   │  └─ pageSeparator.ts    # `---` 分页线与「第 N 页」标注
   ├─ preview/PreviewPane.vue # iframe srcdoc + browser() + 当前页同步 + 缩放
   ├─ integrations/optionalComponents.ts # 懒加载 ThemeGallery/ExportPanel（glob，文件出现即挂载）
   ├─ stores/app.ts          # 全局状态 + toast + 主题列表 + bootstrap
   ├─ views/{HomeView,EditView,SettingsView}.vue
   ├─ components/ToastHost.vue
   ├─ utils/format.ts
   └─ styles/main.css
```

## 4. marp 渲染（前端唯一渲染源）

### 4.1 加载与配置

```ts
// src/marp/renderer.ts（节选）
const core = await loadMarpCore() // 动态 <script src="/marp-core.browser.js">
const marp = new core.Marp({
  html: true,
  script: false,                            // 关键：不注入内联 helper 脚本
  minifyCSS: true,
  math: { lib: 'mathjax', katexFontPath: '/katex/fonts/' }, // 默认 MathJax；katex 用本地字体
  emoji: { shortcode: true, unicode: false },               // 不用 twemoji CDN
})
marp.themeSet.add(css)   // 服务端 GET /api/themes/:name/css（+ sanitize 外链）
const { html, css, comments } = marp.render(markdown)
```

- `render()` 后统一清洗：`<script>` 全部移除；CSS 里 `@import http(s)…` / `url(http…)` 替换掉 → **0 外网请求**（离线验收）。
- 主题未注册时只把“本次渲染”回退到 `default`，**不改用户 front-matter**；状态栏/toast 提示。
- `comments[i]` 即第 i 页备注（`string[]`，契约导出用）。

### 4.2 预览（iframe srcdoc）

- `PreviewPane.vue` 把 `<!DOCTYPE html><style>${css}</style>${html}` 写入 iframe `srcdoc`，保证 marp-core 需要的 DOM 环境与主题 CSS 隔离。
- `script:false` 时必须手动应用 helper：iframe `load` 后在 iframe 内注入一段脚本调用 `parent.MarpCoreBundle.MarpCore.browser(document.body)`（并在父窗口再兜底调用一次）——否则 fit 标题/代码自动缩放不生效。
- 预览容器加了 CSP meta（`default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:`)：外部图片/字体被浏览器直接拦截，离线验收的第二道保险。
- 缩放：默认「适应宽度」；可切 100% / ±10%；`transform: scale()` 作用在 iframe 上，不改 iframe 内布局。
- 当前页同步：编辑器光标行 → `slideIndexAtLine()` → `iframe.contentDocument` 里对应 `svg[data-marpit-svg]` `scrollIntoView()`。

### 4.3 主题

- 主题列表 = marp 内置（default/gaia/uncover）+ 服务端 `GET /api/themes` 列出的主题；
  对每个主题逐个 `GET /api/themes/:name/css` → `sanitizeCss()` → `themeSet.add()`。
  - ⚠️ **`ThemeMeta.css` 的语义是「服务端是否内联 CSS」**（契约 §1.5），M1 服务端统一返回 `false`，意思是 CSS 需要单独 `GET /api/themes/:name/css` 拉取，**不是“没有 CSS”**——曾因误读该字段导致 6 套自定义主题从未注册、全部回退 default（Lead 联调发现，已修复）。
  - ⚠️ 主题 CSS 的元信息普遍是**多行注释**（`/*\n * @theme tech-dark\n */`），注册校验正则不能用 `\/\*\s*@theme` 的严格形式，已改为 `/@theme\s+[A-Za-z0-9_-]+/` 的宽松匹配。
- 切换主题 = 改 front-matter `theme:` → 重新 `render()`（热渲染约 27–100ms）。
- 主题画廊：`web/src/themes/ThemeGallery.vue`（themes 成员）通过 `import.meta.glob` 自动挂载；传入 props：
  `themes, current, markdown, render(themeName) => ({html, css})`，监听 `select`（另有 `preview`/`preview-end` 试穿）。

## 5. 数据流与交互（契约 §2.4）

- 打开：`GET /api/decks/:id` → CodeMirror + 立即渲染；`localStorage['mwb.lastDeckId']` 记录，首页「继续上次编辑」。
- 自动保存：内容变化 800ms 防抖 `PUT /api/decks/:id`（带 `ifRev`）；每 30s 若仍 dirty 再强刷；`Ctrl+S` 立即保存（捕获阶段拦截浏览器默认）。
- 409：显示顶部冲突条，可「重新加载（丢弃我的修改）」或「强制覆盖保存」。
- `Ctrl+P` 拦截 → 打开导出面板。
- `beforeunload` 仅在 dirty 时提示。
- 所有 API 错误经 `readableError()` 转中文 toast / 页面错误态，不白屏。

## 6. API 与联调

- 启动：`main.ts` 读 `?token=` → `sessionStorage('mwb.token')` → `history.replaceState` 清掉地址栏 token。
- `api()` 统一加 `X-MWB-Token`；错误转 `ApiError`（`code/status/message`）。
- **mock 模式**（后端未就绪 / 单跑前端）：URL 带 `?mock=1`、或构建时 `VITE_MWB_MOCK=1`、或 vite dev 且无 token 时自动启用。
  mock 覆盖契约 §1.1–1.5（workspace/decks/settings/themes/recent），数据存 localStorage；导出接口明确报 `EXPORT_FAILED`，不假装成功。
- **真实服务**：`web/dist` 由 Rust 服务内嵌并直接访问（服务启动 URL 自带 token），无需 vite 代理；
  dev 联调用 `pnpm --dir web dev:real` + `MWB_DEV_BACKEND`。服务可固定端口便于联调：
  `MWB_NO_OPEN=1 MWB_PORT=8899 MWB_DATA_DIR=<临时目录> MWB_WEB_DIR=<repo>/web/dist server.exe`（会打印 `MWB_LISTEN_URL`/`MWB_TOKEN`）。

## 7. 验收脚本（无头 Chrome）

```powershell
# 前置：已 pnpm --dir web build；本机有 Chrome/Edge
# a) mock 模式（自动起 vite preview）
node web/scripts/verify-ui.mjs
# b) 对已运行的服务（真实 Rust 或 vite preview）
node web/scripts/verify-ui.mjs --url http://127.0.0.1:5199
# c) 对真实 Rust 服务（token 由服务启动日志给出）
node web/scripts/verify-ui.mjs --url http://127.0.0.1:8899 --token <hex token>
```

检查项：首页加载（deck 列表/MOCK 徽标）、新建空白→进入编辑器、预览 iframe 页数与分页输入更新、自动保存状态、Ctrl+S、**主题切换实际生效（预览背景变化 + 无“未加载/回退”toast）**、主题画廊挂载与缩略图 iframe 有内容（srcdoc）、Ctrl+P、导出面板挂载、设置页、**零外网请求**。截图与 `report.json` 写到 `%TEMP%\mwb-verify\`。

实测结果：

| 场景 | 结果 |
| --- | --- |
| mock（vite preview + Chrome 155） | **15/15 通过**，无 console error，外网请求 0 |
| 真实 Rust release exe（`MWB_NO_OPEN=1 MWB_PORT=8899 MWB_WEB_DIR=...`） | **15/15 通过**；主题从 business-blue 切到 default 后预览背景确实变化；设置页/导出面板/画廊均可用；外网请求 0 |
| Lead 的 `node scripts/visual-e2e.mjs`（真实 exe + PPTX 真实导出） | **12/13**；唯一失败的“画廊缩略图按主题渲染（有内容）”是**断言口径问题**：画廊缩略图是 `<iframe class="tg-frame" :srcdoc="...">`，iframe 的 `innerHTML` 按规范恒为空（实测 `srcdocLens=[57090,57866,57338,56692]`、`innerHtmlLens=[0,0,0,0]`）；应改查 `getAttribute('srcdoc')` 或 `contentDocument`。截图 `spike/visual/2026-10-20T06-15-47/03b-gallery-all.png` 中 9 套主题缩略图颜色/风格明显不同，`04-theme-tech-dark.png` 预览已变深色。 |

主题注册隔离回归：`node web/scripts/test-theme-register.cjs`（Node 侧用同样配置注册 `themes/*.css`，应输出 9 个已注册主题）。

## 8. 与其他成员的集成约定

| 组件 | 所有者 | 挂载方式 | props / emit |
| --- | --- | --- | --- |
| `web/src/export/ExportPanel.vue` | export-eng | `import.meta.glob` 懒加载；编辑器顶栏「导出」按钮打开外层 modal | props：`deckId, title, markdown, render(): {html,css,comments}`；emit：`close`、`done(fileName)` |
| `web/src/themes/ThemeGallery.vue` | themes | 同上；顶栏「主题画廊」按钮打开外层 modal | props：`themes, current, markdown, render(themeName): {html,css}`；emit：`select(name)`、`preview(name)`、`preview-end` |

两个目录的文件**尚未出现时构建也不会失败**（glob 返回空），文件落盘后重新 `pnpm --dir web build` 自动生效，无需改前端核心代码。

## 9. 已知限制 / 后续（M1 边界）

- 首页「新建」提供空白/示例两个入口（`title` 模板已在 API 层支持，UI 暂未加按钮）。
- 主题画廊的 hover 试穿已接 `preview/preview-end`（当前实现为预览覆盖渲染，不落盘）。
- 导出质量/进度依赖 export-eng 面板与服务端；mock 模式下导出不可用（预期）。
- 演讲者模式、历史快照为 M3 范围；大纲/缩略图、图片粘贴、属性面板、格式工具栏已在 M2 完成（见 §10）。
- **真实 Rust 服务联调已通过**（release exe + Chrome 自动化，见 §7 表格）；Lead 的 visual-e2e 唯一失败项为断言口径问题（详见 §7），非产品缺陷。
- 契约偏差记录：实测 `GET /api/health` 在服务端也要求 `X-MWB-Token`（契约 §0.3 写的是唯一免鉴权端点）；前端 `api()` 始终带 token，因此不影响使用，待 Lead 与 server-core 决定是否放宽。

---

## 10. M2 增量：属性面板 / 工具栏 / 插入器 / 左右侧栏（frontend-core）

> 契约：[`docs/UI_CONTRACT_M2.md`](../UI_CONTRACT_M2.md)（§2.2/§2.7/§2.8 归本文件 owner）｜ 本文只记录"怎么实现、怎么验"

### 10.1 新增/修改文件（都在 frontend-core 写范围）

| 文件 | 说明 |
| --- | --- |
| `web/src/marp/frontmatter.ts` | **M2 扩展**：通用 front-matter 读写、页内指令、页首插入、图片指令解析/替换（详见 10.2） |
| `web/src/editor/CodeMirrorEditor.vue` | 新增契约 §2.7 EditorApi（focus/getCursorLine/setCursor/scrollToLine/insertText/format/undo/redo）；外部 modelValue 更新改为**最小 diff**，属性面板改 markdown 时光标/滚动不跳 |
| `web/src/editor/types.ts` | 共享 `FormatCommand` / `EditorApi` 类型（避免从 .vue 导出类型） |
| `web/src/insert/EditorToolbar.vue` | 格式工具栏（H1/H2/H3、B/I/S、列表/引用、行内代码/代码块/公式/分页、图片/表格、撤销/重做）；emit `format / openImage / openTable / undo / redo` |
| `web/src/inspector/PropertyInspector.vue` | 属性面板（契约 §2.2 全部字段）；所有操作只产出标准 Marp Markdown |
| `web/src/views/EditView.vue` | 新布局：顶部工具栏 + 左大纲栏 + 中编辑/预览 + 右属性栏；挂载全部 M2 组件；粘贴/拖拽图片快捷路径 |
| `web/src/preview/PreviewPane.vue` | M2：`assets/x.png` 相对图片在预览里解析为 blob/data URL（`<base href="about:blank">` 防 404；CSP 不变） |
| `web/src/integrations/optionalComponents.ts` | 增加 SlideNavigator / ImageInsertDialog / TableInsertDialog / ThemeEditor 的 glob 懒加载 + pasteDrop 动态加载 |
| `web/src/api/client.ts`、`web/src/api/index.ts`、`web/src/api/mock.ts`、`web/src/types.ts` | `uploadAsset`（multipart，FormData 不手写 Content-Type）、`fetchDeckAssetBlob`、主题 CRUD API；mock 模式补齐用户主题 CRUD 与图片资产（dataURL 存储，dev 单跑可验证） |
| `web/src/styles/main.css` | M2 布局：`.editor-body` 四区网格、侧栏折叠过渡、1280–1920 适配、≤1080 隐藏侧栏 |

### 10.2 frontmatter.ts 新增函数（自测脚本：`web/scripts/test-frontmatter.ts`）

```ts
getFrontMatterData(md)                                   // 扁平字段
setFrontMatterField(md, key, value|null)                  // null 删除；保留未知字段/顺序/注释
setSlideDirective(md, page, key, value|null)              // 页首 <!-- _key: value -->（支持多行注释块）
getSlideDirective(md, page, key)
pageStartLine(md, page)                                   // 页内容第一行（1-based，跳过页首空行/指令）
insertAtPageStart(md, page, snippet)                      // 插到已有页首指令之后、正文之前
findImageDirectives(md)                                   // [{page, raw, path, modifiers[], offset, line}]
replaceImageDirective(md, offset, newRaw|null)
getPageBackground(md, page) / buildImageDirective(path, modifiers)
```

- 值含 `:`、`#`、`*` 等会被自动加引号；header/footer 换行会被合并成单行（避免生成非法 YAML）。
- 代码围栏内的 `---` 不会被误判为分页；删除页内指令后会清理连续空行。
- 自测：`node --experimental-strip-types web/scripts/test-frontmatter.ts`（45+ 断言，全部通过）。

### 10.3 属性面板行为要点

- 主题下拉 + 「主题画廊」「编辑主题」；尺寸 16:9/4:3；页码全局 Toggle + 本页三态；页眉/页脚全局输入 + 「仅本页」覆盖 + 清空；全局 class（lead/invert/center + 自定义）；本页 class（单选 + 自定义 + 清除）；本页背景图（适配 cover/contain/fit + 透明度滑杆 + 更换/移除）。
- 文本输入在 **change/Enter（失焦）** 时写入，避免每敲一个字重排全文/来回同步；chips/开关/滑杆即时写入。
- 每次修改只 emit 一次 `update(markdown)`；EditView 侧：`content = md` → 800ms 防抖保存 → 重渲染；CodeMirror 最小 diff 保持光标。
- 空 deck 提供「补齐 Marp 基础设置」（写入 `marp: true`）。
- 页眉输入含换行会被 frontmatter 合并单行；本页 class 写入 `<!-- _class: xxx -->`（页首）。

### 10.4 图片相关

- 上传：`uploadAsset(deckId, file)`（multipart，字段 `file`）→ Markdown 只写**相对路径** `assets/x.png`（标准 Marp，可拷回 VS Code/marp-cli）。
- 预览：`PreviewPane` 用 `fetchDeckAssetBlob`（带 token）取回 blob → objectURL，替换 iframe 内 `<img src="assets/...">` 与 `<figure style="background-image:url(assets/...)">`（marp 背景图渲染在 section 内 figure 上）；mock 模式直接用 dataURL。Markdown 不变。
- 快捷路径：`attachImagePasteDrop(editorPane, {onFiles})`（export-eng 的 pasteDrop.ts，动态 import，文件缺失时安全跳过）→ 上传 → 插入图片；**marp-core 4.4 不支持 `![w:60%]`（百分比不生效）**，改用 `pasteDrop.pasteImageSnippet(path)`（换算成 `![w:768px]`）。
- 导出侧（export-eng）已在打印/PPTX/HTML 前内联 deck 资产，本前端无需处理。

### 10.5 新组件挂载约定（全部 `import.meta.glob` + v-if 容错，文件缺失不炸构建）

| 组件 | props / emit |
| --- | --- |
| `web/src/outline/SlideNavigator.vue` | props：`markdown/html/css/pageCount/currentPage/width/height`；emit `jump(page, line?)` → `editor.setCursor(line ?? pageStartLine(page))` + 滚动 |
| `web/src/insert/ImageInsertDialog.vue` | props：`deckId/markdown/currentPage/initialMode`；emit `insert({snippet, mode})`/`close`；image → 光标插入，background → `insertAtPageStart` |
| `web/src/insert/TableInsertDialog.vue` | props：`markdown/currentPage`；emit `insert(snippet)`/`close` → 光标处 block 插入 |
| `web/src/themes/ThemeGallery.vue` | props 增加 `initialEditTheme`（属性面板「编辑主题」→ 自动打开 ThemeEditor）；emit 增加 `changed` → EditView 调 `refreshThemes()` 并重渲染 |
| `web/src/themes/ThemeEditor.vue` | 由 ThemeGallery 内部挂载（EditView 不直接挂） |

### 10.6 布局与交互

- 顶栏新增「◧ 大纲」「属性 ◨」折叠按钮；折叠状态存 `localStorage['mwb.edit.leftOpen'|'mwb.edit.rightOpen']`（'0' = 折叠）。
- 左栏 240–300px（大纲/幻灯片 tab 由 SlideNavigator 自管）；右栏 270–300px；中间编辑/预览对半，拖宽自适应；≤1080 宽自动隐藏两侧栏。
- 工具栏固定顶栏下方；状态栏保留页码/rev/快捷键提示/版本。
- `Ctrl+B` 在编辑区加粗；`Ctrl+S`/`Ctrl+P` 逻辑不变。

### 10.7 M2 验收实测

| 场景 | 结果 |
| --- | --- |
| `pnpm --dir web build` | ✅ 通过（含 outline/insert/themes 队友组件；EditView chunk ~652KB，懒加载分包正常） |
| 对真实 Rust release exe（`MWB_WEB_DIR=web/dist`，Chrome 155）跑 `node web/scripts/verify-ui.mjs` | ✅ **33/33 步通过**：M1 全部项 + 工具栏(17 按钮)/左栏 SlideNavigator/属性面板/加粗/尺寸写回+viewBox 变 960×720/页眉/全局 class/本页 class/图片上传+背景图 `![bg left:40%]`/背景图预览 blob 解析/表格 3×3 GFM/粘贴图片快捷插入/侧栏折叠记忆/零外网请求 |
| Lead `node scripts/visual-e2e.mjs` | ✅ **13/13**（15 套主题出现在画廊，缩略图主题渲染、切换写回、PPTX 2.8MB 导出均通过） |
| `node web/scripts/verify-theme-editor.mjs <url> <token>` | ✅ 属性面板「编辑主题」→ 画廊打开 → ThemeEditor 自动打开（CSS 编辑器 + 实时预览 + 「新建主题」）；15 个主题出现在下拉 |
| 截图 | `%TEMP%\mwb-verify\edit-m2.png`（新布局）、`edit-m2-after.png`（背景图/表格/页眉/class 生效）、`%TEMP%\mwb-theme-editor\theme-editor.png` |

### 10.8 M2 已知边界

- 属性面板文本输入是「失焦/回车生效」（不是每次按键），避免与编辑器双向同步抖动；chips/开关/滑杆即时。
- 「编辑主题」实际动作 = 打开主题画廊并传 `initialEditTheme`，由 ThemeGallery 内部挂载 ThemeEditor；若主题组件未就绪则 toast 提示。
- 主题编辑器保存后由 ThemeGallery emit `changed` → 前端刷新主题列表；若自定义主题 CSS 变化，当前 deck 需重新渲染（`refreshThemes()` 后已自动 doRender）。
- 图片预览的 objectURL 未显式 revoke（数量小；后续可加 LRU 清理）。

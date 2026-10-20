# 主题系统开发文档（themes / M1→M2）

> 负责人：themes（原 ux-competitors）｜更新：2026-10-20（M2 完成）｜对应任务：task-7 / task-10
> 上游依据：`docs/API_CONTRACT.md` §3 / §2.2、`docs/UI_CONTRACT_M2.md` §2.5/§2.6/§4、`docs/PROJECT_PLAN.md` v1.1 §5、`docs/research/ux-competitors.md` §4
> 交付物：`themes/*.css`（**12 套原创**）+ `themes/index.json` + `web/src/themes/{ThemeGallery.vue, ThemeEditor.vue, useThemes.ts}` + 本文件

---

## 1. 交付清单（12 套内置主题）

| # | 主题（@theme） | 中文名 | 适用场景 | CSS 体积 | 文件 |
|---|---|---|---|---|---|
| 1 | `business-blue` | 商务蓝 | 工作汇报、方案评审（**默认主题**，计划 D6） | 6.4 KB | `themes/business-blue.css` |
| 2 | `tech-dark` | 科技深色 | 技术分享、架构评审、暗环境投屏 | 7.3 KB | `themes/tech-dark.css` |
| 3 | `academic-white` | 学术白 | 论文答辩、课程讲义（三线表 + 衬线标题） | 6.7 KB | `themes/academic-white.css` |
| 4 | `minimal-gray` | 极简灰 | 通用场合，不知道选什么就用它 | 6.1 KB | `themes/minimal-gray.css` |
| 5 | `magazine` | 杂志排版 | 产品发布、运营方案、品牌故事 | 7.2 KB | `themes/magazine.css` |
| 6 | `gradient-vivid` | 渐变活力 | 路演、创意提案、校招宣讲 | 7.0 KB | `themes/gradient-vivid.css` |
| 7 | `startup-orange` | 创业橙 | 创业路演、融资 BP、项目启动会 | 6.9 KB | `themes/startup-orange.css` |
| 8 | `data-teal` | 数据青 | 数据汇报、季度复盘（等宽数字 + 强表格） | 7.0 KB | `themes/data-teal.css` |
| 9 | `dark-neon` | 暗夜霓虹 | 发布会、品牌活动、暗场氛围 | 7.5 KB | `themes/dark-neon.css` |
| 10 | `paper-warm` | 暖纸 | 阅读型长文、课程讲义（衬线 + 宽行高） | 6.7 KB | `themes/paper-warm.css` |
| 11 | `chinese-ink` | 中国风水墨 | 国风/人文讲座、传统文化、诗词赏析 | 7.2 KB | `themes/chinese-ink.css` |
| 12 | `nature-green` | 自然绿 | 环保/自然科普、教育课程、健康生活 | 6.9 KB | `themes/nature-green.css` |

- 12 套均为**原创**（配色/版式为自研，未复制社区主题）；全部零外网资源（字体/图片 CDN 均无）。
- 中文字体一律系统栈：正文 `'Microsoft YaHei','PingFang SC','Hiragino Sans GB',...`；衬线 `Georgia,'Times New Roman','Songti SC','SimSun',serif`；代码 `'Cascadia Code','Consolas',monospace`。
- `themes/index.json`：`[{name, displayName, tags, category, file, description}]`，供构建/文档/画廊增强使用。**注意**：server-core 的 `/api/themes` 是扫描 `themes/*.css` 并解析注释（`assets::builtin_theme_files` 只取 `.css`），不读 index.json；两者内容保持一致。

### 1.1 M2 主题画廊 / 编辑器（`web/src/themes/`）

| 文件 | 能力 |
|---|---|
| `ThemeGallery.vue` | 12 套主题画廊：当前 deck 真实缩略图（iframe+scale，非截图）、搜索/分类/收藏/最近、`↑↓`/`Enter`/`Esc`、hover 试穿；**＋新建主题 / ＋导入主题（选择或拖拽 .css）/ 卡片 ⋯ 菜单（编辑、另存为、导出 CSS、删除）/"我的"徽标**；任何增删改后 `emit changed` 让父组件 `refreshThemes()` 刷新 |
| `ThemeEditor.vue` | 名称输入 + CSS 编辑（等宽、行号、滚动同步）+ 实时预览（独立 Marp 实例渲染当前 deck 前 2 页，**不污染正式主题列表**）+ `@theme` 名称校验（与名称一致，否则行内报错禁用保存）+ 另存为新主题 / 保存修改 / 关闭前确认 |
| `useThemes.ts` | 可选工具通道：`loadThemes / loadThemeCss / loadThemeCssMap / registerThemesInto / useThemes`（自包含 token 请求，不依赖 `api/client.ts`） |

## 2. 主题 CSS 规范（已实测确认）

每套主题的文件头**必须**是如下单块注释 + 紧随其后的真实 `@import`：

```css
/*
 * @theme business-blue        ← 必需且全文件唯一
 * @name 商务蓝                 ← 画廊显示名（可选，缺省用 theme 名）
 * @tags 商务,汇报,蓝色,浅色     ← 画廊分类/搜索（可选）
 * @size 16:9 1280px 720px      ← 画布尺寸（本批统一 16:9）
 * @auto-scaling true           ← 标题/代码自动缩放
 */
@import 'default';               ← 必须是真实 CSS at-rule，不能写在注释里！
```

> ⚠️ **实测发现（重要，建议 Lead 更新 `API_CONTRACT.md` §3 示例）**：契约 §3 示例写的是 `/* @import 'default'; */`（注释形式）。
> 用 marp-core 4.4.0 实测：注释里的 `@import` 只会被解析成 `meta.import` 文本，**default 主题不会真正加载**（`theme.importRules` 为空），
> 后果是基础排版/代码高亮/页码等规则全部缺失。正确写法是**注释块之外的真实 `@import 'default';`**。
> 前端 sanitize（`web/src/marp/renderer.ts`）只清 http(s) 外链、不会误删 `@import 'default'`，安全。

**每套主题必须带的三段"兼容重置"**（位于文件末尾，12 套统一；M2 实测踩坑后补，删掉会出问题）：

```css
/* 1) marp default 主题给 tr 设了白底/边框，会盖住主题底色（深色主题出现白条） */
section table tr,
section table tr:nth-child(2n) { background-color: transparent; border-top: 0; }

/* 2) 720px 画布 + flex column 下，pre/table 会被 flex 压缩导致代码块尾部被裁切 */
section > * { flex-shrink: 0; }

/* 3) 行内数学/模板字符串被 hljs 标成 .hljs-subst，default 变量是浅色主题色，需继承主题代码色 */
section pre code .hljs-subst { color: inherit; }
```

另加：统一的标题平衡换行 `section h1/h2/h3, section.lead h1/h2 { text-wrap: balance; }`（避免封面长标题掉单字）；
深色主题额外覆盖 `.hljs-keyword/.hljs-string/.hljs-comment/.hljs-number/.hljs-title` 等 token 颜色，保证在深底上的对比度。

每套主题覆盖（`API_CONTRACT.md` §3 要求）：`section`（背景/字体/字号/padding/行高）、`section.lead`（封面）、`h1/h2/h3`、`p/li/strong/a`、`code`（行内）、`pre`（代码块背景/圆角/字号）、
`table/th/td`、`blockquote`、`header`/`footer`、页码 `section::after`；深色主题内声明 `print-color-adjust: exact`。

`web/src/marp/renderer.ts` 注册主题时会校验 `/* @theme`，12 套均通过；marp-core 会把主题选择器自动 scope 到
`div.marpit > svg > foreignObject > section`，不会污染工作台 UI 的全局样式（已实测最终 CSS）。

## 3. 真实渲染验证（不是"只写 CSS 不看效果"）

**方法**：`node spike/themes/render-themes.mjs`
- 用 `spike/marp` 已装的 `@marp-team/marp-core@4.4.0` 同一实例注册 12 套主题；
- 对同一份 5 页样例 deck（`spike/themes/sample-deck.md`：封面 / 中文+列表+引用 / 代码块 / 表格 / 收尾）逐个主题渲染；
- 用本机 Chrome（`puppeteer-core`）逐页截图；截图默认按 marp **静态输出**渲染（设 `SPIKE_HELPER=1` 可注入 browser helper 验证 auto-scaling）。

**结果（`spike/themes/out/render-report.json`，12/12 通过）**：

| 主题 | 元信息解析 | @import default | 外链数 | 5 页渲染耗时* | 内容检查 |
|---|---|---|---|---|---|
| business-blue | ✅ name/tags/size | ✅ | **0** | 1611ms（冷启动） | ✅ 封面/中文/代码/表格/引用/页码 |
| tech-dark | ✅ | ✅ | **0** | 254ms | ✅ |
| academic-white | ✅ | ✅ | **0** | 242ms | ✅ |
| minimal-gray | ✅ | ✅ | **0** | 149ms | ✅ |
| magazine | ✅ | ✅ | **0** | 313ms | ✅ |
| gradient-vivid | ✅ | ✅ | **0** | 167ms | ✅ |
| startup-orange | ✅ | ✅ | **0** | 160ms | ✅ |
| data-teal | ✅ | ✅ | **0** | 193ms | ✅ |
| dark-neon | ✅ | ✅ | **0** | 162ms | ✅ |
| paper-warm | ✅ | ✅ | **0** | 131ms | ✅ |
| chinese-ink | ✅ | ✅ | **0** | 153ms | ✅ |
| nature-green | ✅ | ✅ | **0** | 126ms | ✅ |

\* 首次渲染含 default 主题解析/冷启动；应用内主题热切换实测 27–31ms（`marp-tech.md`）。
内容检查项：`slideCount=5`、中文正常、代码块（hljs）、表格、引用、header/footer、pagination；主题样式命中（section/lead/pre/table/blockquote/页码/页眉页脚）全部通过。

**打印背景抽查（深色/渐变主题，`node spike/themes/print-check.mjs`）**：按导出打印页规则（`@page{size:1280px 720px;margin:0}` + `print-color-adjust:exact` + 逐页 `break-after`）无头打印 + 解析 PDF 内容流：

| 主题 | PDF 页数 | 页面尺寸 | 结论 |
|---|---|---|---|
| dark-neon | 5 | 960×540pt | 内容流含 `0.0314 0.0235 0.0588 rg`（=`#08060f` 近黑底），**深色背景真实打印** |
| startup-orange | 5 | 960×540pt | 内容流含 `0.4863 0.1765 0.0706 rg`（`#7c2d12` 深棕底），渐变打印正常 |
| chinese-ink / paper-warm / data-teal / nature-green | 5 | 960×540pt | 浅色主题分页/尺寸精确（960×540pt = 1280×720px） |
| tech-dark / gradient-vivid | 5 | 960×540pt | 深色底/渐变停靠色进入内容流（M1 已验证） |
| 产物 | — | — | `spike/themes/out/print-<theme>.pdf` + `print-check.json` |

**截图位置（供 Lead/UI 验收）**：
- 12 套主题总览（封面 + 内容页）：`spike/themes/shots/overview.png`
- 12 套主题细节（代码页 + 表格页）：`spike/themes/shots/overview-detail.png`
- 单主题逐页原图：`spike/themes/shots/<theme>/slide-01..05.png`
- M2 UI 截图：`spike/themes/shots/m2-gallery.png`（画廊 15 卡 + 分类/操作）、`spike/themes/shots/m2-theme-editor.png`（新建主题 + 实时预览）

**重新生成**：`node spike/themes/render-themes.mjs`（约 45s）→ `node spike/themes/print-check.mjs`（约 20s）。

### 3.1 真实服务 / UI 端到端验证（M2 新增）

| 脚本 | 覆盖 | 结果 |
|---|---|---|
| `node spike/themes/api-smoke.mjs` | 启动真实 `MarpWorkbench.exe`（隔离数据目录）→ `GET /api/themes`（**12 套内置**、displayName/tags/size 解析）→ `POST` 导入 → `GET css` → `PUT` 保存 → 校验生效 → 非法 CSS（缺 @theme）400 → `DELETE` → 列表恢复 12 套 | **10/10 通过**（同时验证 rebuilt exe 已内嵌 12 套主题） |
| `node spike/themes/editor-e2e.mjs` | Chrome 打开真实 UI：主题画廊（全部 Tab 15 卡=12 内置+3 Marp 原生）→ 新建主题编辑器（名称/CSS/实时预览 srcdoc 57KB）→ 改 @theme 名 → 另存为副本（POST）→ 关闭编辑器 → 文件选择导入 .css（POST）→ "我的"徽标 → 无 JS 错误；截图 m2-gallery / m2-theme-editor | **8/8 通过** |

> 说明：`editor-e2e.mjs` 默认用磁盘 `web/dist` + `themes/`（`MWB_WEB_DIR`/`MWB_THEMES_DIR`，改前端/主题后无需重编 exe 即可回归）；加 `--embedded` 测内嵌资源版 exe。

## 4. 前端集成（与 frontend-core 的接口）

### 4.1 ThemeGallery 挂载（EditView.vue 已按此实现）

```vue
<ThemeGallery
  :themes="app.themes"                      <!-- ThemeMeta[] -->
  :current="currentTheme"
  :markdown="content"
  :render="renderForGallery"                <!-- (themeName) => {html, css} -->
  :initial-edit-theme="themeEditorName || undefined"  <!-- M2：属性面板「编辑主题」入口 -->
  @select="applyTheme"
  @preview="previewTheme"
  @preview-end="endPreviewTheme"
  @changed="onThemesChanged"                <!-- M2：主题增删改后 refreshThemes() + 重渲染 -->
/>
```

- **CSS 注册归 frontend-core**（`stores/app.ts#refreshThemes` + `renderer.registerTheme`）；Gallery 只消费 metadata/选择事件，并用 `renderer.getThemeCss()` 兜底读取 CSS。
- **保存/导入/删除**由 Gallery 直接调用 `web/src/api/index.ts` 的 `createTheme/saveTheme/deleteTheme/getThemeCss`（marp-tech 提供，M2 已落地）：新建/另存 → `POST /api/themes`；编辑我的主题 → `PUT /api/themes/:name`；删除 → `DELETE`（confirm 确认）；导出 CSS → Blob 下载。
- 主题编辑器由 Gallery **内部挂载**（全屏 overlay，z-index 70），EditView 只需传 `initialEditTheme`，减少父组件状态。
- `emit changed` 由父组件监听后 `refreshThemes()`——新增主题要等注册进 marp 实例后缩略图才可渲染；Gallery 在此期间显示色板占位，不报错。

### 4.2 useThemes.ts（可选工具通道）

frontend-core 已有完整主题数据流（`api/index.ts` + `stores/app.ts`），本文件是自包含备用通道（不 import 他人模块，自带 token/请求头），用于缩略图兜底、独立页面或测试：

```ts
import { loadThemes, loadThemeCss, loadThemeCssMap, registerThemesInto, useThemes } from './themes/useThemes'
const themes = await loadThemes()                 // GET /api/themes
const css = await loadThemeCss('business-blue')   // GET /api/themes/:name/css
const map = await loadThemeCssMap(themes)         // 并发拉取，失败跳过
registerThemesInto(marpInstance, map)             // marp.themeSet.add，返回 {registered, failed}
```

## 5. 已知问题与跨组提醒（重要）

1. **`@import 'default'` 必须是真实 CSS 规则**（见 §2）。契约 §3 的注释形式示例在 marp-core 4.4.0 下不生效，建议 Lead 更新契约示例。
2. **导出打印页需要 marp-core browser helper**：auto-scaling（标题/代码缩放）、数学渲染等都是 `browser()` 运行时能力，**静态 HTML 里不生效**。预览侧 frontend-core 已调用 `applyBrowserHelper`；export-eng 的打印页若不执行 helper，内容较多的页可能被裁切。已同步 lead + export-eng。
3. 自定义主题的 `Theme.width/height` 为 `undefined`（marp-core 实测），画廊/导出应读 `meta.size` 或渲染结果 `viewBox`。
4. 服务端 `parse_theme_meta` 兼容单行/块注释；`@tags` 支持中英文逗号/空格分隔；12 套已验证可解析出 `displayName/tags/size/autoScaling`。
5. **服务端导入接口 JSON 字段**：`ThemeImportReq` 用 snake_case `file_name`；前端 `createTheme` 传的是 `fileName`（服务端会忽略并回退用 CSS 里的 `@theme` 名，功能不受影响）。若 M3 需要文件名参与命名，需统一字段。
6. **M2 修复的一个真机 bug**：文件导入时 `input.files` 是 live FileList，若先清空 `input.value` 再读取会导致列表为空、导入静默失败；Gallery 已改为先 `Array.from(input.files)` 再清空（由 E2E `editor-e2e.mjs` 发现）。
7. 深色主题打印背景：主题内已声明 `print-color-adjust: exact`，打印页仍需统一加（契约 §1.6 已要求）；PPTX 走截图通道不受影响。
8. 字体：只用系统字体，不打包字体文件（项目计划 §3.5 不变）；Windows 中文用雅黑/宋体、代码用 Consolas/Cascadia Code，macOS 回退 PingFang/Songti。
9. 主题在 exe 内嵌（rust-embed）是**构建期**行为：新增/修改 `themes/*.css` 后需重新 `cargo build --release` 才会进入分发包；开发期可用 `MWB_THEMES_DIR=themes` 走磁盘。

## 6. M2 完成情况 / M3 候选

- ✅ 12 套主题（M2 补齐 startup-orange / data-teal / dark-neon / paper-warm / chinese-ink / nature-green）
- ✅ 导入主题（选择 / 拖拽 .css → POST /api/themes → 刷新列表）
- ✅ CSS 主题编辑器（名称 + 代码 + 实时预览 + @theme 校验 + 另存为/保存）
- ✅ 卡片菜单：编辑（我的）/ 另存为（内置复制）/ 导出 CSS / 删除（我的）
- ✅ "我的"徽标、分类/搜索/收藏/最近/↑↓ 键盘/缩略图（M1 功能无回归；`visual-e2e` 13/13 + `editor-e2e` 8/8）
- M3 候选：主题包 `.marptheme`（CSS+元信息+预览图）导入导出、hover 大图预览、主题详情（配色小样/字体信息）、收藏/最近服务端持久化、主题可视化调参（主色/字号/字体滑杆）、主题市场。

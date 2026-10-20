# 主题系统开发文档（themes / M1）

> 负责人：themes（原 ux-competitors）｜更新：2026-10-20｜对应任务：task-7
> 上游依据：`docs/API_CONTRACT.md` §3 / §2.2、`docs/PROJECT_PLAN.md` v1.1 §5、`docs/research/ux-competitors.md` §4
> 交付物：`themes/*.css`（6 套原创）+ `themes/index.json` + `web/src/themes/{ThemeGallery.vue,useThemes.ts}` + 本文件

---

## 1. 交付清单

| 主题（@theme） | 中文名 | 适用场景 | CSS 体积 | 文件 |
|---|---|---|---|---|
| `business-blue` | 商务蓝 | 工作汇报、方案评审（**默认主题**，计划 D6） | 5.7 KB | `themes/business-blue.css` |
| `tech-dark` | 科技深色 | 技术分享、架构评审、暗环境投屏 | 6.6 KB | `themes/tech-dark.css` |
| `academic-white` | 学术白 | 论文答辩、课程讲义（三线表 + 衬线标题） | 6.0 KB | `themes/academic-white.css` |
| `minimal-gray` | 极简灰 | 通用场合，不知道选什么就用它 | 5.4 KB | `themes/minimal-gray.css` |
| `magazine` | 杂志排版 | 产品发布、运营方案、品牌故事 | 6.5 KB | `themes/magazine.css` |
| `gradient-vivid` | 渐变活力 | 路演、创意提案、校招宣讲 | 6.3 KB | `themes/gradient-vivid.css` |

- 6 套均为**原创**（配色/版式为本次设计，未复制社区主题）；全部零外网资源（字体/图片 CDN 均无）。
- 中文字体一律系统栈：正文 `'Microsoft YaHei','PingFang SC','Hiragino Sans GB',...`；衬线 `Georgia,'Times New Roman','Songti SC','SimSun',serif`；代码 `'Cascadia Code','Consolas',monospace`。
- `themes/index.json`：`[{name, displayName, tags, category, file, description}]`，供构建/文档/后续画廊增强使用。**注意**：server-core 的 `/api/themes` 是扫描 `themes/*.css` 并解析注释（`asset::builtin_theme_files` 只取 `.css`），不读 index.json；两者内容保持一致。

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

`web/src/marp/renderer.ts` 注册主题时会校验 `/* @theme`，本批 6 套均通过；marp-core 会把主题选择器自动 scope 到
`div.marpit > svg > foreignObject > section`，不会污染工作台 UI 的全局样式（已实测最终 CSS）。

每套主题覆盖（`API_CONTRACT.md` §3 要求）：`section`（背景/字体/字号/padding/行高）、`section.lead`（封面）、`h1/h2/h3`、`p/li/strong/a`、`code`（行内）、`pre`（代码块背景/圆角/字号）、
代码高亮 token（`.hljs-keyword/.hljs-string/.hljs-comment/.hljs-number/.hljs-title` 等，深色主题单独配霓虹色保证对比度）、`table/th/td`、`blockquote`、`header`/`footer`、页码 `section::after`。
另加统一的标题平衡换行：`section h1/h2/h3, section.lead h1/h2 { text-wrap: balance; }`（避免封面长标题掉单字）。

## 3. 真实渲染验证（不是"只写 CSS 不看效果"）

**方法**：`node spike/themes/render-themes.mjs`
- 用 `spike/marp` 已装的 `@marp-team/marp-core@4.4.0` 同一实例注册 6 套主题；
- 对同一份 5 页样例 deck（`spike/themes/sample-deck.md`：封面 / 中文+列表+引用 / 代码块 / 表格 / 收尾）逐个主题渲染；
- 用本机 Chrome（`puppeteer-core` + `C:\Program Files\Google\Chrome\Application\chrome.exe`）逐页截图；
- 截图默认按 marp **静态输出**渲染（不注入 browser helper，便于核对主题本身）；设 `SPIKE_HELPER=1` 可注入 marp-core browser helper，验证 auto-scaling 运行时行为。

**结果（`spike/themes/out/render-report.json`）**：

| 主题 | 元信息解析 | @import default | 外链数 | 5 页渲染耗时* | 内容检查 | 截图 |
|---|---|---|---|---|---|---|
| business-blue | ✅ name/tags/size 全通过 | ✅ | **0** | 1334ms（冷启动） | ✅ 4 类页全过 | 5 张 |
| tech-dark | ✅ | ✅ | **0** | 133ms | ✅ | 5 张 |
| academic-white | ✅ | ✅ | **0** | 108ms | ✅ | 5 张 |
| minimal-gray | ✅ | ✅ | **0** | 103ms | ✅ | 5 张 |
| magazine | ✅ | ✅ | **0** | 77ms | ✅ | 5 张 |
| gradient-vivid | ✅ | ✅ | **0** | 95ms | ✅ | 5 张 |

\* 首次渲染含 default 主题解析/冷启动；应用内主题热切换实测 27–31ms（`marp-tech.md`），本次 Node 侧单次渲染耗时仅作相对参考。
内容检查项：`slideCount=5`、中文正常、代码块（hljs）、表格、引用、header/footer、pagination 全部存在；主题样式命中检查（section/lead/pre/table/blockquote/页码/页眉页脚）全部通过。

**截图位置（供 Lead/UI 验收）**：
- 6 套主题总览（封面 + 内容页）：`spike/themes/shots/overview.png`
- 6 套主题细节（代码页 + 表格页）：`spike/themes/shots/overview-detail.png`
- 单主题逐页原图：`spike/themes/shots/<theme>/slide-01..05.png`
- 渲染成品 HTML（无 JS，可浏览器直接打开）：`spike/themes/out/<theme>.html`

**重新生成**：`node spike/themes/render-themes.mjs`（只读 `spike/marp/node_modules`，不需要额外安装；约 30s）。

**打印背景抽查（重点验证深色/渐变主题，`node spike/themes/print-check.mjs`）**：按导出打印页规则（`@page{size:1280px 720px;margin:0}` + `print-color-adjust:exact` + 逐页 `break-after`）用本机 Chrome 无头打印，并解析 PDF 内容流：

| 主题 | PDF 页数 | 页面尺寸 | 结论 |
|---|---|---|---|
| tech-dark | 5 | 960×540pt（=1280×720px） | 内容流含 `0.0431 0.0627 0.1255 rg`（=`#0b1020` 深色底），**深色背景真实打印** |
| gradient-vivid | 5 | 960×540pt | 内容流含 `#4f46e5 / #7c3aed / #be185d` 等渐变停靠色，**渐变背景真实打印** |
| business-blue / academic-white | 5 | 960×540pt | 浅色对照：分页与尺寸精确 |
| 产物 | — | — | `spike/themes/out/print-<theme>.pdf` + `print-check.json` |

## 4. 前端主题面板（`web/src/themes/`）

### 4.1 集成方式（与 frontend-core 已约定并已挂载）

`web/src/integrations/optionalComponents.ts` 用 `import.meta.glob` 懒加载本组件，`EditView.vue` 已按以下接口挂载（本组件无需改他人文件）：

```vue
<ThemeGallery
  :themes="app.themes"          <!-- ThemeMeta[]（types.ts）-->
  :current="currentTheme"       <!-- 当前 front-matter theme -->
  :markdown="content"           <!-- 当前 deck 内容（缓存失效用）-->
  :render="renderForGallery"    <!-- (themeName) => { html, css }，由 renderer.renderWithTheme 提供 -->
  @select="applyTheme"          <!-- 点击卡片：父组件改 front-matter 并重渲染 -->
  @preview="previewTheme"       <!-- hover 试穿：父组件临时渲染、不写文件 -->
  @preview-end="endPreviewTheme"
/>
```

- **CSS 注册归 frontend-core**（`stores/app.ts#refreshThemes` + `renderer.registerTheme`）；本组件只消费 metadata 与选择事件。
- `render` 可选：缺失时卡片降级为"名称 + 哈希色板"占位，不报错（M1 早期阶段也可用）。
- 本组件 emit 只有 `select` 是必须的；`preview/preview-end` 父组件不监听也安全。

### 4.2 组件能力（M1）

- 卡片缩略图：**iframe srcdoc + `transform: scale()`**（把 1280×720 的 render 结果缩放塞进卡片），**不截图**；`IntersectionObserver` 懒加载（只渲染可视区域卡片），markdown 变化自动失效重渲染。
- 搜索（名称/标签）+ 分类 Tab（推荐/全部/商务/科技/学术/极简/创意/我的/收藏/最近使用，按主题 tags 自动归类）。
- 收藏 + 最近使用：localStorage（`mwb.themeFavorites` / `mwb.themeRecent`）。
- hover 140ms 防抖 → 触发 `preview`（临时试穿）；`Esc`/移出结束；点击卡片 = 应用。
- 键盘：`↑↓` 轮播（自动滚动/懒渲染）、`Enter` 应用、`Esc` 结束试穿；搜索框内不拦截方向键。
- 当前主题有"当前"徽标；"推荐"位按内置 6 套顺序取前 4 套，降低选择过载。
- 无第三方 UI 依赖，样式用 `--mwb-*` CSS 变量（复用 `styles/main.css` 的设计 token）。

### 4.3 `useThemes.ts`（可选工具通道）

frontend-core 已有完整主题数据流（`api/index.ts` + `stores/app.ts`），本文件是**自包含备用通道**（不 import 他人模块，自带 token/请求头），用于缩略图兜底、独立页面或测试：

```ts
import { loadThemes, loadThemeCss, loadThemeCssMap, registerThemesInto, useThemes } from './themes/useThemes'
const themes = await loadThemes()                 // GET /api/themes
const css = await loadThemeCss('business-blue')   // GET /api/themes/:name/css
const map = await loadThemeCssMap(themes)         // 并发拉取，失败跳过
registerThemesInto(marpInstance, map)             // marp.themeSet.add，返回 {registered, failed}
```

## 5. 已知问题与跨组提醒（重要）

1. **`@import 'default'` 必须是真实 CSS 规则**（见 §2）。契约 §3 的注释形式示例在 marp-core 4.4.0 下不生效，建议 Lead 更新契约示例，避免后续主题作者踩坑。
2. **导出打印页需要 marp-core browser helper**：auto-scaling（标题/代码缩放）、数学渲染等都是 `browser()` 运行时能力，**静态 HTML 里不生效**。预览侧 frontend-core 已调用 `applyBrowserHelper`；但 export-eng 的打印页（`/api/export/pdf` 服务端拼静态 HTML）若不执行 helper，内容较多的页可能被裁切（本次验证中，未注入 helper 时"表格+列表"页底部确实被裁）。建议导出链路二选一：打印页注入 `marp-core.browser.js` 并等 helper 完成；或由前端导出前先渲染/缩减内容。**已同步 lead 转达 export-eng。**
3. 自定义主题的 `Theme.width/height` 为 `undefined`（marp-core 实测），画廊/导出应读 `meta.size`（如 `["16:9","1280px","720px"]`）或渲染结果 `viewBox`。
4. 服务端 `parse_theme_meta` 同时兼容单行与块注释，且 `@tags` 支持中英文逗号/空格分隔；本批 6 套已验证可被解析出 `displayName/tags/size/autoScaling`。
5. 深色主题打印背景：主题内已声明 `print-color-adjust: exact`，打印页仍需统一加（契约 §1.6 已要求）；PPTX 走截图通道不受影响。
6. 字体：只用系统字体，不打包字体文件（项目计划 §3.5 的字体策略不变）；Windows 上中文用雅黑/宋体、代码用 Consolas/Cascadia Code，macOS 回退 PingFang/Songti。

## 6. M2 待办（下一批）

- 补齐计划 §5.4 剩余 6 套：`handwritten / chinese-ink / startup-orange / data-teal / dark-neon / paper-warm`。
- 画廊增强：hover 大图预览、主题详情（配色小样/字体信息）、`@thumbs` 指定取样页、自定义主题"另存为/编辑器"、收藏与最近使用改为服务端持久化。
- 主题包（`.marptheme` = CSS + 元信息 + 预览图）导入导出。
- 视觉回归：把 `spike/themes/render-themes.mjs` 的截图对比纳入 CI（可选）。

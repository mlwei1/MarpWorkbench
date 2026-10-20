# Marp 技术栈调研与可行性验证

> 任务：`task-1`（Team Lead 的 Marp 渲染/主题/导出技术栈调研与可行性验证）
> 日期：2026-10-20 ｜ 环境：Windows ｜ Node v22.13.0 ｜ npm 10.9.2 ｜ pnpm 12.14.0（随 pnpm 自更新）｜ Chrome 155.0.8059.84 ｜ Edge 155.0.4283.62（`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`）｜ 已确认 npm registry 可访问
> 实测目录：`spike/marp/`（独立包，未触碰工作区根目录 `package.json`）
> 标注约定：**【实测】**= 本机跑出来的结果（脚本/产物在 `spike/marp/`）；**【文档】**= 官方 README/文档/源码（本地安装包内源码亦计入）；**【推断】**= 未直接验证、基于证据的合理判断。

---

## 0. 结论摘要（TL;DR）

1. **推荐架构：便携单文件 exe 内嵌 Node 运行时 → 启动 127.0.0.1 本地服务 → 系统默认浏览器打开 UI。渲染放服务端（Node 里的 marp-core），导出也放服务端（用 `puppeteer-core` 驱动系统已装 Edge/Chrome）。** 浏览器 UI 只负责编辑、预览、主题画廊、触发导出。理由见 §7：浏览器端渲染与截图保真度不足、体积大，而服务端方案稳定且复用 marp-cli 已验证的导出路径。

2. **`@marp-team/marp-core` 4.4.0 可以在浏览器直接运行。【实测】** 用 esbuild 打 IIFE 成功（无 Node 内置依赖），在真实 Chromium 中 `new Marp().render(md)` 正常得到 `{html, css, comments}`。但体积代价大：**min 3.85 MB / gzip 1.20 MB / brotli 0.93 MB**（含 MathJax + KaTeX + highlight.js），首屏加载在测试中约 1.5 s。所以「纯前端渲染」只适合作为备选，不是首选。

3. **PDF 导出两条路都实测可行。** ① 服务端/无头浏览器 `page.pdf({printBackground:true, preferCSSPageSize:true, width, height})`（marp-cli 正是这么做，源码实读）；浏览器端 `window.print()` 走同一 Blink 打印管线，配合 `@page {size:1280px 720px;margin:0}` + 分页 CSS 实测得到 4 页、每页 **960×540 pt（=1280×720 px @96dpi）**、241 KB。② **Electron `webContents.printToPDF` 属同一管线，参数等价（未由本任务实测，由 packaging 成员实测；本条为【文档】+【推断】）。**

4. **PPTX 导出本质是「逐页位图」，不可编辑。【实测，已解包验证】** marp-cli `--pptx` 的实现：marp-core 渲染 → Puppeteer 逐页截图（PPTX 默认 2x，即 2560×1440）→ pptxgenjs 每页把整张 PNG 设为幻灯片背景（`<p:bg><p:bgPr><a:blipFill>`），slide XML 仅 770 B、无任何文字 run；备注写入 notesSlides。生成的 `.pptx`：1920×1080 比例（`sldSz=12192000×6858000 EMU` = 13.333×7.5 in）、3 页、352 KB、3 张 2560×1440 PNG。**该思路可完整复刻【实测】：浏览器端 marp-core + html-to-image + pptxgenjs 生成了 4 页、363 KB 的 PPTX（截图 233 ms + 写文件 73 ms）。**

5. **主题机制完全够做「主题画廊」。【实测】** 内置 `default/gaia/uncover` 均自带 `16:9(1280×720)` 与 `4:3(960×720)` 预设（`size:` 指令实测生效，SVG viewBox 从 `0 0 1280 720` 变 `0 0 960 720`）；自定义主题 `/* @theme name */ + @import 'default'; + @size + @auto-scaling` 实测生效；`ThemeSet.add()/themes()/getThemeMeta()/Theme.meta` 可枚举主题名、作者、尺寸预设、auto-scaling 等元信息，足够支撑画廊展示。**限制**：一次渲染只打包一个主题；多主题并存 = 同一 ThemeSet 多条主题，每次切换需重新 render（最快路径，实测热渲染 ~27 ms/次）。自定义主题的 `Theme.width/height` 为 `undefined`，画廊要显示尺寸需解析 `meta.size` 或渲染后读 SVG viewBox。

6. **主题画廊缩略图：首选「DOM 缩放实时预览」而不是位图。** 【实测】对每主题渲染一页并插入 `transform:scale(0.25)` 的 320×180 容器：**0.3–1.8 ms/个**，清晰、随主题 CSS 即时更新；而 `html-to-image` 生成 320 px PNG：**51–93 ms/个**，且存在保真问题（见 §6）。服务端预生成静态 PNG（~4–6 KB/张）最稳，作为「离线主题包附带缩略图」方案。

7. **离线可用性的第一号坑：marp-core 默认引用 CDN 资源。【实测】** 含公式（`math: katex`）的 deck 生成的 HTML 中有 **约 60 条 `cdn.jsdelivr.net` KaTeX 字体 URL**；`gaia` 主题 CSS 还 `@import` `https://fonts.bunny.net/...`；emoji 默认走 twemoji CDN。本机实测 marp-cli 转换此类 deck **因等待网络资源 30 s 超时失败**；换成无 CDN 依赖的 deck 后 8.6–9.8 s 成功。**修复清单见 §5.2：KaTeX 字体本地化（20 个 woff2，共 260 KB）或改用 MathJax（无字体依赖）；gaia 字体本地化；emoji 关 CDN。**

8. **版本兼容性结论【文档+实测】**：marp-core 4.4.0（engines: node≥18）/ marp-cli 4.5.1（node≥18）在 Node 22.13 下均正常；**marp-cli 4.5.1 只依赖 `puppeteer-core@^24.43.1`，不再自带 Chromium**，要求系统装有 Chrome/Edge/Firefox（README 明示），本机 Chrome/Edge 155 实测可被驱动。Electron 44 的内置 Chromium 版本未由本任务验证（由 packaging 成员负责）。

---

## 1. 调研方法与范围

- 先读官方文档与「已安装包内源码」：`spike/marp/node_modules/@marp-team/marp-core`（README、type 定义、打包产物）、`@marp-team/marp-cli`（README、`lib/` 打包源码、`package.json` 依赖）。
- 再在 `spike/marp/` 建独立实验工程，用 Node 脚本与真实 Chromium 实测：
  - Node 端 marp-core 渲染/主题（`scripts/render-spike.mjs`、`theme-size-test*.mjs`）；
  - esbuild 浏览器打包与体积统计（`scripts/build-browser.mjs`）；
  - 浏览器端渲染/截图/打印/PPTX/缩略图（`scripts/browser-spike.mjs`、`browser-export-fallback.mjs`、`visible-capture.mjs`、`diag-htmltoimage.mjs`）；
  - marp-cli 真实转换（PDF/PPTX/PNG/HTML/notes，本机 Chrome 155）+ 产物解包检查。
- 网络说明：本机 `web_fetch` 访问 GitHub/marpit 文档域名失败（`fetch failed`），但 `web_search` 可用；因此官方文档以「web_search 摘要 + 已安装包内 README/源码」交叉确认，链接见 §11。

---

## 2. marp-core 4.x API 与渲染

### 2.1 核心 API【实测 + 文档（包内 README/types）】

```js
import { Marp } from '@marp-team/marp-core'
const marp = new Marp({ html: true, math: 'katex', minifyCSS: true }) // 全部可选
const { html, css, comments } = marp.render(markdown) // comments: string[][]，按页的备注数组
```

- `render()` 返回 `{ html, css, comments }`（`types` 定义与实测一致；`env.htmlAsArray` 时 html 为数组）。
- `html` 结构：`<div class="marpit"><svg data-marpit-svg viewBox="0 0 W H"><foreignObject><section ...>…</section></foreignObject></svg>…</div>`（默认 inline SVG 模式）。
- 每页 `<section>` 上带 `data-paginate / data-header / data-footer / data-class / data-theme / data-marpit-pagination` 与行内 CSS 变量；`paginate/header/footer/class` 等指令实测生效。
- **备注**：HTML 注释 `<!-- 备注 -->`（页尾）进入 `comments[i]`，实测按页正确提取（多行备注保留换行）。
- **数学**：默认 MathJax；`math: 'katex'` 或 front-matter `math: katex` 切换。实测两种都产生正确标记（KaTeX 需字体，默认从 jsDelivr CDN 取——离线坑）。
- **HTML 开关**：默认使用 Marp 安全 allowlist（`<b>` 等可通过）；`html: true` 放开（实测 `<div class="x">` 被保留）；`html: false` 拒绝除 Marpit 支持外的 HTML。
- **分页**：`---` 分隔 + front-matter/`headingDivider`；实测 4 页 → 4 个 section/svg。
- **过渡（transition）**：front-matter `transition: fade` 在输出 HTML 中体现为 CSS（`transition` 相关变量），**未产生 `data-transition` 属性**；真实过渡动画由展示模板（marp-cli bespoke 模板 / 预览端）消费。【实测输出 + 推断】
- 构造选项还含 `emoji`（twemoji CDN，可本地化）、`script`（是否注入内联 helper 脚本）、`slug`、`minifyCSS`、`inlineSVG` 等（包内 README）。

### 2.2 Node 端渲染实测数据（`scripts/render-spike.mjs`）

样例：`samples/sample.md`（中文 + 代码块 + KaTeX 行内/块公式 + 4 页备注 + header/footer/paginate + transition）。

| 指标 | 结果 |
| --- | --- |
| 首次渲染耗时（含模块初始化） | **13,287.5 ms**（冷启动；含 katex/mathjax 载入） |
| 同实例二次渲染 | **313.2 ms**【实测】 |
| 常规主题页热渲染（已初始化后） | **27–31 ms/页组**【实测】 |
| 输出 HTML / CSS 体积 | **18,643 B / 129,114 B** |
| 页数 | 4（section=4、svg=4） |
| 备注 | `[[], ['这是第 2 页…'], ['多行备注：\n- …'], ['最后一页…']]`，按页正确 |
| KaTeX 标记 / 字体引用 | `class="katex"` 存在；CSS 含 `KaTeX_` 字体 URL |
| 中文 | 正常（HTML 原样 UTF-8） |
| 内联 helper `<script>` | 1 个（`script:true` 默认注入；`innerHTML` 注入时不会执行，见 §2.4） |

> 实测还发现：**同一 Marp 实例适合「一次 render 一份 deck」**；频繁切换主题/文档时建议复用实例并只改 Markdown/主题，热渲染稳定在几十 ms。

### 2.3 浏览器端能否直接运行【实测】

| 检查项 | 结论 |
| --- | --- |
| `package.json` 是否有 `browser`/`exports` 浏览器入口 | **没有**。`main: lib/marp.js`（CJS，Node 打包），`files` 里的 `browser.js`/`browser.d.ts` 是**浏览器 helper**（`observer/polyfill/browser()` 初始化函数）的入口，不是浏览器版 Marp 主包。 |
| 是否依赖 Node 内置模块 | 实测 `lib/marp.js` 的 require 仅：`@marp-team/marpit`、`@marp-team/marpit/plugin`、`postcss-selector-parser`、`highlight.js/lib/core`、`xss`、`katex`、`katex/package.json`、`mathjax-full/*`。**无 fs/path 等 Node 内置模块** → 可被浏览器打包。 |
| 用 esbuild 打浏览器 IIFE | **成功**（`scripts/build-browser.mjs`，`platform: browser, format: iife, globalName: MarpCoreBundle`）。 |
| 在真实 Chromium 中运行 | **成功**：`new Marp()`、`render()`、`browser(container)` helper 均正常；中文/代码/MathJax 公式正确；section 计算尺寸 1280×720。 |
| 冷/热渲染（浏览器内） | **361.9 ms / 100.5 ms**；`browser()` 应用 polyfill 约 165.8 ms |
| 浏览器 bundle 加载 | 3.85 MB min JS 注入耗时 **1,563 ms**（本机 headless 从本地文件注入，实际 HTTP 缓存后更快） |

**Marp for VS Code 的 webview 如何加载 marp-core**：本任务未直接读 marp-vscode 源码（网络受限）→【推断】其做法与社区一致：把 `@marp-team/marp-core` 作为 npm 依赖经 webpack/esbuild 打进 webview/扩展 bundle，用 `markdown-it` 渲染 + marp-core 同款 CSS 注入；`marp-core` 自身不发布 webview 专用 UMD 包（见上表 package.json 检查）。来源：[marp-vscode 仓库](https://github.com/marp-team/marp-vscode)、[DeepWiki: Marp for VS Code Preview Enhancement](https://deepwiki.com/marp-team/marp-vscode/3.4-preview-enhancement)。

### 2.4 浏览器端最小可用代码（推荐写法）

**写法 A（推荐，隔离最彻底）：整页 HTML 塞进 iframe `srcdoc`，让 marp-core 注入的内联 helper 正常执行。**【实测 64.4 ms 完成注入+渲染，内部 1 个内联脚本执行、公式与卡片布局正常】

```html
<iframe id="preview" style="width:1280px;height:720px;border:0"></iframe>
<script src="/assets/marp-core.browser.min.js"></script>
<script>
  const marp = new MarpCore.Marp({ math: 'mathjax' })      // 离线优先用 MathJax
  const { html, css, comments } = marp.render(mdText)
  const doc = `<!DOCTYPE html><html><head><meta charset="utf-8">
    <style>html,body{margin:0}${css}</style></head><body>${html}</body></html>`
  document.querySelector('#preview').srcdoc = doc
  // comments[i] 即第 i 页演讲者备注，可单独用于备注面板
</script>
```

**写法 B（同一页面内嵌，适合做「主题画廊/多缩略」）：`innerHTML` + 手动执行 helper。**
注意：**`innerHTML` 插入的 `<script>` 不会执行**（HTML 规范）；所以要么用 `script:false` 构造实例，要么手动调用 helper：

```js
// 打包入口需 import { browser } from '@marp-team/marp-core/browser'
const marp = new MarpCore.Marp({ script: false, math: 'mathjax' })
const { html, css } = marp.render(mdText)
styleEl.textContent = css
container.innerHTML = html
MarpCore.browser(container)   // 必须：应用 SVG polyfill / auto-scaling / 自定义元素
```

> 补充：若用默认 `script:true` + `innerHTML`，内联 helper 不执行 → auto-scaling/SVG polyfill 失效（表现为「fit 标题不缩放、超宽代码不缩」）。这是做 Web UI 最容易踩的坑之一。【实测 helper 可用 + 推断/规范】

---

## 3. 主题机制

### 3.1 内置主题【实测】

| 主题 | 渲染 CSS 体积 | 尺寸预设（`Theme.meta.size`） | 特点 |
| --- | --- | --- | --- |
| `default` | 49,193 B | `16:9 1280px 720px`, `4:3 960px 720px` | 白底、通用；CSS 含较多样式（体积最大） |
| `gaia` | 15,520 B | 同上 | 彩色/经典；CSS 顶部 `@import https://fonts.bunny.net/...`（**离线需处理**） |
| `uncover` | 14,623 B | 同上 | 极简，居中大字 |
| 三者 `author` | — | 均为 `Yuki Hattori` | 画廊可展示 |

`size: 4:3` 指令实测生效：SVG `viewBox` 从 `0 0 1280 720` → `0 0 960 720`（default/gaia 均验证）。默认 16:9 = 1280×720 px（= 960×540 pt @96dpi）。

### 3.2 自定义主题【实测全部通过】

`spike/marp/themes/custom-spike.css`（`@theme company-cn` + `@size 16:9` + `@auto-scaling true` + `@import 'default'` + 自定义字体/渐变）：

| 检查项 | 结果 |
| --- | --- |
| `@theme` 元信息解析 | 主题名 `company-cn`；`themeSet.add()` 返回 `Theme`，`name/meta/importRules` 齐全 |
| `@import 'default'` | `Theme.importRules = ['default']`；渲染后 CSS 中 `@import` 已展开、default 规则与自定义规则共存 |
| `@size` | `Theme.meta.size = ['16:9 1280px 720px']`；`size: 4:3` 仍可生效（import 的 default 也带来 4:3 预设） |
| `@auto-scaling true` | 元信息正确解析（`meta['auto-scaling']='true'`）；`fit` 标题/代码自动缩放依赖 inline SVG |
| 自定义字体（`font-family: 'Microsoft YaHei'`） | CSS 原样输出，Windows 本地字体可用 |
| 渲染体积 | HTML ~9.7 KB / CSS ~49.3 KB（含 import 的 default） |
| 多主题并存 | 同一实例 `themeSet.add(themeA)`/`add(themeB)` 后分别渲染：CSS 只含当前主题（A 的 CSS 不含 B 的背景色），**互不污染**；`themeSet.size` 正确累加 |
| 主题切换耗时 | 热渲染 **27–31 ms/次**（不含截图） |

主题文件写法（实测可用）：

```css
/*
 * @theme company-cn
 * @size 16:9 1280px 720px
 * @auto-scaling true
 */
@import 'default';

section {
  background: linear-gradient(135deg, #0b1f33 0%, #12395c 100%);
  color: #e6f1ff;
  font-family: 'Microsoft YaHei', 'PingFang SC', sans-serif;
}
```

### 3.3 ThemeSet / 主题元信息 API（画廊数据源）【文档（marpit 3.2.3 types）+ 实测】

```js
marp.themeSet.add(css)            // 返回 Theme（自动识别 /* @theme */，可省略 @theme 时按文件名？CLI 用法支持无 @theme 的 css 路径）
marp.themeSet.themes()            // Iterable<Theme>：name/meta/width/height/importRules…
marp.themeSet.get('default')      // Theme | undefined
marp.themeSet.has(name) / delete(name) / clear() / size
Theme.meta                        // { theme, size: string[], 'auto-scaling'?, author?, … }（正文 /* @theme */ 注释里的元数据）
Theme.width/height/widthPixel     // 内置主题有值（"1280px"/720），**自定义主题为 undefined**
```

画廊读取建议：
1. 名称/作者/标签：`Theme.meta`（`theme`、`author`、`size` 预设、`auto-scaling`）；
2. 尺寸：内置主题用 `widthPixel/heightPixel`；自定义主题解析 `meta.size` 或渲染一页读 `svg viewBox`；
3. 是否支持 fit/自动缩放：`meta['auto-scaling']`。

### 3.4 字体与中文

- 中文默认走系统字体（Windows：Microsoft YaHei / Segoe UI 等），**无需打包中文字体**，离线可用【实测：渲染与截图中文均正常】。
- 自定义主题可用 `@font-face` 指向本地 `.woff2`（`url()` 相对 CSS 文件或应用资源路径）；`gaia` 主题自带 `@import` 网络字体 → 离线必须替换/移除，否则会回退字体（版式可能变化）【实测 gaia CSS 顶部确有 bunny fonts import】。
- KaTeX 公式：默认字体走 CDN（见 §5.2）；MathJax 公式为 SVG 路径，**无字体依赖**，离线更稳【实测 mathjax 渲染/截图正常】。

---

## 4. 导出能力与实现路径

### 4.1 marp-cli 实际做了什么【源码实读（本地 `node_modules/@marp-team/marp-cli/lib/`）+ README】

- **依赖**：`@marp-team/marp-cli@4.5.1` 运行依赖只有 `@marp-team/marp-core ^4.4.0`、`@marp-team/marpit ^3.2.3`、`puppeteer-core ^24.43.1`、`chokidar`、`cosmiconfig`、`serve-index`、`tmp`、`ws`；**`puppeteer-core` 不带 Chromium**，README 明确要系统安装 Chrome/Edge/Firefox 之一（`--browser auto|chrome|edge|firefox`，`--browser-path` 可指定 Chromium 系）。`pptxgenjs@4.0.1`、`pdf-lib` 作为构建期依赖被 **bundle 进 `lib/`**（包内共 14 个文件、2,325,555 B；含 bespoke 模板、pptxgen、pdf-lib）。**离线 exe 内嵌时不必装 Chrome，但依赖用户机器的 Edge/Chrome。**
- **PDF 实现**（bundle 源码）：渲染页面 → Puppeteer `page.pdf({ printBackground: true, preferCSSPageSize: true, width: size.width, height: size.height })` → 再用 **pdf-lib** 后处理写入 Creator/Producer（Created by Marp）、标题/作者/主题元数据，并可加 outlines（PDF 书签）与 `--pdf-notes` 备注注释。→ 说明 PDF 是**矢量文本、可搜索可编辑**（与 PPTX 的位图不同）。
- **PPTX 实现**（`convertFileToPPTX`）：先 `convertFileToImage(..., { pages:true, type: png })` 逐页截图（PPTX 默认 `imageScale=2`）→ `new PptxGenJS()` → `defineLayout({name:'WxH', width: W/96, height: H/96})`（1280/96=13.333 in）→ 每页 `slide.background = { data: 'data:image/png;base64,…' }`，备注用 `slide.addNotes(comments[i].join('\n\n'))`。**确实没有文字层。**
- **PNG/JPEG**：`--images` 逐页截图（clip，默认 1x），`--image-scale` 可倍率；`--image` 只导首页（可配 OG image）。
- **HTML**：本地渲染成自带主题 CSS 的静态 HTML（bespoke 模板，含 `@page{size:1280px 720px;margin:0}` 与 `@media print` 分页 CSS）；**内含 KaTeX CDN 字体外链**（见 §5.2）。
- **备注**：`--notes` 导出 TXT；`--pdf-notes` 写入 PDF 注释；PPTX 写入 PowerPoint 备注页。
- **可程序化调用**：`import { marpCli, waitForObservation, CLIError } from '@marp-team/marp-cli'`；`await marpCli(['x.md','--pdf'])` 返回退出码，watch/server/preview 需 `waitForObservation()`。【文档（README API 章节），本任务未运行该 API】
- **可编辑 PPTX（`--pptx-editable`，EXPERIMENTAL）**：需安装 LibreOffice Impress，保真度更低、**不支持演讲者备注**，官方不推荐在意外观时使用。【文档（README）】

### 4.2 marp-cli 真实转换实测（本机 Chrome 155 驱动）【实测】

| 转换 | 耗时 | 退出码 | 产物 | 说明 |
| --- | --- | --- | --- | --- |
| `--pdf --pdf-notes --pdf-outlines`（**含公式 deck，走 CDN 字体**） | 68.4 s | **1（失败）** | — | `CLIError: Failed converting Markdown. (Timed out after waiting 30000ms)`：页面等 CDN 字体/资源超时 |
| `--pptx`（同上，CDN deck） | 44.6 s | 1 | — | 同上原因 |
| `--images png`（同上） | 40.7 s | 1 | — | 同上原因 |
| `--pdf`（**无 CDN 依赖的离线样例** `samples/sample-offline.md`） | **8.6 s** | 0 | `out/cli-offline.pdf` 128,026 B | **3 页，每页 960×540 pt**；标题元数据=「基于 Marp 的 Windows 桌面应用」 |
| `--pptx`（离线样例） | **9.8 s** | 0 | `out/cli-offline.pptx` 352,122 B | **3 页，逐页位图**（结构见下） |
| `--images png`（离线样例） | **8.8 s** | 0 | 3 张 PNG，35,324/64,550/27,581 B | 1280×720（1x） |
| `--html` | 3.4 s | 0 | 198,109 B | 单文件包含主题 CSS/模板；实测 `@page{size:1280px 720px;margin:0}` + `@media print` 分页规则存在 |
| `--notes` | 4.2 s | 0 | 184 B TXT | 备注导出正常 |

**PPTX 解包实证**（`out/pptx-unpacked/`）：

- `ppt/slides/slideN.xml` 每个仅 **770 B**，内容只有 `<p:bg><p:bgPr><a:blipFill>` 指向背景图，**无 `<a:t>` 文字** → 不可编辑；
- `ppt/media/Slide-N-image-1.png` 3 张，**2560×1440（2x）**，81,831 / 150,422 / 65,489 B；
- `ppt/presentation.xml`：`<p:sldSz cx="12192000" cy="6858000"/>`（13.333×7.5 in）；
- `ppt/notesSlides/notesSlideN.xml`：第 2、3 页备注文本正确写入（notesSlide1 无备注，仅有页码）。

### 4.3 PDF 路径判断（含 Electron printToPDF）

**A. 无头浏览器 `page.pdf`（推荐，服务端执行）**
- marp-cli 同款参数：`printBackground: true`、`preferCSSPageSize: true`、`width/height`（CSS px），页面需带 `@page { size: 1280px 720px; margin: 0 }` 与 `@media print` 分页（每页 svg/section `break-after: page`）。
- 实测（`scripts/browser-spike.mjs`，Chrome 155）：4 页 PDF，**每页 960×540 pt**，241,595 B，耗时 1,120 ms。字体由 Chromium 打印管线内嵌（**具体嵌入情况本任务未逐对象验证**）。
- 已知坑：`printBackground` 默认 false → 深色主题背景变白；不开 `preferCSSPageSize` 会用 Letter/A4 并可能整体缩放；`@page size` 用 px 在 Chromium 可用；分页靠 `break-after: page`；页面高度/宽度必须与 `@page` 一致，否则出现空白页/裁切。

**B. 浏览器端 `window.print()`**
- 同一 Blink 打印管线；配合 marp-cli 同款 `@page`/`@media print` CSS 即可（实测用 Chrome CDP `page.pdf` 等价验证；真实浏览器会弹打印对话框，需用户确认）。
- 风险：用户系统默认浏览器可能是 Firefox（打印 CSS 表现不同）、打印对话框交互不可控、无法静默批量导出。→ **作为「打印 / 另存为 PDF」的兜底入口，不作为主导出通道。**

**C. Electron `webContents.printToPDF`【文档+推断；本任务未实测 Electron】**
- 与 Chrome `page.pdf` 同源（Blink 打印），参数等价：`{ printBackground: true, preferCSSPageSize: true, margins: { marginType: 'none' } }`，隐藏的 `BrowserWindow` 加载预览 HTML 后调用即可；1280×720 CSS px → 960×540 pt。
- 注意 Electron 44 内置 Chromium 与系统 Edge/Chrome 155 版本不同，分页/字体渲染可能有细微差异；若产品形态是「本地服务 + 系统浏览器 UI」，**导出统一走系统 Edge/Chrome 更一致**，Electron 仅作备选。
- 参考：[Electron webContents.printToPDF 文档](https://www.electronjs.org/docs/latest/api/web-contents#contentsprinttopdfoptions)。

### 4.4 PPTX 自研复刻可行性【实测】

思路 = marp-cli 同款：**marp-core 渲染 → 逐页截图 2x PNG → pptxgenjs 每页背景图 + notes**。

| 步骤 | 实测结果 |
| --- | --- |
| 浏览器端 marp-core 渲染 4 页 | 361.9 ms 冷 / 100.5 ms 热 |
| 逐页 2x 截图（html-to-image，可见定位） | 96–287 ms/页，2x PNG 122–219 KB/页 |
| pptxgenjs 生成（4 页，定义 13.333×7.5 in 版式，背景图 + notes） | 截图总计 233 ms；`write()` 73 ms；**PPTX 363,512 B**（对比 marp-cli 352,122 B，同量级） |
| 质量 | 位图版式与截图一致；**保真度受截图环节限制**（见 §4.6） |
| 体积代价 | 10 页 deck 约 1–2 MB（随内容复杂度）；文本型可编辑 PPTX 通常几十 KB → 体积明显更大 |
| 可编辑性 | **无**（每页一张背景图）；`--pptx-editable` 是 experimental（需 LibreOffice、无备注、保真差），不建议做 |

**结论**：复刻可行且成本低；但若追求 PPTX 质量，**服务端用 puppeteer-core 原生截图（= marp-cli 原路径）优于浏览器端 html-to-image**。

### 4.5 PNG / JPEG / HTML / 备注

- PNG/JPEG：服务端原生截图（marp-cli 同款，实测 1280×720；`--image-scale 2` 可 2x）。浏览器端亦有可行路径（见 §4.6）。
- HTML：可直接导出 marp-core 渲染结果拼装单文件（模板含主题 CSS）。注意**外部字体/emoji 依赖**（§5.2）与打印 CSS（§4.3）。
- 备注：`comments` 数组按页提取（实测），可导出 TXT / 注入 PDF 注释 / 写入 PPTX notes（实测）。

### 4.6 浏览器端截图质量对比【实测，含图片人工检查】

| 方案 | 耗时 | 2x PNG 体积 | 质量结论 |
| --- | --- | --- | --- |
| `html-to-image`（inline SVG 默认模式） | 96–287 ms/页 | 122–219 KB | 中文/代码/公式（MathJax）**可正常渲染**；但**代码块高亮背景与配色丢失**、自定义主题渐变背景未呈现（对比 marp-cli 原生截图可见明显差异）。**【实测：产物图片已人工核对】** |
| `html-to-image`（固定坑） | — | — | **捕获节点放在负坐标（如 `left:-99999px`）会输出全白图**（实测 4 页输出同一张 76,073 B 白图）。必须放在可见坐标或 `position:fixed;left:0;top:0`。 |
| `html2canvas`（inline SVG 默认模式） | 355.6 ms/页 | 140,123 B | **布局错乱**（header/标题错位、主题背景丢失）→ 不可用。 |
| `html2canvas`（`inlineSVG: false` 传统 section 模式） | 451–655 ms/页 | 168,020 B | 首页版式基本正确（中文/主题/页码），但 `inlineSVG:false` 会失去 fit 自动缩放/部分功能；速度较慢。 |
| Chromium 原生截图（marp-cli / puppeteer） | — | 27–65 KB（1x）/2x 视内容 | **100% 保真**（实测 `cli-img.002.png`：语法高亮、代码块背景、页码全部正确）。 |

> 结论：**浏览器端导出若要求「所见即所得」，请走原生截图（服务端 puppeteer-core）**；纯前端降级方案可用 `html-to-image`（可接受轻微样式差异时），**不要用 html2canvas 处理 inline SVG 模式**。

---

## 5. 体积与离线部署

### 5.1 关键体积数据【实测】

| 资源 | raw | gzip | brotli | 备注 |
| --- | --- | --- | --- | --- |
| marp-core 浏览器 IIFE（含 marpit/highlight/MathJax/KaTeX） | **3,846,225 B**（3.85 MB） | **1,199,482 B**（1.20 MB） | 931,599 B（0.93 MB） | esbuild minify；未压缩 6.48 MB；构建约 32–50 s |
| marp-core browser helper（单独） | 9,898 B | 3,865 B | 3,391 B | 仅做 polyfill/auto-scaling |
| html-to-image | 20,562 B | 6,692 B | 5,900 B | 浏览器端截图 |
| html2canvas | 198,689 B | 46,413 B | 37,629 B | 不推荐主用 |
| pptxgenjs（浏览器 bundle） | 460,889 B | 157,726 B | 138,107 B | 浏览器端 PPTX |
| KaTeX 字体（20 个 woff2） | 259,792 B | — | — | 离线用 KaTeX 必须自托管；用 MathJax 可省 |
| 内置主题 CSS（单主题渲染时） | default 49,193 B / gaia 15,520 B / uncover 14,623 B | — | — | 已包含在 bundle 内 |
| 中文字体 | 0（系统字体） | — | — | Windows 自带雅黑等 |

- **纯前端静态站点（全部本地化）合计约 4.6 MB raw / ~1.5 MB gzip**（marp-core + html-to-image + pptxgenjs + KaTeX 字体；按需可砍掉 pptxgenjs/html-to-image）。
- **服务端渲染架构下浏览器端几乎为 0**（只需 UI 框架与预览页），导出依赖服务端内置的 marp-core（Node 包）与系统 Edge。
- `.exe` 本身体积与 Node 运行时方式由 packaging 成员决定（Node SEA / pkg / Electron 等），本文不评估。

### 5.2 离线部署必做清单【实测发现】

1. **KaTeX 字体本地化**：marp-core 默认 `katexFontPath` 指向 `https://cdn.jsdelivr.net/npm/katex@0.17.0/dist/fonts/`（实测生成 HTML 约 60 条 CDN 字体 URL）。离线方案二选一：
   - 用 MathJax（默认，无需字体，SVG 输出）——**推荐离线默认**；
   - 或 `new Marp({ math: { lib:'katex', katexFontPath: 'file:///.../fonts/' } })` 并把 `katex/dist/fonts/*.woff2`（20 个、260 KB）随应用分发。
2. **gaia 主题网络字体**：CSS 顶部 `@import "https://fonts.bunny.net/..."`，离线会回退字体（版式可能变）；建议主题包本地化或改用系统字体。
3. **emoji**：默认 twemoji 走 jsDelivr CDN；离线需 `emoji: { unicode: false }` 或本地 `base` 资源目录。
4. **不要假设有网**：本机实测「含 CDN 资源的 deck」marp-cli 转换 30 s 超时失败；**离线 exe 必须保证任何渲染路径 0 外网请求**（可用 DevTools 网络面板/请求拦截做验收）。
5. **浏览器版本**：系统 Edge/Chrome 需较新（本机 155 可用；`puppeteer-core@24` 支持）；启动时检测并给出可读错误。
6. **默认浏览器可能是 Firefox**：UI 预览/打印 CSS 需跨浏览器验证；导出交给服务端 Edge 可规避。

---

## 6. 主题画廊缩略图方案

| 方案 | 实测耗时/成本 | 质量 | 推荐度 |
| --- | --- | --- | --- |
| **DOM 缩放实时预览**（每主题渲染 1 页，插入 320×180 容器 `transform:scale(0.25)`） | **渲染 27–97 ms + 插入 0.3–1.8 ms/个** | 与真实渲染一致、清晰、随自定义主题即时更新 | ★★★★★（首选，做成网格 + 懒加载） |
| `html-to-image` 生成 320 px PNG | 51–93 ms/个（另加渲染） | 受保真问题影响（自定义主题渐变丢失、字体回退） | ★★（仅降级/导出分享用） |
| 服务端预生成 PNG（构建期/首次运行生成，随主题包缓存） | 一次性（每张 ~4–6 KB，本测 3,968–5,894 B） | 最稳（用原生截图，保真） | ★★★★（主题包分发的「离线主题市场」首选） |
| 服务端实时生成 | 每次数十至数百 ms（启动浏览器更贵） | 高 | ★（交互延迟，不适合画廊滚动） |

建议：**画廊用 DOM 缩放预览**（零额外依赖、即时、可点开大图）；离线主题包可附带预生成缩略图（服务端原生截图生成）作为首屏占位。主题卡片展示 `名称 + 尺寸预设(16:9/4:3) + 作者 + 标签(浅色/深色/中文友好)`，数据来自 `Theme.meta`。

---

## 7. 推荐架构

### 7.1 主推：本地服务端渲染 + 服务端导出（配合系统浏览器 UI）

```
┌────────────────────── 便携单文件 exe（内嵌 Node 运行时） ──────────────────────┐
│  HTTP 服务 127.0.0.1:<随机端口>（仅本机，带 token 校验）                      │
│   ├─ GET  /            → 桌面 UI 静态资源（编辑器/预览/主题画廊，体积小）      │
│   ├─ POST /api/render  → marp-core(Marp).render(md) → {html, css, comments,  │
│   │                       themeMeta, size}；主题来自 themes/*.css + 内置主题   │
│   ├─ GET  /api/themes  → themeSet 枚举（名称/作者/尺寸/auto-scaling/缩略图URL）│
│   ├─ POST /api/export/pdf  → 起无头 Edge/Chrome（puppeteer-core）→ page.pdf    │
│   ├─ POST /api/export/pptx → marp-core 渲染 → 逐页 2x 截图 → pptxgenjs 打包    │
│   └─ POST /api/export/png|html|notes → 同理                                   │
└───────────────────────────────────────────────────────────────────────────────┘
          ↑ 打开系统默认浏览器（http://127.0.0.1:port）
┌──────────────────────────── 浏览器 UI（无渲染引擎依赖） ───────────────────────┐
│ 编辑器（Monaco/CodeMirror 或 textarea）＋ 实时预览（iframe srcdoc）             │
│ 主题画廊（DOM 缩放预览 + 点击切换 → 重新 POST /api/render）                    │
│ 备注面板（comments 数组）；导出菜单（调 /api/export/* 下载）                    │
└───────────────────────────────────────────────────────────────────────────────┘
```

关键决策：
- **渲染放服务端**：marp-core Node 端已装、热渲染 27–31 ms/次；浏览器 UI 不打包 3.85 MB 渲染库；主题切换只是重新 render（毫秒级）。
- **导出放服务端**：用 `puppeteer-core` 驱动系统 Edge/Chrome（本机实测 Chrome 155 成功，PDF/PPTX/PNG 全通过），**彻底规避浏览器端截图保真与系统默认浏览器差异**；同时比 Electron 方案更轻。
- **预览用 iframe `srcdoc`**：隔离主题 CSS、保证 marp-core 内联 helper 执行（实测 64 ms）。
- **主题画廊用 DOM 缩放**：见 §6。
- 兜底：`window.print()`（用户浏览器直接打印/另存 PDF）作为可选入口。

### 7.2 备选方案

| 方案 | 做法 | 优点 | 缺点 | 适用 |
| --- | --- | --- | --- | --- |
| **A. 纯前端静态站点** | esbuild 打 marp-core IIFE + html-to-image/html2canvas + pptxgenjs；PDF 用 window.print | 无 Node 服务、可静态托管、完全离线 | 首屏 3.85 MB / gzip 1.2 MB；截图保真差；系统浏览器差异；PPTX 质量依赖客户端截图 | 「免安装/只需浏览器」形态 |
| **B. Electron 壳（task-2 调研）** | 主进程渲染 + `webContents.printToPDF` + 原生菜单 | 导出最可控、无系统浏览器依赖、体验一体化 | 安装包大（100 MB 级）；产品形态已定为「浏览器 UI」，Electron 仅作外壳 | 若后续想强化桌面体验 |
| **C. 内嵌 marp-cli（或其 standalone 二进制）子进程** | exe 内自带 Node + marp-cli，导出时 spawn | 导出逻辑「零开发」，与官方逐字节一致 | 体积/进程管理/错误解析成本；本任务仅验证 CLI 可跑与源码 | 想最快出导出 MVP |
| **D. Tauri/WebView2 外壳** | WebView2 显示 UI，导出仍需外挂浏览器 | 体积小 | 导出路径未验证（WebView2 无官方 printToPDF API），风险高 | 不建议 |

### 7.3 决策矩阵（5=最好）

| 维度 | 主推（本地服务+服务端导出） | A 纯前端 | B Electron | C 内嵌 marp-cli |
| --- | --- | --- | --- | --- |
| 开发速度 | 4 | 3 | 2 | 4 |
| PDF 导出可靠性 | **5** | 3 | 4（Chromium 版本差异） | 5 |
| PPTX 导出可靠性 | **5**（原生截图） | 2（html-to-image 保真差） | 4 | 5 |
| 体积 | **4**（复用系统 Edge） | 5（浏览器端库 1.5 MB gzip） | 1 | 2 |
| 启动速度 | 4 | 5 | 2 | 3 |
| 离线 | 4（需 Edge + 资源本地化） | 4（同左，另需字体本地化） | **5** | 4 |
| 后续维护 | **4** | 3 | 3 | 3 |

---

## 8. 风险清单

| # | 风险 | 影响 | 缓解 |
| --- | --- | --- | --- |
| 1 | **CDN 依赖导致离线不可用/超时**（KaTeX 字体、gaia 字体、twemoji） | 导出/预览卡死、30 s 超时（已实测复现） | 默认 MathJax；KaTeX 字体本地化；gaia 字体本地化；emoji 关闭 CDN；验收时拦截全部外网请求 |
| 2 | 依赖系统已装 Edge/Chrome（puppeteer-core 需真实浏览器） | 极简/非 Windows 环境导出失败 | 启动检测 Edge/Chrome 路径，给出安装引导/降级提示；Windows 10/11 一般自带 Edge |
| 3 | 浏览器端截图保真（html-to-image 丢高亮背景/自定义主题背景；html2canvas 处理 inline SVG 布局错乱） | PNG/PPTX 与预览不一致 | 导出统一走服务端原生截图；浏览器端只做「快速预览/分享图」 |
| 4 | 浏览器端 `innerHTML` 不执行 marp-core 内联 helper | fit/自动缩放失效 | `script:false` + 手动 `browser(container)`，或用 iframe srcdoc |
| 5 | html-to-image 负坐标输出空白 | 缩略图/导出全白 | 捕获节点固定可见坐标（实测坑，写入开发规范） |
| 6 | 系统默认浏览器是 Firefox → 打印 CSS 差异 | 用户 window.print 排版异常 | 主导出走服务端；`window.print` 仅兜底并提示用 Edge/Chrome |
| 7 | PPTX 不可编辑被用户投诉 | 产品预期错位 | UI 明示「图片版 PPTX，保证 100% 版式，不可逐字编辑」；可编辑版不做 |
| 8 | Electron 44 vs Edge 155 Chromium 版本差异（若选 Electron 导出） | PDF/分页细微差异 | 导出一律走系统 Edge；Electron 仅作备选 |
| 9 | marp-cli 在打包 exe 内 programmatic API 可用性未验证 | 若选方案 C 的落地风险 | 优先方案 A 自研导出；如用 marp-cli 先做打包内 smoke test |
| 10 | 主题市场/自定义主题的字体与安全（用户 CSS 注入） | XSS/资源加载 | 主题 CSS 服务端解析（Theme.fromCSS 校验 @theme），禁止外部 URL 或白名单；预览 iframe 加 sandbox |
| 11 | 大 deck 导出性能（截图逐页 ×2x） | 长耗时/内存 | 进度上报；限制并发；可先 1x 预览再 2x 导出 |

---

## 9. 未实测 / 推断项清单（诚实边界）

1. **Electron `webContents.printToPDF` 本身**：本任务只实测 Chrome CDP `page.pdf`（同 Blink 打印管线）；Electron 由 `task-2` packaging 成员实测。本文 Electron 参数为【文档+推断】。
2. **Marp for VS Code webview 的 marp-core 加载细节**：未读 marp-vscode 源码（网络受限），按公开仓库信息【推断】。
3. **Firefox 的打印 CSS 表现**：未实测。
4. **PDF 字体逐对象嵌入情况**：未完成可靠验证（pdf-lib 低层枚举失败），仅确认页面尺寸与文字渲染；Chrome 打印管线通常内嵌字体，但**未逐对象确认**。
5. **PPTX `--pptx-editable`**：仅读 README，未安装 LibreOffice 实测。
6. **marp-cli programmatic API（`marpCli()`）**：仅读 README，未在代码中调用。
7. **WebView2/Tauri 的 CDP 远程调试驱动**：未验证（仅备选 D 的说明）。
8. **marp-core 打包内 highlight.js 支持的语言全集**：未逐语言枚举（JS 代码块实测正常）。
9. **中文字体在非 Windows 平台**：未评估（目标平台 Windows）。
10. **`.exe` 内嵌 Node 运行时的具体方案与体积**：由 packaging 成员负责，本文不覆盖。

---

## 10. 实测脚本与复现命令

所有脚本/样例/产物位于 `spike/marp/`（独立 pnpm 工程；依赖：`@marp-team/marp-core@4.4.0`、`@marp-team/marp-cli@4.5.1`、`pptxgenjs@4.0.1`、`pdf-lib@1.17.1`、`esbuild`、`puppeteer-core`、`html-to-image`、`html2canvas`）。

```powershell
cd spike/marp
pnpm install --ignore-scripts        # 已装；marp-cli 用 --ignore-scripts 避免额外下载浏览器

# 1) Node 端 marp-core 渲染/主题/数据（中文/代码/KaTeX/备注/主题集）
node scripts/render-spike.mjs        # → out/render-report.json, out/sample-*.html

# 2) 浏览器打包与体积
node scripts/build-browser.mjs       # → out/marp-core.browser.min.js + out/browser-bundle-report.json

# 3) 浏览器端（真实 Chrome 155）：渲染/iframe/截图/html2canvas/pptxgenjs/打印 PDF
node scripts/browser-spike.mjs       # → out/browser-report.json, slide-*@2x.png, browser-pptxgen.pptx, browser-print.pdf

# 4) 截图保真诊断 + 主题缩略图
node scripts/browser-export-fallback.mjs   # inlineSVG:false 对比
node scripts/visible-capture.mjs           # 可见定位下 html-to-image 2x 截图 + 主题缩略图
node scripts/diag-htmltoimage.mjs          # 空白问题定位（负坐标坑）

# 5) 主题 @size / ThemeSet 元数据
node scripts/theme-size-test2.mjs

# 6) marp-cli 真实转换（需系统 Chrome/Edge）
node node_modules/@marp-team/marp-cli/marp-cli.js samples/sample-offline.md --pdf -o out/cli-offline.pdf --pdf-notes --browser chrome
node node_modules/@marp-team/marp-cli/marp-cli.js samples/sample-offline.md --pptx -o out/cli-offline.pptx --browser chrome
node node_modules/@marp-team/marp-cli/marp-cli.js samples/sample-offline.md --images png -o out/cli-img.png --browser chrome
node node_modules/@marp-team/marp-cli/marp-cli.js samples/sample-offline.md --html -o out/cli-sample.html
node node_modules/@marp-team/marp-cli/marp-cli.js samples/sample-offline.md --notes -o out/cli-notes.txt

# 7) 产物检查（PDF 页数/尺寸、PPTX 解包、PNG 尺寸、外链）
node scripts/inspect-outputs.mjs
node scripts/supplement-fix.mjs
```

样例：
- `samples/sample.md`：中文 + 代码 + KaTeX 公式 + 备注 + header/footer/paginate/transition；
- `samples/sample-browser.md`：同内容但 MathJax（离线可渲染）；
- `samples/sample-offline.md`：无任何 CDN 依赖（用于 marp-cli 实测）；
- `themes/custom-spike.css`：自定义主题（`@theme`/`@import`/`@size`/`@auto-scaling`/中文字体/渐变背景）。

主要产物：`out/cli-offline.pdf`、`out/cli-offline.pptx`、`out/pptx-unpacked/`（PPTX 结构证据）、`out/cli-img.00*.png`（原生截图质量基线）、`out/browser-print.pdf`、`out/browser-pptxgen.pptx`、`out/inline-visible-slide-*@2x.png`（浏览器截图质量）、`out/theme-thumb-*.png`、`out/*.json`（全部数据）。

---

## 11. 来源链接

官方文档/仓库：
- Marp Core（README / 源码 / 主题）：https://github.com/marp-team/marp-core ｜主题说明 https://github.com/marp-team/marp-core/tree/main/themes
- Marpit（主题 CSS / 元数据 / ThemeSet API）：https://marpit.marp.app/theme-css ｜https://marpit-api.marp.app/themeset/ ｜https://github.com/marp-team/marpit
- Marp CLI（README：PDF/PPTX/图片/browser/API/配置）：https://github.com/marp-team/marp-cli ｜https://raw.githubusercontent.com/marp-team/marp-cli/main/README.md
- Marp 官网：https://marp.app
- Marp for VS Code：https://github.com/marp-team/marp-vscode ｜https://deepwiki.com/marp-team/marp-vscode/3.4-preview-enhancement
- Electron printToPDF：https://www.electronjs.org/docs/latest/api/web-contents#contentsprinttopdfoptions
- Chrome DevTools Protocol Page.printToPDF：https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-printToPDF
- html-to-image：https://github.com/bubkoo/html-to-image ｜html2canvas：https://html2canvas.hertzen.com/ ｜pptxgenjs：https://gitbrent.github.io/PptxGenJS/
- KaTeX 字体说明：https://katex.org/docs/font ｜MathJax：https://www.mathjax.org/

本地源码证据（随依赖安装，可直接查阅）：
- `spike/marp/node_modules/@marp-team/marp-core/package.json`、`lib/marp.js`、`types/src/marp.d.ts`、`README.md`；
- `spike/marp/node_modules/@marp-team/marp-cli/package.json`、`README.md`、`lib/`（PDF/PPTX 实现，`inspect-cli.mjs` 提取的片段）；
- `spike/marp/node_modules/.pnpm/@marp-team+marpit@3.2.3/.../index.d.ts`（ThemeSet API）。

---

*本文件为计划阶段技术调研，不含产品代码；实测脚本与所有原始数据保留在 `spike/marp/`，可按 §10 复现。*

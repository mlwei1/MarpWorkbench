# 导出管线（M1-C，export-eng）

> 状态：M1 完成并实测通过（2026-10-20）。
> 接口依据：`docs/API_CONTRACT.md` §1.6 / §1.7 / §2.4；实测依据：`docs/research/desktop-packaging.md` §1、`docs/research/marp-tech.md` §4。
> 代码：`server/src/export/**`、`server/src/routes/export.rs`、`web/src/export/**`；验证脚本：`spike/export/**`。

---

## 0. TL;DR

| 格式 | 主通道 | 实测结论 |
|---|---|---|
| **PDF** | 服务端写静态打印页 → 本机 Chrome 无头 `--print-to-pdf`（Edge 兜底） | ✅ 3 页 83.8 KB / **2.4–4.4s**；逐页 **960×540pt**；中文矢量可提取（18/46/40 字）；无页眉页脚；**渐变/深色背景/代码块背景完整打印**（已渲染成位图目检，见 §2.3） |
| **PPTX** | 服务端 **CDP 原生截图 2x（2560×1440）** → 前端 pptxgenjs 组装 13.333×7.5in 图片版 + notes | ✅ 3 页 / 16:9 精确 `sldSz 12192000×6858000` / 3 条备注写入 / 打开解包无异常；**CDP 保真 100%**；PNG 通道 4.26MB、JPEG 通道 0.6MB |
| **HTML** | 前端渲染结果 + 主题 CSS + 内置翻页脚本 → 单文件 | ✅ 22.8KB 离线双击可播（←/→/空格/F），同时保留 `@page` 打印规则 |
| **降级（仅 CDP 不可用）** | 前端 `html-to-image` 快速版 | ⚠️ 主题保真明显下降（渐变/代码块背景/主题配色全丢），UI 标注“快速版” |

**真实 exe 端到端（E2E）：PDF / capture / PPTX / HTML / 安全用例 18/18 全过（PNG 与 JPEG 两种截图格式各跑一遍，均 18/18）**，详见 §12。

**M0 遗留验证结论：PPTX 质量主通道 = 服务端 CDP 原生截图；html-to-image 只作降级，不当主通道。**（对比证据见 §4）

---

## 1. 架构与数据流

```
前端（浏览器 UI）
  marp-core 渲染 markdown → { html, css, comments }
        │
        ├─ PDF  → POST /api/export/pdf      {html,css,title,width,height}
        ├─ HTML → POST /api/export/html     {html,css,title}
        └─ PPTX → POST /api/export/capture  {html,css,width,height,scale:2,format:"png"|"jpeg"}
                        │ 返回 images[{index,url,w,h}] + fallback 标记
                        ↓
             fetch 每张图（带 X-MWB-Token）→ blob → dataURL
                        ↓
             pptxgenjs：defineLayout 1280/96 × 720/96 → 每页 background=dataURL + addNotes(comments[i])
                        ↓
             pptx.writeFile() → 浏览器下载
服务端（Rust/axum）
  routes/export.rs（路由/鉴权/并发锁/文件服务）
        └─ export/（通过 #[path="../../export/mod.rs"] 挂载，不改 main.rs）
              ├─ print_page.rs  打印页/截图页 HTML 模板（@page/分色/分页/就绪标记）
              ├─ pdf.rs         tokio::process 调无头浏览器 + 轮询落盘 + 强杀 + 落盘到 exports/
              ├─ cdp.rs         DevToolsActivePort → /json/list → WebSocket（tungstenite）
              │                 Page.enable/Runtime.evaluate/Page.captureScreenshot
              ├─ capture.rs     截图编排 + 临时目录 token + TTL 清理
              ├─ html_export.rs 单文件 HTML（含离线翻页脚本）
              └─ util.rs        临时目录/文件名/file:// URL/PDF 页数/清理
```

**为什么打印页走 `file://` 而不是契约 §1.7 的 `GET /api/export/print/:token`：**
浏览器 CLI 导航无法携带 `X-MWB-Token` 请求头，而给打印路由开鉴权白名单会削弱 token 模型。
改为把静态打印页写到 `%TEMP%\MarpWorkbench\pdf-<hex>\print.html`，用 `file://` 打开——
desktop-packaging 实测 file:// 打印与本地 HTTP 打印的 PDF 质量/字节一致（106.7 KB / 4.13s）。
**外部 API 无变化**；该路由未注册（请求会 404），已在给 Lead 的消息中确认。

---

## 2. PDF 通道

### 2.1 打印页模板（`server/src/export/print_page.rs`）

```css
@page { size: 1280px 720px; margin: 0; }          /* 缺了会退化成 Letter 612×792pt + 白边 */
html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }  /* 深色/渐变必须 */
div.marpit > svg[data-marpit-svg] { display:block; width:1280px; height:720px; margin:0; }
@media print {
  div.marpit > svg[data-marpit-svg] { break-after: page; break-inside: avoid; }
  div.marpit > svg[data-marpit-svg]:last-child { break-after: auto; }  /* 否则可能多空白页 */
}
```

### 2.2 无头浏览器调用（`pdf.rs`）

```
chrome.exe --headless=new --disable-gpu --no-first-run --no-default-browser-check
  --no-pdf-header-footer --virtual-time-budget=8000
  --user-data-dir=%TEMP%\MarpWorkbench\chrome-profile-<hex>
  --disable-extensions --disable-sync --disable-background-networking --mute-audio
  --print-to-pdf=<%TEMP%>\MarpWorkbench\pdf-<hex>\out.pdf
  file:///.../print.html
```

- **异步 spawn**（`tokio::process` + `CREATE_NO_WINDOW`），绝不阻塞 HTTP 运行时；
- 等待策略：轮询 PDF「存在 && 大小稳定 ≥300ms」→ 给 1.5s 自然退出宽限 → 仍不退则 `taskkill /PID /T /F`；
- 总超时 **60s**；失败/超时都清临时目录；`MWB_BROWSER_PATH` 可强制指定浏览器（测试用）；
- 浏览器顺序：Chrome（会正常退出）→ Edge（打印完不退出，必杀）→ 失败返回 `EXPORT_FAILED` + 中文原因；
- 产物写 `<数据目录>\exports\<标题>-<时间戳>.pdf`（重名自动 `-1`），`GET /api/export/file/:name` 提供下载（中文名 `filename*=UTF-8''`）。

### 2.3 实测数据（3 页样例：中文 / 代码块 / 渐变主题 / 每页备注）

样例：`spike/export/sample-deck.md` + `spike/export/themes/gradient-spike.css`（marp-core 4.4.0 渲染）。

| 项 | Chrome 155（主通道） | Edge 155（兜底） |
|---|---|---|
| 耗时（含浏览器冷启动） | **5.0 s** | ~10.3 s（含进程清理等待） |
| PDF 大小 | **83,777 B** | 83,791 B |
| 页数 | 3 | 3 |
| 页面尺寸 | **960×540 pt（全部）** | 960×540 pt |
| 文本可提取 | ✅ 67 / 291 / 100 字符 | ✅ |
| 中文字符 | ✅ 18 / 46 / 40 | ✅ |
| 页眉页脚/URL | ✅ 无（`--no-pdf-header-footer` 生效） | ✅ 无 |
| 进程行为 | 打印后不退出（本次实测）→ kill | 不退出 → kill |

**渐变/背景打印证据**（`spike/export/out/pdf-chrome-*.png`，pdfjs + `@napi-rs/canvas` 渲染 PDF 页）：
第 1 页四角/中心像素 = `(123,47,247) (215,30,145) (152,35,204) (247,37,133) (181,23,159)`（紫粉渐变）；
第 2/3 页 = `(11,16,32)` → `(123,47,246)`（深蓝紫渐变）。与截图逐像素一致，**背景渐变确实被打印为矢量 shading，不是白底**。

### 2.4 关键补充：打印/截图页必须注入 marp browser helper（auto-scaling）

**问题（ux-competitors 提醒，本任务实测复现）**：marp-core 的 auto-scaling（长代码块/标题自动缩小）
是**浏览器运行时能力**，由 `@marp-team/marp-core/browser` 注册的自定义元素实现（渲染结果里是
`<pre is="marp-pre" data-auto-scaling="downscale-only">`）。静态 HTML 不注册这些元素时，
`is=` 属性无效 → 内容按原始尺寸排出 → 被 `section{overflow:hidden}` **直接裁切**，与预览不一致。

**实测（`spike/export/scripts/diag-fit.mjs`，business-blue 主题，18 行代码块）**：

| 打印页 | PDF 里可见的最后一行 | 文本字符数 |
|---|---|---|
| 不注入 helper | `line12`（line13–18 被裁切） | 286 |
| 注入 helper + 调用 `browser(document.body)` | `line14`（改善；更极端内容仍受 downscale-only 下限约束） | 336 |

普通 3 页 deck 注入前后 PDF 字节/内容一致（83,755 vs 83,757 B），**耗时可忽略**（helper 从本地
内联脚本加载，无网络请求）；CDP 截图页 `navigate → __MWB_READY__` 由 ~0.44s 变为 ~1.1s（helper 初始化
+ 就绪等待），属可接受成本。

**实现（`print_page.rs` + `browser_helper.js`）**：
- 只内嵌 **9.3KB** 的 `@marp-team/marp-core/lib/browser.js`（MIT，自执行 IIFE，加载即对当前文档生效），
  而不是 3.85MB 的完整 `marp-core.browser.js` —— 导出页不需要 Marp 渲染器/MathJax；
- 文件内嵌在 Rust 模块：`server/src/export/browser_helper.js`（`include_str!`），
  重新生成命令 `node spike/export/scripts/vendor-helper.mjs`（marp-core 升级时重跑）；
- PDF 打印页、CDP 截图页、单文件 HTML 三处均注入；helper 注入前后页面体积 60KB → 70KB。
- **踩坑记录（已放弃的 3.85MB 方案）**：完整 bundle 内联时 ① 含 `<!--` 序列会被 HTML 解析器吞掉后续脚本；
  ② 改用 base64 `data:` URL 后，data: 脚本执行时机晚于同位置内联脚本；③ 每页 +5MB 使 CDP
  就绪时间从 ~0.4s 涨到 ~1.1–4s。9.3KB 小 helper 全部规避（内联普通脚本、无特殊序列）。

> 参考：100 页 deck 实测 8.34s（desktop-packaging）；本次 3 页冷启动 5.0s 与其 4.1s 同量级。
>
> **真实 exe 端到端复测（E2E，`spike/export/scripts/e2e-server.mjs`）**：`POST /api/export/pdf` 返回
> `{bytes:83761, pages:3, ms:2382–4444, browser:"chrome"}`；下载文件 83,761 B；pdfjs 校验
> 3 页全部 960×540pt、中文 18/46/40 字、无页眉页脚；与上面 spike 结果一致。

---

## 3. PPTX 通道

### 3.1 流程（= marp-cli `--pptx` 的图片版复刻）

1. `POST /api/export/capture`：服务端起单个无头 Chrome（`--remote-debugging-port=0`），CDP：
   `Page.enable` / `Emulation.setDeviceMetricsOverride(1280×720)` / `Page.navigate(file://…)` →
   轮询 `window.__MWB_READY__`（字体就绪 + 双 rAF）→ `Runtime.evaluate` 取每页
   `div.marpit > svg[data-marpit-svg]` 的文档坐标/尺寸 → 逐页
   `Page.captureScreenshot { clip, captureBeyondViewport:true, scale:2 }` → 2560×1440 PNG/JPEG；
2. 前端 `fetch` 每张图（带 token）→ `blob` → `dataURL`；
3. `pptxgenjs`：`defineLayout({ width: 1280/96, height: 720/96 })`（**注意：13.333 会得到
   `sldSz.cx=12191695` 非精确 16:9，必须用 1280/96 = 13.333…**）→ 每页 `slide.background={data:dataURL}`
   + `slide.addNotes(comments[i])` → `writeFile()` 下载。

### 3.2 截图格式自适应（实测预算校准）

PNG 2x 编码是主要成本；渐变背景下 2560×1440 PNG 单页 1.3–1.5 MB、约 **2.0–2.3 s/页**，
30 页会超计划 §7.5 的「30 页 PPTX ≤30s」预算。JPEG q90 单页 **0.34–0.47 s/页**、130–245 KB，
目检文字边缘无可见糊化（`spike/export/out/perfD-slide-2.jpg`）。因此：

> **页数 ≤10 → PNG（无损）；>10 → JPEG q90**（`ExportPanel.vue` 按 `slideCount` 自动选择，
> `POST /api/export/capture` 的 `format` 字段为 additive 可选参数，默认 png，契约兼容）。

### 3.3 实测数据

| 项 | 数值 |
|---|---|
| CDP 截图 3 页（2x PNG，spike 裸协议） | 6.4–6.7 s 总计（启动 DevToolsActivePort 2.35s + navigate/ready 0.44s + 每页 1.9–2.3s） |
| CDP 截图 3 页（2x JPEG q90，spike） | **约 1.8 s** 截图阶段（0.34–0.47 s/页） |
| **真实 exe `POST /api/export/capture`（3 页，PNG 2x）** | **7.1–11.5 s**（含浏览器启动 ~0.6–2.4s + helper 就绪 ~1.1s + 逐页截图）；3 张 2560×1440 |
| **真实 exe `POST /api/export/capture`（3 页，JPEG q90 2x）** | **5.9 s**（同流程，编码更快） |
| 单张尺寸/大小 | 2560×1440；PNG 1.30–1.46 MB；JPEG 130–245 KB |
| pptxgenjs 组装（3 页） | **528 ms**，PPTX **4,256,637 B（PNG）** / **598,574 B（JPEG）** |
| PPTX 解包校验 | 3 页；`sldSz cx=12192000 cy=6858000`（13.333×7.5in）；每页背景图 2560×1440；`notesSlide1..3` 文本与 3 页备注逐条一致；slide XML 仅 `blipFill` 无文字（图片版，符合预期） |
| 并发截图 | ❌ 不可用：并发发多个 `Page.captureScreenshot` 会返回同一帧（spike 实测 3 张同图）→ 必须逐页串行 |

> 30 页预算推算：JPEG 通道 ≈ 2.4s 启动 + 1.1s 就绪 + 30×0.45s ≈ **17s**（≤30s ✅）；PNG 通道约 64s（仅 ≤10 页场景使用）。
> JPEG q90 已目检：中文/代码文字边缘无可见糊化（`spike/export/out/perfD-slide-2.jpg`）。

---

## 4. M0 遗留验证：CDP 原生截图 vs html-to-image（保真对比）

同一份 `capture.html`（含渐变主题、代码块、中文），2x 输出，人工逐图对比
（`spike/export/out/cdp-slide-*.png` vs `h2i-slide-*.png`）：

| 维度 | CDP 原生截图 | html-to-image |
|---|---|---|
| 主题渐变背景 | ✅ 完整（紫粉/深蓝渐变色带可见） | ❌ **完全丢失**（白底） |
| 代码块背景/高亮配色 | ✅ 完整 | ❌ **丢失**（无背景色） |
| 主题配色/字号/内边距/页码位置 | ✅ 与预览逐像素一致 | ❌ 全部退化为默认浏览器样式 |
| 中文/公式渲染 | ✅ | ✅（内容能出来，但样式不对） |
| 单页耗时 | PNG 2.0–2.3s / JPEG 0.42s | 0.15–0.42 s |
| 单页体积（2x） | PNG 1.3–1.5MB / JPEG 130–245KB | 122–170 KB（因为丢背景） |
| 结论 | **PPTX 质量主通道** | 仅降级（CDP 不可用时），UI 标注“快速版” |

另复现了 marp-tech 记录的坑：**html-to-image 的捕获节点若放在负坐标（left:-99999px）会输出全白图**；
`ExportPanel.vue` 降级实现使用可见坐标容器（`position:fixed;left:0;top:0`）。

---

## 5. HTML 单文件

- 与打印页同一套 `@page` 规则（打印时仍是逐页 slide）；
- 额外内联 ~40 行 viewer：`←/→/空格` 翻页、`Home/End`、`F` 全屏、页码提示；屏幕绝对定位居中 + 自适应缩放；
- 主题 CSS/渲染 HTML 全部内联，**0 外部资源**（断网可播）；
- 产物：`<数据目录>\exports\<标题>-<时间戳>.html`。

---

## 6. 临时文件与清理策略（失败/取消也必须清）

| 路径 | 生命周期 | 清理时机 |
|---|---|---|
| `%TEMP%\MarpWorkbench\pdf-<hex>\` | 单次 PDF 导出 | 成功/失败/超时都在 `export_pdf` 的 finally 路径 `remove_dir_all`（PDF 已 rename 到 exports 后） |
| `%TEMP%\MarpWorkbench\chrome-profile-<hex>\` | 单次打印 | 打印结束（含 kill 后）立即删除 |
| `%TEMP%\MarpWorkbench\cdp-profile-<hex>\` | 单次截图 | `BrowserGuard::drop` 杀进程树（`taskkill /T /F`）后删除 |
| `%TEMP%\MarpWorkbench\capture-<token>\page.html` | 单次截图 | 截图成功后立即删除（截图为空/失败时整目录删除） |
| `%TEMP%\MarpWorkbench\capture-<token>\slide-N.(png|jpg)` | 供前端拉取 | **TTL 10 分钟**：每次新截图前清理超时目录；被清理后 `/api/export/tmp/...` 返回 404 |
| `%TEMP%\MarpWorkbench\` 下其它残留 | 兜底 | ① 每次 PDF 导出清理 **>7 天**条目；② 每次导出/截图额外清理 **>1 小时**的 `pdf-*` / `chrome-profile-*` / `cdp-profile-*`（异常中断残留兜底）；③ 删除采用「先等进程退出，再最多 5 次重试」 |
| `<数据目录>\exports\*.pdf/html/pptx` | 用户产物 | **不自动清理**（属于用户文件） |

安全：`GET /api/export/file/:name` 严格单段文件名 + 扩展名白名单 + 拒绝 `..`/分隔符（实测 `..%2F..%2Fsettings.json` → 400）；
`/api/export/tmp/:token/:file` 校验 token 十六进制与 `slide-N.(png|jpg)` 规则（非法文件名 400，过期 404）。

---

## 7. 接口实现对照（契约 §1.6）

| 端点 | 状态 | 说明 |
|---|---|---|
| `POST /api/export/pdf` | ✅ | 请求 `{html,css,title?,width?,height?,comments?}`；响应 `{fileUrl,bytes,pages,ms,browser}`（+browser 字段便于设置页展示） |
| `POST /api/export/capture` | ✅ | 请求加 `format?:"png"\|"jpeg"`；响应 `{images:[{index,url,w,h}],ms,fallback,mode,reason?}`；**CDP 不可用不报错**，返回 `fallback:true` 让前端降级 |
| `POST /api/export/html` | ✅ | 响应 `{fileUrl,bytes,ms}` |
| `GET /api/export/file/:name` | ✅ | `Content-Disposition: attachment; filename*=UTF-8''`；需 `X-MWB-Token`（前端 fetch→blob 下载） |
| `GET /api/export/tmp/:token/:file` | ✅ | 截图临时文件，TTL 10 分钟 |
| `GET /api/export/print/:token` | ❌ 未启用 | 改用 `file://` 静态打印页（原因见 §1），外部 API 无变化 |

并发：导出路由共用一把 `tokio::sync::Mutex` 串行化（无头浏览器吃内存，避免多实例并发），PDF/截图互斥但都不阻塞 HTTP 事件循环。

---

## 8. 前端约定（ExportPanel.vue）

`EditView.vue`（frontend-core）挂载方式与 props（已互发消息确认）：

```vue
<ExportPanel
  :deck-id="deck?.id || deckId" :title="title" :markdown="content"
  :render="() => ({ html, css, comments })"
  @close="exportOpen = false" @done="fileName => toast(...)" />
```

- `render()` 必须同步返回当前主题已生效的 `{html, css, comments}`；
- 组件只渲染面板内容（外层 modal 由 EditView 提供），面板内 `overflow:auto`；
- 可选 props：`width=1280`、`height=720`、`theme`；
- PPTX 为图片版（不可逐字编辑），UI 明示；失败给中文可执行提示；导出期间按钮 loading。
- 二进制下载用 `fetch` 带 `X-MWB-Token` → blob → `a.download`（fileUrl 受鉴权保护，不能直接 `location.href`）。

---

## 9. 已知限制 / M2 可做

1. **图片资源**：打印/截图页以 `file://` 打开，deck 内相对图片路径无法解析（`/api/decks/:id/assets/*` 需要 token 头）。
   M2 方案：前端导出前把图片内联成 dataURL（或给打印页加一次性资源 token 路由）。
2. PDF 备注未写入（M2 可做 PDF notes/书签）；PPTX 备注已写入。
3. marp auto-scaling 已通过注入 9.3KB browser helper 修复（§2.4）；`downscale-only` 主题对**极端超长**内容仍有
   最小缩放限制，超出部分会保持裁切——这与 Marp 预览行为一致（预览同样裁切），属于 Marp 语义而非导出缺陷。
4. 每次导出冷启动浏览器（PDF ~3–6s、截图 ~2.4s 启动 + ~1.1s 页面就绪）；M2 可常驻单实例 CDP 复用
   （预计二次导出 ~1–2s）。
5. 100+ 页大 deck 截图未单独压测（PNG 2s/页为渐变最坏情况；JPEG 通道按 30 页≈16s 推算富裕）。
6. 打印页/截图页未做“取消”中断（M1 允许，UI 有进度提示；进程超时 60s 自清理）。
7. `browser_helper.js` 是从 `@marp-team/marp-core@4.4.0` vendor 的 MIT 代码（带版权头）；
   升级 marp-core 后需重跑 `node spike/export/scripts/vendor-helper.mjs` 保持与前端渲染一致。

---

## 10. 复现命令

```powershell
# 0) 依赖（仅验证脚本用，不参与产品构建）
pnpm --dir spike/export install

# 1) 生成样例渲染结果 + 打印页/截图页（marp-core 3 页：中文/代码/渐变主题）
node spike/export/scripts/render-deck.mjs

# 2) PDF：Chrome / Edge 无头打印 + 验收（页数/960×540pt/中文/页眉页脚/背景）
node spike/export/scripts/export-pdf.mjs --browser=chrome --in=spike/export/out/print.html --out=spike/export/out/export-chrome.pdf
node spike/export/scripts/verify-pdf.mjs spike/export/out/export-chrome.pdf --pages 3
# 视觉核对背景渐变：渲染 PDF 页 → PNG（再看 spike/export/out/pdf-chrome-*.png）
node spike/export/scripts/render-pdf-pages.mjs spike/export/out/export-chrome.pdf pdf-chrome

# 3) CDP 原生截图（对照 html-to-image，保真对比）
node spike/export/scripts/capture-cdp.mjs
node spike/export/scripts/capture-h2i.mjs

# 3.1) auto-scaling 诊断（密集代码块：静态页裁切 vs 注入 browser helper 后）
node spike/export/scripts/diag-fit.mjs
#   helper 内嵌文件重新生成（升级 marp-core 后）
node spike/export/scripts/vendor-helper.mjs

# 4) PPTX 组装 + 解包校验（页数/16:9/notes/背景图尺寸）
node spike/export/scripts/build-pptx.mjs --prefix=cdp --ext=png
powershell -ExecutionPolicy Bypass -File spike/export/scripts/inspect-pptx.ps1 -Pptx spike/export/out/export-cdp.pptx

# 5) 服务端端到端（真实 release exe + 真实导出路由，含 PDF/capture/PPTX/HTML/安全用例）
cargo build --release --manifest-path server/Cargo.toml
node spike/export/scripts/e2e-server.mjs
```

---

## 11. 实测环境

Windows 10/11；Chrome 155.0.8059.84；Edge 155.0.4283.62；Rust 1.95；Node 22.13；pnpm 12.8；
marp-core 4.4.0；pptxgenjs 4.0.1；pdfjs-dist 4.10.38（仅验证脚本）。
release exe：`server/target/release/MarpWorkbench.exe` = **7,478,272 B（约 7.5MB，≤20MB 预算）**；
注入 9.3KB browser helper 对 exe 体积/导出耗时无可测量影响。

---

## 12. 端到端验收结果（真实 release exe，2026-10-20）

命令：`node spike/export/scripts/e2e-server.mjs [--format=png|jpeg]`（启动真实 exe，`MWB_DATA_DIR` 临时目录、`MWB_NO_OPEN=1`，
读 stdout 的 `MWB_LISTEN_URL` / `MWB_TOKEN`；产物 `spike/export/out/e2e-report.json`）。

| # | 用例 | 结果（PNG / JPEG 两种截图格式都跑） |
|---|---|---|
| 1 | exe 启动 + 读取监听 URL/TOKEN | ✅ |
| 2 | `POST /api/export/pdf` 200 | ✅ `ms=2382–4444` |
| 3 | PDF 下载（`X-MWB-Token`）+ `Content-Disposition: filename*=UTF-8''中文.pdf` | ✅ 83,761 B |
| 4 | PDF 3 页 / 960×540pt / 中文 18/46/40 / 无页眉页脚 | ✅（pdfjs 独立校验） |
| 5 | `POST /api/export/capture` 200 | ✅ PNG `ms=7137–11546` / JPEG `ms=5893` |
| 6 | capture 走 CDP 原生通道（`fallback:false, mode:"cdp"`） | ✅ |
| 7 | 3 张 2560×1440 图可下载 | ✅ |
| 8 | pptxgenjs 组装 PPTX | ✅ 4,256,637 B（PNG）/ 598,574 B（JPEG） |
| 9 | PPTX 解包：3 页 / `sldSz 12192000×6858000` / 3 条备注 / 背景图 2560×1440 | ✅ |
| 10 | `POST /api/export/html` + 单文件校验（内联 CSS/helper/viewer、无外网子资源） | ✅ 22,827 B |
| 11 | 导出文件路径穿越（`..%2F..%2Fsettings.json`）被拒 | ✅ 400 |
| 12 | 过期截图 404 / 非法截图文件名 400 | ✅ |
| 13 | `/api/shutdown` 正常退出 | ✅ |

**总计：PNG 18/18、JPEG 18/18；单轮 E2E 约 16–22s。**

临时文件清理实测：正常跑完 E2E 后 `%TEMP%\MarpWorkbench\` 下无 `pdf-*` / `chrome-profile-*` / `cdp-profile-*`
残留（截图目录按 10 分钟 TTL 保留，供前端拉图）；被强杀进程留下的旧 profile 会在下次导出时按 1 小时 TTL 清理。
删除采用「kill 后等进程退出 + 最多 5 次重试」，避免 Windows 文件句柄未释放导致删除失败。

---

## 13. M2 插入器（图片 / 表格 / 粘贴拖拽）

> 目标（用户原话）：*"图片插入优化（包括使用 bg 功能、透明的功能、左置右置占比功能）…让不懂 Markdown 的用户也能轻松使用"*。
> 契约：`docs/UI_CONTRACT_M2.md` §2.3 / §2.4 / §2.7。owner：export-eng。写范围：`web/src/insert/**`（不含 `EditorToolbar.vue`）。

### 13.1 文件与职责

| 文件 | 职责 |
|---|---|
| `web/src/insert/compose.ts` | 纯函数：图片/表格 snippet 生成、页切分（跳过 front-matter/代码围栏）、页首/页尾插入、光标行→页码、预览候选 md 合成 |
| `web/src/insert/upload.ts` | 上传（复用 `api/index.ts::uploadAsset`，mock 模式本地 dataURL 兜底）、资产下载、**`inlineDeckAssetUrls()` 资产内联**（预览/导出共用） |
| `web/src/insert/ImageInsertDialog.vue` | 图片插入对话框：选择/拖拽/粘贴上传 + 普通图/背景图选项 + 实时隔离预览 + emit `{snippet, mode}` |
| `web/src/insert/TableInsertDialog.vue` | 表格插入对话框：12×12 网格选行列、表头/对齐/首列加粗、单元格编辑、HTML 预览、emit `snippet` |
| `web/src/insert/pasteDrop.ts` | `attachImagePasteDrop(el,{onFiles}) → detach`：只拦截图片粘贴/拖拽，非图片放行；`pasteImageSnippet()` 默认宽度片段 |

组件 props/emits 严格按契约（`ImageInsertDialog`: `{deckId, markdown, currentPage, initialMode?}` → `insert({snippet,mode})`/`close`；
`TableInsertDialog`: `{markdown, currentPage}` → `insert(snippet)`/`close`），EditView 由 marp-tech 用 `import.meta.glob` 懒加载挂载，
**不需要再套 modal 容器**（对话框自带 `modal-mask`）。

### 13.2 UI 选项 → 生成语法（全部为标准 Marp Markdown）

| UI 操作 | 生成 Markdown | 说明 |
|---|---|---|
| 普通图片 · 原图 | `![](assets/x.png)` | 不写宽度 |
| 普通图片 · 25/50/75/100% | `![w:320px](assets/x.png)`（50% → 640px） | **marp-core 4.4 不支持 `w:50%` 百分比**，按当前页宽（16:9=1280px）换算成 px，仍是标准语法 |
| 背景图 · 整页 | `![bg](assets/x.png)` | 默认 cover |
| 背景图 · 左/右 + 占比 | `![bg left:40%](assets/x.png)` | 占比滑杆 20–70%，默认 40；右侧同理 `bg right:30%` |
| 背景图 · 适配 contain/fit | `![bg contain](...)` / `![bg fit](...)` | cover 为默认，不写 |
| 透明度 50% | `opacity:.5` | 0 = 不透明（不写）；100 = `opacity:0` |
| 模糊 5px / 灰度 | `blur:5px` / `grayscale` | 普通图片与背景图都支持（Marpi 滤镜） |
| 3×3 表格 + 居中 + 首列加粗 | GFM 表格（`:---:` 对齐行，首列数据 `**…**`） | 前后自动空行，插入后为普通 GFM |
| 粘贴/拖拽图片（快捷路径） | `![w:768px](assets/x.png)` | 约 60% 宽（同样换算 px），EditView 用 `pasteImageSnippet()` |

**实测依据**（`spike/export/scripts/verify-compose.mjs`，marp-core 4.4.0，15/15 通过）：
- `![w:640px]` → `<img style="width:640px">`；`![w:50%]` **不产生任何样式**（已改为 px）；
- `![bg left:40% opacity:.5 blur:5px grayscale]` → `<section data-marpit-advanced-background-split="left">` +
  `<figure style="background-image:url(...);filter:opacity(.5) blur(5px) grayscale(1)">`；
- `contain`/`fit` → `background-size:contain`；GFM 对齐行 → `<th style="text-align:center">` 生效；
- 分页工具不会把代码围栏里的 `---` 当分页；页首插入不会打断 `<!-- _class: lead -->`；页尾插入自动加空行，
  避免 `图片行\n---` 被 markdown 解析成 setext 标题（回归用例已覆盖）。

### 13.3 预览与资产（关键坑 + 解决）

- 资产读取接口 `GET /api/decks/:id/assets/:name` 需要 `X-MWB-Token` 头，`<img src>`/iframe 无法携带 →
  对话框预览在渲染候选 md 后调用 `inlineDeckAssetUrls(html, deckId)`，把 `assets/x.png` 换成 dataURL，
  再注入**独立 iframe**（`div.marpit>svg` 只显示当前页 + `scale` 适配；样式完全隔离，不污染主界面）。
- **导出也复用同一内联逻辑**：`ExportPanel.vue` 在 PDF/PPTX/HTML 导出前，若渲染结果含 `assets/` 引用，
  先内联成 dataURL 再 POST——否则打印页走 `file://` 无法带 token 取图，插入的背景图/图片会在 PDF/PPTX 中丢失。
  内联失败不阻断导出，结果面板会提示「有 N 张图片未能读取」。
- 上传后 Markdown 里**只写相对路径** `assets/x.png`（marp-tech 约定，可拷回 VS Code；PreviewPane 由 frontend-core 负责 blob 化）。
  文件名为中文/空格时按 URL 编码写入（`encodeURI`，含空格/括号时用 `<>` 包裹 dest）。

### 13.4 EditView 集成（marp-tech 负责，已互发约定）

```ts
// 图片：mode=image → 光标处插入；mode=background → 当前页页首（可用 frontmatter.insertAtPageStart）
<ImageInsertDialog v-if="imageDialogOpen" :deck-id="deckId" :markdown="content"
  :current-page="currentPage" :initial-mode="imageMode"
  @insert="onImageInsert" @close="imageDialogOpen=false" />
// 表格
<TableInsertDialog v-if="tableDialogOpen" :markdown="content" :current-page="currentPage"
  @insert="snippet => { editor.insertText(snippet, {block:true}); tableDialogOpen=false }"
  @close="tableDialogOpen=false" />

// 粘贴/拖拽快捷路径（编辑器容器）
const detach = attachImagePasteDrop(editorEl, {
  onFiles: async (files) => {
    const asset = await uploadAsset(deckId, files[0])
    editor.insertText(pasteImageSnippet(asset.path), { block: true })
  },
})
onBeforeUnmount(detach)
```

### 13.5 自测 / 复现

```powershell
# 1) 语法 & 分页逻辑（esbuild 编译 compose.ts → 真实 marp-core 渲染断言，15/15 通过）
node spike/export/scripts/verify-compose.mjs

# 2) 前端生产构建（含 InsertDialog/TableInsertDialog/compose/upload/pasteDrop 懒加载 chunk）
pnpm --dir web build

# 3) 真实浏览器冒烟（Vite dev + mock 模式，无需后端；11/11 通过）
$env:MWB_DEV_PORT='5183'; pnpm --dir web dev      # 另开一个终端
$env:MWB_UI_BASE='http://localhost:5183'; node spike/export/scripts/verify-m2-ui.mjs
#   覆盖：打开编辑器 → 图片对话框 → 上传图 → 切背景图/左侧 40% → 预览 iframe（仅当前页 + split=left +
#   资产已内联 dataURL）→ 插入成功 toast → 表格对话框 → 网格选 5×4 → 插入成功 toast → 无页面 JS 错误
#   截图：spike/export/out/m2-image-bg.png、m2-table-dialog.png
```

**实测结果（2026-10-20）**：`verify-compose` 15/15；`pnpm --dir web build` 成功
（ImageInsertDialog 12.26KB / TableInsertDialog 5.94KB / compose 3.88KB / upload 2.52KB / pasteDrop 1.91KB 懒加载 chunk）；
真实浏览器冒烟 11/11，对话框内预览可正确显示「背景图左侧 40% + 当前页」，插入后 toast「已插入背景图 / 已插入表格」，无 JS 错误。

**集成现状与待办**：EditView（marp-tech）已挂载两个对话框并接通 `insert`/`close` 与页首插入；
粘贴/拖拽快捷路径已接 `attachImagePasteDrop`，但其插入片段仍硬编码 `![w:60%]`（marp-core 忽略百分比）。
已建议改用本模块 `pasteImageSnippet()`（返回 `![w:768px]`），属 marp-tech 文件内的 1 行替换，不阻塞 M2 验收。

> 未完成/边界：普通图片「原图」尺寸取决于图片原始像素（Marp 语义）；超高图片仍可能被主题
> `overflow:hidden` 裁切（与预览一致）。对话框对超大图（>20MB）直接拒绝并提示。


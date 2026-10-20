# MarpWorkbench —— M1 接口契约与工程约定 v1

> 用途：M1 骨架阶段前后端/导出/主题并行开发的**唯一接口依据**。
> 状态：v1，2026-10-20，M1 开工。变更需在群里同步并由 Lead 更新本文件。
> 关联：`docs/PROJECT_PLAN.md`（v1.1）、`docs/research/*.md`（实测依据）。

---

## 0. 工程约定

### 0.1 目录与所有权（避免写冲突）

| 目录/文件 | 所有者 | 说明 |
|---|---|---|
| `server/src/main.rs`、`server/src/routes/**`、`server/src/state.rs`、`server/src/assets.rs`、`server/Cargo.toml` | server-core | Rust 服务主体 |
| `server/src/export/**`、`server/src/routes/export.rs` | export-eng | 导出实现（server-core 只建 stub 并 wire 路由） |
| `web/**`（除 `web/src/export/**`、`web/src/themes/**`） | frontend-core | Vue 应用、编辑器、预览、工作区 UI |
| `web/src/export/**` | export-eng | 导出面板、PPTX 组装（pptxgenjs） |
| `web/src/themes/**` | themes | 主题画廊/切换面板 |
| `themes/**` | themes | 内置主题 CSS |
| `docs/**`、根级脚本 | Lead | 计划、契约、构建编排 |

> 规则：只写自己范围内的文件；需要改别人的文件先在群里说明，由 Lead 裁决。不要把 `node_modules/`、`target/`、`out/` 提交进 git；**不要自己执行 git commit**（Lead 统一提交）。

### 0.2 技术栈（已定，勿改）

- 服务端：Rust 2021 + axum 0.8 + tokio 1（rt-multi-thread/macros/net）+ rust-embed 8 + serde/serde_json + rfd（文件对话框，M1 可延后）+ zip（PNG 打包，M1 可延后）。
- release profile：`opt-level="z"`、`lto=true`、`codegen-units=1`、`strip=true`、`panic="abort"`；release 下 `#![windows_subsystem = "windows"]`（无控制台窗口）。
- 前端：Vite 7 + Vue 3（`<script setup>`）+ TypeScript + CodeMirror 6 + Pinia（可选）+ `@marp-team/marp-core@4.4.0`（浏览器 bundle 由 esbuild 单独构建）+ `pptxgenjs`。
- 构建顺序：`scripts/build-marp-browser.mjs`（esbuild → `web/public/marp-core.browser.js`，全局 `MarpCoreBundle.MarpCore.{Marp,browser}`）→ `pnpm --dir web build`（产物 `web/dist/`）→ `cargo build --release`（rust-embed 内嵌 `web/dist`）。
- 端口：`127.0.0.1:0` 由系统分配；启动后 `cmd /C start "" "<url>"` 打开默认浏览器。
- 启动参数/环境变量（M1 必须支持，供联调/CI/冒烟）：
  - `MWB_DATA_DIR`：数据目录覆盖（冒烟必须能隔离）。
  - `MWB_WEB_DIR`：前端 dist 目录覆盖（debug 构建用）。
  - `MWB_NO_OPEN=1` 或命令行 `--no-open`：不自动打开浏览器（CI/冒烟用），启动后把 `MWB_LISTEN_URL=<url>` 与 `MWB_TOKEN=<token>` 打印到 stdout，供脚本读取。
  - `MWB_PORT`：固定端口（默认 0=系统分配；被占用则回退 0）；`--version` 打印版本号后退出（打包 smoke 用）。
- 数据目录：默认 `%USERPROFILE%\Documents\MarpWorkbench\`；exe 同目录可写且存在 `portable.marker`/`data\` 时用便携模式。

### 0.3 通用协议

- 所有 API 前缀 `/api`；**全部**（含 `GET /api/health`）要求请求头 `X-MWB-Token: <token>`（M1 实测实现如此；脚本/CI 一律带 token；第二实例通过数据目录派生的锁文件获取已有实例的 URL/token）。
- token：服务启动时随机生成（≥32 hex）；浏览器首次打开 URL 为 `http://127.0.0.1:<port>/?token=<token>`；前端读 query 后存 `sessionStorage('mwb.token')` 并清理地址栏。
- 跨域防护：校验 `Origin`/`Referer` 为本服务 URL 或为空（本地直接请求）；`GET` 静态资源不鉴权但也不含敏感数据。
- 返回 JSON；错误统一：
  ```json
  { "error": { "code": "NOT_FOUND|BAD_REQUEST|CONFLICT|INTERNAL|EXPORT_FAILED|DEP_UNKNOWN", "message": "中文可读说明", "detail": "可选" } }
  ```
  HTTP 状态码语义化（400/404/409/500）。
- 时间：ISO 8601 字符串（UTC，带 Z）。
- deck id：工作区内 deck 目录名（`<工作区>/<id>/slides.md`），允许中文；API 路径中 URL 编码；服务端拒绝 `..`、`/`、`\`、`:` 等非法字符与保留名。

---

## 1. 服务端 API（M1 必须）

### 1.1 健康与生命周期

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/api/health` | — | `{ok:true, app:"MarpWorkbench", version:"0.1.0", pid, port, workspaceRoot, startedAt}` |
| POST | `/api/shutdown` | — | `{ok:true}`；服务保存全部后退出（进程退出 0） |
| GET | `/api/browser` | — | `{chrome?:string, edge?:string, usable:boolean, preferred:"chrome"\|"edge"\|null}`（M1 供导出探测/设置页展示） |

### 1.2 设置

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/api/settings` | — | `{workspaceRoot, defaultTheme, autosaveMs, idleExitMinutes, locale:"zh-CN"}` |
| PUT | `/api/settings` | 同结构（部分字段） | 更新后的 settings |

### 1.3 工作区与 deck

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/api/workspace` | — | `{root, decks:[{id, name, updatedAt, createdAt, bytes, pages}]}`（pages 可为 null，M1 由前端填） |
| POST | `/api/decks` | `{name?:string, template?:"blank"\|"title"\|"sample"}` | `{id, name, content, rev}`（目录不存在则创建，重名自动加序号） |
| GET | `/api/decks/:id` | — | `{id, name, content, rev, updatedAt, assets:[{path,url}]}` |
| PUT | `/api/decks/:id` | `{content:string, ifRev?:string}` | `{rev, savedAt}`；`ifRev` 与当前不符 → 409 `CONFLICT`（前端据此提示"已在别处修改"） |
| POST | `/api/decks/:id/rename` | `{name:string}` | `{id, name}` |
| DELETE | `/api/decks/:id` | — | `{ok:true}`（移到 `.trash/<id>-<ts>/`，不物理删除） |
| GET | `/api/recent` | — | `[{id, name, updatedAt}]`（最多 20） |

`rev` 规则：内容 sha256 前 16 位；PUT 时计算新 rev。

### 1.4 资源（图片/附件）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| POST | `/api/decks/:id/assets` | `multipart/form-data`，字段 `file`（png/jpg/jpeg/gif/webp/svg） | `{path:"assets/xxx.png", url:"/api/decks/<id>/assets/xxx.png", bytes}`；同名加 `-1` 序号 |
| GET | `/api/decks/:id/assets/:name` | — | 原始文件字节（正确 Content-Type） |

### 1.5 主题

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/api/themes` | — | `{themes:[ThemeMeta]}`；`ThemeMeta = {name, displayName, source:"builtin"\|"user", tags:string[], author?, size?:string[], autoScaling?:boolean, css:boolean}`。**`css` 语义 = 服务端是否内联 CSS 内容**；M1 恒 `false`（表示"需要单独 GET /api/themes/:name/css"），**客户端不能据此跳过主题加载**（M1 联调踩过该坑）。 |
| GET | `/api/themes/:name/css` | — | `text/css` 原文 |
| POST | `/api/themes` | `{css:string, fileName?:string}` 或 multipart | `ThemeMeta`；校验 `/* @theme name */` 存在且唯一；非法 → 400 |
| PUT | `/api/themes/:name` | `{css:string}` | `ThemeMeta` |
| DELETE | `/api/themes/:name` | — | `{ok:true}`（仅 user 主题） |

内置主题目录：`themes/*.css`（构建期内嵌）；用户主题：`<数据目录>\themes\*.css`。

### 1.6 导出（M1 核心）

**流程：前端用 marp-core 渲染出 `{html, css, comments}` → POST 给服务端 → 服务端生成静态打印页 → 调本机 Chrome/Edge。**

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| POST | `/api/export/pdf` | `{html:string, css:string, title?:string, width?:number=1280, height?:number=720, comments?:string[]}` | `{fileUrl:"/api/export/file/<name>.pdf", bytes, pages, ms}` |
| POST | `/api/export/capture` | `{html, css, width?, height?, scale?:1\|2, slideCount?:number}`（多页截图为 PPTX 用） | `{images:[{index, url:"/api/export/tmp/<token>/slide-1.png", w, h}], ms}` |
| POST | `/api/export/html` | `{html, css, title?, comments?}` | `{fileUrl, bytes}`（单文件 HTML） |
| GET | `/api/export/file/:name` | — | 文件字节；`Content-Disposition: attachment; filename*=UTF-8''<编码中文名>` |
| GET | `/api/export/tmp/:token/:file` | — | 临时 PNG 字节（capture 产物，TTL 10 分钟自动清理） |

- 服务端实现要求（来自实测，必须遵守）：
  - 打印页：`@page{size:<width>px <height>px;margin:0}` + `print-color-adjust:exact` + 每页 `break-after:page`（最后一页 auto）。
  - Chrome 优先、Edge 兜底；`--user-data-dir=%TEMP%\MarpWorkbench\chrome-<rand>`；`--no-pdf-header-footer`；Edge 打印完不退出 → 轮询 PDF「存在且大小稳定 300ms」后 `taskkill /T /F`；超时 60s 报 `EXPORT_FAILED`。
  - 异步 spawn，禁止阻塞 tokio 运行时（用 `tokio::process` + 独立任务）。
  - PPTX 截图优先走 CDP（`Page.captureScreenshot`，2x）；CDP 不可用时降级 html-to-image 方案由前端处理并在 UI 标注"快速版"。
  - 所有导出文件写入 `<数据目录>\exports\`（PNG 临时文件写 `%TEMP%`），并清理临时目录。

**PPTX 由前端组装（服务端只出图）**：前端 `fetch` 每个 image url → `blob` → `dataURL` → `pptxgenjs`：
```js
const pptx = new PptxGenJS()
pptx.defineLayout({ name: 'MWB', width: 13.333, height: 7.5 })
pptx.layout = 'MWB'
// 每页：slide.background = { data: dataUrl }; slide.addNotes(comments[i] || '')
await pptx.writeFile({ fileName })
```

### 1.7 静态资源与 SPA

- `GET /`、`GET /edit/:id`、`GET /settings` → 返回内嵌 `index.html`（SPA fallback）。
- `GET /assets/*`、`/marp-core.browser.js`、`/themes/*.css`、`/fonts/*` → 内嵌静态资源（带 br/gzip；`Content-Encoding`）。
- `GET /api/export/print/:token`（内部）→ **未启用**：M1 实现改为把打印页写成 `%TEMP%\MarpWorkbench\...\print.html` 用 `file://` 交给无头浏览器打印（CLI 无法携带 X-MWB-Token 头；实测 file:// 与本地 HTTP 打印质量/字节一致），外部 API 不变。
- `POST /api/export/capture` 支持可选 `format:"png"|"jpeg"`（默认 png；PPTX 导出面板按页数自动选择：≤10 页 PNG，>10 页 JPEG q90 以控制耗时）。

---

## 2. 前端契约

### 2.1 启动与鉴权

```ts
// main.ts 启动时
const token = new URL(location.href).searchParams.get('token') ?? sessionStorage.getItem('mwb.token')
sessionStorage.setItem('mwb.token', token)
history.replaceState(null, '', location.pathname + location.hash) // 清掉地址栏 token
// api.ts
export const api = (path, init = {}) => fetch(`/api${path}`, {
  ...init,
  headers: { 'Content-Type': 'application/json', 'X-MWB-Token': token!, ...(init.headers || {}) },
})
```

### 2.2 marp 渲染（前端唯一渲染源）

```ts
// 构建期：scripts/build-marp-browser.mjs 产出 web/public/marp-core.browser.js（IIFE，全局 MarpCoreBundle.MarpCore）
const { Marp, browser } = (window as any).MarpCoreBundle.MarpCore
const marp = new Marp({ html: true, math: 'mathjax', script: false })  // script:false + 手动 browser()
for (const t of themeList) marp.themeSet.add(t.css)                    // 内置 + user + 项目主题
const { html, css, comments } = marp.render(markdown)                  // comments[i] = 第 i 页备注
// 预览：iframe srcdoc，注入 <style>${css}</style> + html，并调用 browser(iframe.contentDocument.body)
```

- 主题切换 = 改 markdown front-matter `theme:` → 重新 `render()` → 更新 iframe（预算 ≤300ms）。
- 主题画廊缩略图 = 同一 marp 实例按主题改写 front-matter 渲染 1–3 页 → DOM `transform:scale()`（不要截图）。
- 离线：默认 `math: 'mathjax'`；不要加载任何外网资源（验收拦截）。

### 2.3 路由与页面

| 路由 | 页面 | M1 内容 |
|---|---|---|
| `/` | 首页/工作区 | 工作区路径、deck 列表、新建（空白/示例）、导入 md、最近文件、打开所在文件夹（M1 可只复制路径） |
| `/edit/:id` | 编辑器 | 左 CodeMirror、右 iframe 预览、顶部（文件名/保存状态/主题入口/导出按钮）、自动保存 |
| `/settings` | 设置 | 工作区路径、默认主题、导出浏览器探测结果、退出应用、关于 |

### 2.4 交互规范（M1）

- 自动保存：编辑停止 800ms 防抖 + 每 30s 强制；状态栏显示"已保存 HH:mm:ss"；`Ctrl+S` 立即保存并拦截浏览器默认。
- `Ctrl+P` 拦截，打开导出面板。
- 导出期间按钮 loading、可取消（M1 可先不做取消，但要有进度提示）。
- 所有 API 失败要有可读中文提示（不许白屏/	console 报错了事）。

---

## 3. 主题格式（themes/）

```css
/* @theme business-blue */
@import 'default';

/* @name 商务蓝 */
/* @tags 商务,汇报,蓝色,浅色 */
/* @size 16:9 1280px 720px */
/* @auto-scaling false */

section { background: #ffffff; color: #1a2233; font-family: 'Microsoft YaHei', 'Segoe UI', sans-serif; }
section.lead { ... }
```
> 注意：`@import 'default';` 必须是**真实 CSS @import 语句**（放在注释里不会生效）。
- 必须包含 `@theme`；扩展注释 `@name/@tags` 可选（缺省用 name）。
- 深色主题必须在 PDF 打印时保留背景（`-webkit-print-color-adjust:exact` 由打印页统一加）。
- 每个主题必须覆盖：`section`、`section.lead`、`h1/h2`、`code/pre`、`table`、`blockquote`、页码/页脚样式。

---

## 4. 验收命令（Lead 用）

```powershell
# 1) 构建前端 + marp bundle
pnpm --dir web build
# 2) 构建 exe
cargo build --release --manifest-path server/Cargo.toml
# 3) 运行（双击等价）
server\target\release\MarpWorkbench.exe
# 4) smoke：health / 新建 deck / 保存 / 导出 PDF / 导出 PPTX
node scripts/smoke.mjs   # M1 由 Lead 补齐
```

---

## 5. M1 任务拆分（对应共享任务板）

| 任务 | 内容 | 所有者 | 依赖 |
|---|---|---|---|
| task-4 | server-core：Rust 服务骨架（静态资源/鉴权/单实例/开浏览器/退出/工作区 API/主题 API/设置/health） | desktop-packaging | 本契约 |
| task-5 | frontend-core：Vue 骨架（首页/编辑器/预览/自动保存/主题选择/导出面板挂载点） | marp-tech | 本契约 + task-4 API 可联调（可先用 mock） |
| task-6 | export-eng：导出管线（打印页生成/无头浏览器调用/CDP 截图/PDF/HTML/capture API）+ 前端导出面板 + pptxgenjs 组装 | 新成员 export-eng | task-4 骨架 + task-5 渲染数据 |
| task-7 | themes：6 套主题 CSS + 主题切换面板组件（M2 画廊的前置） | ux-competitors | 本契约 §3 |

> M1 验收：干净机器双击 exe → 写 3 页 → 选主题 → 导出 PPTX/PDF，≤3 分钟；`docs/PROJECT_PLAN.md` §8 M1 验收。

# 运行时与导出通道选型（Marp Windows 便携单文件 exe）

> 目标形态（Lead 已确认）：**便携版单文件 exe，双击后启动本地 HTTP 服务并自动打开系统默认浏览器，UI 是网页**。要求尽可能轻量：体积小、启动快、目标机零依赖。
>
> 结论先行：**推荐 Rust（axum + tokio + rust-embed）单文件 exe（实测 0.50 MB）+ 浏览器 UI + 调用本机 Chrome/Edge headless 导出 PDF**。Electron / Tauri 降级为对照组。PDF 导出链路已在 Windows 本机端到端实测通过（3 页 & 100 页、页面精确 960×540pt=1280×720px、中文可提取、背景/渐变已打印、无白边裁切证据）；顶点是“本机必须存在 Chrome 或 Edge”——Windows 10/11 自带 Edge，可满足。

调研日期：2026-10-20 ｜ 环境：Windows、Node 22.13.0、npm 10.9.2、pnpm 12.8.1、Rust 1.95.0/cargo 1.95.0、dotnet 7.0.102、WebView2 Runtime 155、**Edge 155.0.4283.62、Chrome 155.0.8059.84**。

---

## 0. TL;DR（可直接进项目计划）

| 事项 | 结论 |
|---|---|
| 运行时 | **Rust**（axum 0.8 + tokio 1 + rust-embed 8）。实测 release 单文件 **0.50 MB**，零运行时依赖，内嵌前端资源，bind `127.0.0.1:0` 动态端口，用系统默认浏览器打开 UI |
| PDF 导出（P0） | **主通道：调用本机 Chrome/Edge headless 进程打印本地 HTTP URL**。Chrome 155 实测 3 页 4.13s / 100 页 8.34s，页面尺寸精确，中文/背景正常。Edge 155 同样能打印但**进程打印完不退出**，必须「检测 PDF 落盘后 kill」或走 CDP |
| 用户点“导出”但机器没 Chrome？ | 优先 Chrome → 回退 Edge（Win10/11 必有 Edge）；仍失败则回退浏览器内 `window.print()`（体验降级但可用） |
| PPTX（P1/P2） | 图片版：浏览器内 marp-core 渲染 → html-to-image(2x) 截图 → pptxgenjs 打包（16:9 自定义尺寸、每页贴图 + notes）。**不要**用 headless 每页起进程截图（单次进程启动实测 2.0–2.9s，100 页不可接受） |
| 排除 | Electron（100MB+ 与轻量目标冲突）、Tauri（无官方 print/PDF API，导出仍得外挂浏览器）、Node SEA（node.exe 实测 79.4MB → 产物 ≥80MB）、Bun（产物 50–100MB） |
| **不做 Electron/Tauri 一句话理由** | Electron 单文件/安装包 100MB+ 与「轻量便携」直接冲突；Tauri 体积达标但**官方无任何打印/PDF API**（实测 API 类型无 `print`/`printToPDF`，相关 issue 未解决），导出仍要外挂 Edge/Chrome 或写 WebView2 COM，复杂度反超「Rust 本地服务 + 系统浏览器」方案。 |
| 备选 | Go（内嵌资源 + 单文件 5–12MB、编译秒级；本机未装，值得作为团队更熟 Go 时的备选）；.NET 7 单文件（12–15MB，体积居中） |
| 关键风险 | Edge headless 不退出需强杀；headless CLI 行为随浏览器版本变化（需做版本兼容与超时/降级）；目标机字体（中文用系统微软雅黑，自定义字体须内嵌 woff2）；未签名 exe 的 Defender/SmartScreen 提示 |

---

## 1. 【最高优先·已实测】PDF 导出路线：本机浏览器 headless 打印

### 1.1 结论

- **可行且质量达标**：`msedge.exe / chrome.exe --headless --print-to-pdf=... URL` 能对**本地 HTTP URL** 正确打印，每页一张 slide，页面尺寸精确等于 CSS `@page` 尺寸。
- **主通道用 Chrome**（进程会正常退出）；**Edge 作为兜底**（Win10/11 一定有），但 Edge 155 实测「打印完成后进程不退出」，实现上必须轮询 PDF 落盘并强杀（本次实测已用该策略跑通）。
- 想要更可控（批量导出、可控进度、避免进程不退出）→ 后续升级为 **CDP `Page.printToPDF`**（`--remote-debugging-port`），参数等价于 Electron 的 `printBackground/preferCSSPageSize/pageSize`。

### 1.2 可复现实测

关键页面（3 页 deck）含：中文、深色背景、CSS 渐变、代码样式、每页角标；`@page { size: 1280px 720px; margin: 0 }`；每页 `width:1280px; height:720px; page-break-after:always`。

```powershell
# 1) 起本地静态服务（模拟便携 exe 内置 HTTP 服务）
node spike/packaging/browser-print/serve.mjs            # 默认 127.0.0.1:18765
# 2) 主通道：Chrome headless 打印
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --headless --disable-gpu `
  --no-first-run --no-default-browser-check --user-data-dir="$env:TEMP\marp-export-profile" `
  --no-pdf-header-footer --virtual-time-budget=4000 `
  --print-to-pdf="<abs path>\out\deck.pdf" "http://127.0.0.1:18765/deck.html"
# 3) 校验（页数/尺寸/文本/中文/背景）：
node spike/packaging/browser-print/verify.mjs "<abs path>\out\chrome-deck-http.pdf" --strict
# 4) 一键矩阵（Edge + Chrome + 对照组 + 100 页）：
powershell -File spike/packaging/browser-print/run-matrix.ps1
```

### 1.3 实测数据（本机 Windows，2026-10-20）

| # | 用例 | 浏览器 | 页数 | PDF 页面尺寸 | PDF 大小 | 耗时* | 结果 |
|---|---|---|---|---|---|---|---|
| 1 | 3 页 deck，本地 HTTP，`@page 1280x720`，`--no-pdf-header-footer` | **Chrome 155.0.8059.84** | 3 | **960×540 pt**（=1280×720px @96dpi，16:9） | 106.7 KB | **4.13 s** | ✅ 通过 |
| 2 | 同 1，**Edge 155.0.4283.62** | Edge | 3 | 960×540 pt | 106.7 KB | 约 4 s 落盘 | ⚠️ PDF 正确，但**进程不退出**，须 kill |
| 3 | 100 页 deck（每页不同背景/文字） | Chrome | **100** | **全部 960×540 pt**（逐页核对） | 384.3 KB | **8.34 s** | ✅ 通过 |
| 4 | 对照：去掉 `@page` 规则 | Chrome | 3 | **612×792 pt（Letter）** | 28.5 KB | 3.9 s | ❌ 内容被缩放、上下大量白边 → **证明 @page 是必要条件** |
| 5 | 对照：不加 `--no-pdf-header-footer` | Chrome 155 | 3 | 960×540 pt | 109210 B（与 #1 **完全相同**） | 3.9 s | 新版 headless 默认已无页眉页脚；仍建议显式传参防版本差异 |
| 6 | 对照：`file://` 直接打开（不经 HTTP） | Chrome | 3 | 960×540 pt | 106.7 KB | 4.13 s | 可用；仍推荐 HTTP（相对资源/模块/字体/调试一致） |
| 7 | Rust 内置服务 + Chrome 打印（真实链路） | Chrome | 3 | 960×540 pt | 106.7 KB | 4.17 s | ✅ 端到端通过 |
| 8 | 同一 profile 复用后二次导出（100 页，热缓存） | Chrome | 100 | 960×540 pt | 384.3 KB | **2.37 s** | ✅ 冷启动/热复用差异明显，可做常驻实例优化 |

\* 耗时为「启动 headless 浏览器进程 → 打印出 PDF 文件」的墙钟时间；数据来源：`spike/packaging/out/`（PDF 产物 + `verify-*.json`），执行记录见本文与脚本 `browser-print/run-matrix.ps1`（输出 `out/edge-export-report.json`）。**冷启动 3 页约 4.1–4.3s，100 页约 8.3s；同 profile 热复用 100 页可降到 ~2.4s。**

**质量/版面校验（来自 `verify.mjs`，pdfjs + pdf-lib 字节级检查）**：
- 页数/尺寸：3 页全部 `960.0×540.0 pt`，与 1280×720 CSS px 精确对应（96dpi→72dpi 的 0.75 换算）。
- 文本：每页可提取 112 / 148 / 75 字符，其中中文 36 / 15 / 37 字 → **文字是矢量可选中，不是整页位图**，CJK 字体嵌入正常。
- 页眉页脚：文本中无 `127.0.0.1/http://`/日期 → `--no-pdf-header-footer` 生效。
- **无白边/无裁切证据**：页 2 存在整页填充色 `#0b1020`（RGB 11,16,32），页 3 渐变通过 `setFillColorN`（pattern/gradient）绘制 → 背景与渐变确实被打印；文本包围盒 = `minX 66pt / maxX 924pt / minY 34.5pt / maxY 448.5pt`，而 CSS 左右 padding 88px×0.75=66pt、角标右距 48px×0.75=36pt（960−36=924pt）——坐标与 CSS 完全 1:1 对应，内容全部落在页面内，无缩放、无裁切、无白边。
- 100 页产物 384.3 KB（≈3.8KB/页）→ 纯矢量文本 PDF，体积极小。

### 1.4 实测踩到的坑（实现时必须处理）

1. **Edge headless 打印完不退出**：PDF 已在 ~4s 内落盘，但 `msedge.exe` 进程常驻（Edge 后台特性）。实现：启动后轮询目标 PDF 文件「存在且大小稳定 ≥N ms」，然后 `taskkill /T /F`；或直接改用 CDP。Chrome 无此问题。
2. **HTTP 服务与打印进程必须解耦**：本项目第一次用 Node 同进程 `spawnSync` 调浏览器时，事件循环被阻塞，浏览器请求本地 HTTP 一直等不到响应 → 超时。**服务在独立进程/线程，打印用异步 spawn 或外部进程**。
3. **`--user-data-dir` 必须给独立临时目录**：复用默认用户 profile 会与用户正在用的浏览器实例冲突、可能弹首次运行/恢复提示；导出结束清理。
4. **显式传 `--no-pdf-header-footer`**：避免旧版本/不同渠道默认带 URL+日期页眉页脚；同时用 `--virtual-time-budget=4000` 给字体/布局/渐变留渲染时间（本地页面足够，实测 3–8s 内完成）。
5. **`@page { size: 1280px 720px; margin: 0 }` + 每页 `page-break-after: always`（最后一页 `auto`）** 是“每页一张 slide”的关键；缺 `@page` 会退化为 Letter 并产生白边（实测对照 #4）。
6. **背景/渐变**：CLI 下靠 CSS `-webkit-print-color-adjust: exact; print-color-adjust: exact;` 保证打印背景（实测已输出）；若改 CDP，可直接传 `printBackground: true, preferCSSPageSize: true, pageSize: {width:13.3333,height:7.5}`。
7. **字体离线可用性**：中文用系统字体（Microsoft YaHei）没问题；主题自定义字体必须在应用内打包 woff2 + `@font-face` 本地加载（不能依赖 Google Fonts 等网络字体）。
8. **浏览器检测顺序**：Chrome（干净退出）→ Edge（需 kill）→ 浏览器内 `window.print()` 兜底；用标准安装路径 + Windows App Paths 注册表（`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe`）探测。
9. **性能**：每次导出冷启浏览器约 2–4s（3 页 4.1s、100 页 8.3s）。MVP 可接受；若做「导出预览/批量导出」，建议常驻一个 headless 实例（CDP）复用，把二次导出降到 ~1s 级。
10. **安全**：本地服务只 bind `127.0.0.1` + 随机 token 校验；导出时校验 URL 属于本服务，避免被本机其他程序诱导打印任意页面。

### 1.5 对照方案 B：浏览器内 `window.print()`（不额外起进程）

- 体验：用户点“导出”后弹出系统打印对话框，需手动选 **“另存为 PDF”**、选保存路径、注意**“背景图形”默认不勾选会丢背景**、纸张/边距/缩放可能被用户改动；Chrome/Edge/系统版本 UI 不同；无法程序化拿到进度/结果/文件名，失败无反馈。
- 可靠性：中低（依赖用户操作 + 用户打印机驱动；“每页一张 slide”依赖 @page 能被打印对话框正确采用，跨版本有风险）。
- 优点：零额外进程、无浏览器探测、离线绝对可用。
- **结论**：不作为主通道，作为**兜底**（UI 里提示“更多设置 → 纸张：自定义/边距：无/勾选背景图形 → 另存为 PDF”）。

### 1.6 对照：原 Electron / Tauri 方案（为何降级）

- **Electron**：`webContents.printToPDF` 质量与参数最可控（`printBackground`、`preferCSSPageSize`、`pageSize` 英寸、`margins` 等，见官方结构文档），但运行时太重：Electron 44 安装包 90–110MB、解压 250MB+，与「轻量单文件 exe」直接冲突 → 排除。
- **Tauri 2**：体积优势明显，但**官方无打印/PDF 导出 API**：实测 `@tauri-apps/api@2.12.4` 全部 `.d.ts` 中不存在 `print/printToPDF`（仅 `println!` 文档示例）；社区 issue 仍是开放需求（[wry #707](https://github.com/tauri-apps/wry/issues/707)、[tauri #4917](https://github.com/tauri-apps/tauri/issues/4917)、[tauri #3066 window.print 不工作](https://github.com/tauri-apps/tauri/issues/3066)）。可行路线只剩：社区插件（质量/维护不可控，如 [tauri-plugin-printer](https://github.com/felipeejunges/tauri-plugin-printer)）、自己在 Rust 里调 WebView2 COM `PrintToPdfAsync`（[MS 文档](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2_16)）、或外挂 Chrome → 均比“纯 Rust 服务 + 系统浏览器”更复杂，故排除。

### 1.7 Rust 服务端导出实现要点（落地清单）

1. **浏览器探测**：优先 Chrome（正常退出）→ Edge（需 kill）；查标准路径 + 注册表 `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe|msedge.exe`；都没有 → 返回错误并提示用户用 `window.print()`。
2. **spawn 参数**（Rust `std::process::Command`，Windows 加 `CREATE_NO_WINDOW`）：
   ```
   --headless --disable-gpu --no-first-run --no-default-browser-check
   --user-data-dir=<%TEMP%\marp-lite-export-<uuid>>
   --no-pdf-header-footer --virtual-time-budget=4000
   --print-to-pdf=<绝对路径>.pdf  http://127.0.0.1:<port>/print?token=<token>&deck=<id>
   ```
   附加：`--disable-extensions --disable-sync --disable-background-networking` 降低干扰。
3. **等待策略**：轮询 PDF「存在且大小连续两次（间隔 150ms）不变」即视为完成；Chrome 通常同时退出（exit code 0）。总超时 **60s**（100 页实测 8.3s，余量充足）→ 超时 `kill`（对 Edge 用 `taskkill /T /F` 或 Job Object 杀进程树）后仍按 PDF 是否存在判定。
4. **临时文件**：`--user-data-dir` 独立临时目录，成功/失败/超时都在 `finally` 删除；导出 PDF 写用户选定路径（不在临时目录留副本）；崩溃恢复时清理 `%TEMP%\marp-lite-export-*` 旧目录。
5. **错误码（返回前端）**：`E_NO_BROWSER` / `E_SPAWN` / `E_TIMEOUT` / `E_PDF_MISSING` / `E_PDF_SIZE`（小于阈值视为失败）/ `OK`。前端导出接口用任务 id + 轮询进度（`queued/running/done/failed`），便于大 deck 显示进度与取消。
6. **安全/稳定性**：print URL 带一次性 token 且仅本服务可提供；并发导出互斥（单队列），避免同时起多个浏览器实例；每次导出前清理 7 天前临时 profile。
7. **可选升级（M0 后）**：CDP 模式 `--remote-debugging-port=0`（读取 user-data-dir 下 `DevToolsActivePort` 文件）+ WebSocket `Page.printToPDF`（`printBackground:true, preferCSSPageSize:true`），可复用单实例、避免 Edge 不退出、拿到每页进度。

---

## 2. PPTX 图片版导出评估（P1/P2，非 P0）

**推荐路线（浏览器内，无额外进程）**：marp-core 在页面内渲染 → 每页截图 `html-to-image`（优先，2x 缩放）→ `pptxgenjs` 生成 13.333×7.5 in（16:9）画布、每页 `addImage` 铺满 + 写入 speaker notes。

- 质量：2x（2560×1440）位图，投影场景足够；中文/代码高亮正常（浏览器渲染）；**KaTeX 公式变位图，不可编辑**；整页为图片 → PPT 里文字不可编辑、不可搜索（这是 marp-cli `--pptx` 同样的图片版思路）。
- 体积：100 页 2x PNG ≈ 30–60MB（视内容），比 PDF 大 1–2 个数量级。
- 速度：浏览器内单页截图约 150–500ms（含布局），100 页约 20–50s，可接受；需注意每页及时释放 dataURL，避免内存峰值。
- **不推荐**“服务端 headless 逐页截图”：实测 Chrome `--headless --screenshot --window-size=2560,1440` 单进程耗时 **2.0–2.9s/次**（浏览器冷启主导），100 页 = 3–5 分钟；必须用 CDP 单实例复用才现实，但复杂度不值（MVP 阶段）。
- **结论**：PPTX 作为 P1/P2；MVP 先做 PDF（P0）+ PNG 导出（P1，成本低）。PPTX 图片版在 MVP 后补，走浏览器内截图；若后期要求“可编辑文字 PPTX”，成本高，明确不做。（交叉信息：marp-cli 4.5.1 的 `--pptx` 同样是**逐页位图**——2560×1440 PNG 背景 + 备注页，印证图片版是 Marp 生态的既有取舍；marp-core 浏览器 bundle 实测约 3.85MB min / 1.2MB gzip，本地 HTTP 服务按需加载无压力。）

---

## 3. 运行时选型（便携单文件 exe，内嵌前端资源 + 本地 HTTP + 自动开浏览器）

### 3.1 Rust 最小 demo 实测（本仓库 `spike/packaging/rust-server/`）

- 技术：`axum 0.8` + `tokio 1`（rt-multi-thread/macros/net）+ `rust-embed 8`；`assets/index.html` 编译期内嵌（= 本次实测的真实 3 页 deck）；`bind 127.0.0.1:0` 动态端口；`cmd /C start "" url` 打开默认浏览器；release profile `opt-level="z" + lto + codegen-units=1 + strip + panic="abort"`。
- 实测结果：
  - **单文件 exe = 0.50 MB**（`target/release/marp-lite-server.exe`）。
  - **首次 release 构建 3 分 55 秒**（本机，含约 100+ crates 下载+编译；后续增量构建 <10s）。debug 构建更快（~30s 量级）。
  - 运行后 HTTP 200、内嵌 deck 正常返回（内容含 `SLIDE 1 / 3`），Chrome headless 成功打印该 Rust 服务页面 → **“单文件服务 + 系统浏览器 + 浏览器导出”全链路闭环**。
  - 冷启动：用 PowerShell 轮询「进程创建→HTTP 可访问」测得 0.97–2.37s（含 PowerShell 启动/进程创建/杀软首次扫描开销，样本 ±；二进制 0.5MB，真实双击到监听预计 <100ms 级，产品阶段建议用 ETW/进程时间精确测）。
- 生成产物 `target/` 与 `out/*.pdf` 均被 `.gitignore` 忽略（`dist/`、`spike/**/out/` 已配置）。

### 3.2 横向对比

| 方案 | 单文件体积 | 冷启动 | 目标机依赖 | 构建/编译时间 | 开发效率 | 内嵌静态资源 | 结论 |
|---|---|---|---|---|---|---|---|
| **Rust（axum+tokio+rust-embed）** | **0.50 MB 实测** | 快（进程小） | **零**（Win10/11 一般自带 vcruntime；如需绝对零依赖可 `+crt-static`，体积略增） | release 首次 3m55s；增量快 | 中（代码量小：HTTP+嵌入+开浏览器约 60 行） | 编译期内嵌，无需释放临时文件 | ✅ **推荐** |
| Go（net/http 或 chi + `embed`） | 估算 5–12MB（`-ldflags "-s -w"`；含前端资源与依赖） | 快 | 零 | 秒级 | 高 | `//go:embed` 简单 | ⭕ 备选（团队熟 Go 时首选；本机未装，走 winget 安装需额外环境成本） |
| Node 22 SEA | **≥ 79.4 MB**（node.exe 实测 79.4MB + 注入 blob） | 中 | 零（含 Node） | 分钟级（SEA 配置+postject） | 最高（全 JS 同栈） | 内嵌 blob | ❌ 体积不满足 |
| Bun `--compile` | 估算 50–100MB（内含 Bun runtime） | 快 | 零 | 秒~分钟级 | 高（TS 直达） | 内嵌 | ❌ 体积不满足（本机未装，未实测） |
| .NET 7 单文件 self-contained | 估算 12–15MB（压缩后 10–12MB） | 中（100–300ms） | 零 | 快（本机 NuGet 网络受限，未完成还原实测） | 中高（C#/Kestrel 或 HttpListener） | `EmbeddedResource`/发布嵌入 | ⭕ 备选（体积居中，不如 Rust） |
| Electron 44 | 安装包 90–110MB / 解压 250MB+ | 慢（1–3s） | 自带 Chromium | 快 | 高 | asar | ❌ 与轻量目标冲突 |
| Tauri 2 | exe 约 3–10MB（但需 WebView2） | 快 | WebView2（Win10 可能缺，需 bootstrapper） | 同 Rust 编译量级 | 中 | 前端构建产物 | ❌ 无官方 print/PDF API，导出仍要外挂浏览器；Win10 WebView2 缺失风险 |

### 3.3 决策矩阵（1–5 分，越高越好；权重按“方便好用 + 轻量”目标定）

| 维度（权重） | Rust+系统浏览器 **（推荐）** | Go+系统浏览器（备选） | .NET 7 单文件 | Node SEA | Bun compile | Tauri 2 | Electron |
|---|---|---|---|---|---|---|---|
| 开发速度（25%） | 4 | 5 | 4 | 5 | 5 | 3 | 5 |
| PDF/PPTX 导出可靠性（25%） | **5**（浏览器 headless，已实测） | 5（同通道） | 5（同通道，CLI 调浏览器同样适用） | 5（同通道） | 5 | 3（无官方打印 API，需外挂浏览器/COM） | 5（printToPDF 最可控） |
| 体积（15%） | **5**（0.5MB） | 4（5–12MB） | 3（12–15MB） | 1（80MB+） | 1–2 | 5（3–10MB，但需 WebView2） | 1（100MB+） |
| 启动速度（10%） | 5 | 5 | 4 | 4 | 5 | 5 | 3 |
| 离线/零依赖（15%） | 5（仅需系统浏览器；Edge 必有） | 5 | 5 | 5 | 5 | 3（WebView2） | 5 |
| 后续维护（10%） | 4（Rust 生态稳、代码量小） | 4 | 3（.NET 7 已非 LTS，需评估 .NET 8/10） | 3（SEA 仍偏实验） | 3 | 2（打印靠外挂/社区） | 3（Electron 每 8 周大版本） |
| **加权总分** | **4.75** | 4.75 | 4.0 | 3.5 | 3.6 | 3.5 | 3.3 |

> 注：Go 与 Rust 同分——差别只在“本机是否已装/团队熟悉度”。本机 Rust 已装且实测达标，环境成本更低 → **推荐 Rust**；若后续感觉 Rust 迭代慢、或团队更熟 Go，切 Go 的成本很低（前端与导出链路完全复用）。

---

## 4. 便携 exe 工程细节（Rust 实现清单）

| 问题 | 方案 |
|---|---|
| 内嵌前端资源 | `rust-embed`（编译期把 `dist/` 打包进 exe；不释放临时文件，天然绿色版）。开发期可 `cfg!(debug_assertions)` 从磁盘读、release 从内嵌读 |
| 自动开默认浏览器 | release 下 `#![windows_subsystem = "windows"]` 隐藏控制台；`std::process::Command::new("cmd").args(["/C","start","",url])`（或 `open` crate）。注意 URL 只含 ASCII（127.0.0.1），无转义问题 |
| 端口占用 | `bind("127.0.0.1:0")` 让系统分配空闲端口最稳（实测链路可行）；如要固定端口，先探测占用再回退随机端口 |
| 多实例 | Windows named mutex（`CreateMutexW`）或文件锁；第二个实例发现已有实例 → 通过本地 `/api/ping` 拿 URL → 新开标签页后退出。也可用 `single-instance` crate |
| 退出与清理 | 无控制台窗口 → 必须有退出入口：① 托盘图标（`tray-icon` crate）+ 菜单“退出”；② 页面内“退出应用”按钮调 `/api/shutdown`；③ `marp-lite.exe --quit` 二次启动时杀旧实例。**临时文件**：内嵌资源不产生临时文件；导出/导入用 `%TEMP%\{app-id}\`，启动时清理 >7 天旧文件；用户文档目录不留垃圾 |
| 原生文件对话框 | `rfd` crate（Windows `IFileDialog`，UTF-16↔UTF-8 无损，**中文路径 OK**）；由 Rust 服务端执行，前端 `fetch('/api/open')` 取路径。保存对话框同理；下载响应头用 `filename*=UTF-8''...` 处理中文文件名 |
| 本地服务安全 | 只 bind `127.0.0.1`；启动生成随机 token，前端首次请求带 token（URL `?token=` 或 header），防本机其他程序/局域网访问；导出接口校验目标 URL 属于本服务白名单 |
| 配置/数据存放 | 便携版：exe 同目录 `data/`（`--portable` 语义）或 `%APPDATA%\{AppId}\`；主题/最近文件/自定义 CSS 存 JSON；升级不丢 |
| Windows Defender / SmartScreen | 未签名 exe 首次运行会弹 SmartScreen；**不要用 UPX/加壳**（误报率显著升高）；写版本信息资源（VERSIONINFO：公司/产品/版本/图标，`winres` 或 `embed-resource`）；发布附 SHA256；中长期买 OV/EV 代码签名证书 |
| 体积/启动 smoke test | CI 里断言 exe < 3MB、`--version` 正常、启动 3s 内 `/healthz` 200、导出 3 页 PDF 页数/尺寸正确 |

---

## 5. 发布与分发清单（便携版单文件 exe）

1. **产物命名**：`MarpLite-v0.1.0-win-x64.exe`；发布 zip 附 `SHA256SUMS.txt`、`README.txt`（首次运行说明、退出方式、浏览器要求）。
2. **运行要求**：Windows 10 1809+ / Windows 11；系统带 Edge（Win10/11 标配）；Chrome 可选。首启检测：Chrome → Edge → 提示安装或降级 window.print。
3. **便携性验证**：全新用户目录/无 Node/无 WebView2 的干净机器上双击即用；不写注册表、不装服务、不产生 Program Files 文件。
4. **退出/残留**：托盘或页面退出；退出后无残留进程（检查 Chrome/Edge 子进程已 kill）；无临时目录残留。
5. **GitHub Release 脚本思路**：`cargo build --release`（Rust）→ `pnpm build`（前端）→ 复制 exe + 附带 LICENSE/README → `7z`/`zip` 打包 → `gh release create vX.Y.Z --notes-file CHANGELOG.md`；CI 上传 SHA256。
6. **SmartScreen/Defender**：发布页写清“未签名版本如何运行（更多信息→仍要运行）”；收集误报样本交微软；后续签名后改为签名版本。
7. **回归清单**：3 页/100 页 PDF 导出（页数/尺寸/中文/背景）、PPTX（后置）、中文路径打开/另存为、多实例、端口占用、无 Chrome 机器（仅 Edge）、无网络离线导出、卸载/删除后无残留。

---

## 6. 风险与待验证（诚实标注）

- **已实测**：Rust 单文件体积/构建时间/服务链路、Chrome & Edge headless PDF（3 页/100 页/对照/中文/尺寸/背景/文本坐标）、headless 截图单次开销、Tauri npm API 无 print（类型检查）。
- **文档结论（未实测）**：Go / Bun / Node SEA / .NET 单文件体积（按官方文档+已知 runtime 大小估算；Node SEA 基数用本机 node.exe 79.4MB 实测）；Electron 体积（按官方分发惯例）；PPTX 图片版质量/速度（按库能力与截图实测推演，未完整跑 pptxgenjs）。
- **风险**：① 浏览器 headless CLI 参数/行为随版本变化（Chrome 132+ 只剩新 headless；需固定最低版本 + 超时降级）；② Edge 不退出必须 kill，杀进程时机不当可能截断 PDF（用“文件大小稳定”判断）；③ 目标机可能被安全软件拦截无窗口子进程；④ 用户可能同时装 Chrome Beta/Canary，探测顺序要覆盖 App Paths；⑤ Rust 开发效率需在 MVP 中验证（若拖慢，可切 Go，架构不变）；⑥ 未签名 exe 的 SmartScreen 首次体验。
- **下一步建议**：MVP 第二阶段实现 CDP 版导出器（复用单实例、printBackground/preferCSSPageSize 显式参数、逐页进度），并补 PPTX 图片版与服务端 API 的端到端测试。

---

## 7. 复现文件与参考来源

### 本仓库实测产物

- `spike/packaging/rust-server/`：Rust 单文件服务 demo（`Cargo.toml`、`src/main.rs`、`assets/index.html`）；release exe `rust-server/target/release/marp-lite-server.exe`（0.50MB）
- `spike/packaging/slides/deck.html`（3 页测试 deck）、`deck-100.html`（100 页）、`deck-no-page-css.html`（无 @page 对照）
- `spike/packaging/browser-print/serve.mjs`（本地 HTTP 服务）、`run-matrix.ps1`（Edge/Chrome/对照/100 页矩阵）、`verify.mjs`（页数/尺寸/文本校验）、`verify-paint.mjs`（背景填充/文本包围盒校验）、`gen-deck-100.mjs`
- `spike/packaging/out/`：`chrome-deck-http.pdf`、`edge-deck-http.pdf`、`chrome-deck-100.pdf`、`chrome-no-page.pdf`、`chrome-header-footer.pdf`、`chrome-file.pdf`、`perf-deck-100.pdf`、`verify-*.json`、`verify-paint.json`
- Electron 对照组（未运行，仅作 API 依据）：`spike/packaging/src/main.js`、`spike/packaging/slides/deck.html`、`spike/packaging/scripts/verify-pdf.mjs`

### 参考链接

- Electron `webContents.printToPDF` 参数：<https://www.electronjs.org/docs/latest/api/web-contents> ；PrintToPDFOptions：<https://www.electronjs.org/docs/latest/api/structures/print-to-pdf-options>
- electron-builder NSIS / portable：<https://www.electron.build/nsis/> 、<https://www.electron.build/portable>
- Chrome headless（含 `--print-to-pdf` / `--screenshot` 用法）：<https://developer.chrome.com/docs/chromium/headless> ；Chromium 命令行开关：<https://peter.sh/experiments/chromium-command-line-switches/>
- Edge/WebView2 `PrintToPdfAsync`：<https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2_16>
- Tauri 2 文档：<https://v2.tauri.app/> ；打印缺失相关 issue：<https://github.com/tauri-apps/wry/issues/707> 、<https://github.com/tauri-apps/tauri/issues/4917> 、<https://github.com/tauri-apps/tauri/issues/3066> ；社区打印插件：<https://github.com/felipeejunges/tauri-plugin-printer>
- axum：<https://docs.rs/axum/latest/axum/> ；rust-embed：<https://docs.rs/rust-embed/latest/rust_embed/> ；rfd（原生文件对话框）：<https://docs.rs/rfd/latest/rfd/> ；tray-icon：<https://docs.rs/tray-icon/latest/tray_icon/>
- Go `embed`：<https://pkg.go.dev/embed> ；Node SEA：<https://nodejs.org/api/single-executable-applications.html> ；Bun compile：<https://bun.sh/docs/bundler/executables> ；.NET 单文件：<https://learn.microsoft.com/en-us/dotnet/core/deploying/single-file/overview>
- PPTX 图片版：pptxgenjs <https://github.com/gitbrent/PptxGenJS> ；html-to-image <https://github.com/bubkoo/html-to-image> ；html2canvas <https://github.com/niklasvh/html2canvas>
- 本机版本信息：Edge/Chrome `--version`；Rust `cargo 1.95.0`；Node `v22.13.0`；dotnet `7.0.102`

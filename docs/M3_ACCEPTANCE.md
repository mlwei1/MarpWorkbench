# M3 验收报告 —— Mermaid 图表 / 网络图片兼容 / 图片原位编辑

> 日期：2026-10-20 ｜ 状态：**通过（Lead 验收）** ｜ 对应契约：`docs/UI_CONTRACT_M3.md`
> 用户需求原话："1. 能用下面的形式直接在 ppt 里显示 mermaid 图……2. 老的 md 导入这个项目，图片直接用网络图片地址的方式无法显示……兼容一下老的 md。3. 光标在已插入图片的位置点击图片按钮，则为修改当前图片的属性。"

---

## 1. 需求对照（全部完成）

| 用户要求 | 实现 |
|---|---|
| ```mermaid 代码块直接显示成图 | ✅ 预览 / 大纲缩略图 / 主题画廊缩略图 / **PPTX / PDF / HTML 导出**全部渲染为 SVG；mermaid 12.2.0 本地打包（**5.01MB min / 1.43MB gzip**），**离线、懒加载**（无图 deck 0 请求）；非法语法保留原代码块并给中文提示 |
| 其他图表方案调研 | ✅ 结论选 mermaid：Markdown 围栏事实标准 + 纯前端离线；PlantUML 需 JVM、Graphviz 只是布局引擎、D2 浏览器靠 WASM 且围栏生态弱（对比与来源见 `docs/dev/mermaid.md` §1） |
| 老 md 的网络图片兼容 | ✅ 双保险：① 预览/导出经**同源服务端代理**即时显示（不改 md，支持 `![bg](https)`）；② 编辑器顶部 Banner「检测到 N 张网络图片 → 下载到本地」，一键下载进 `assets/` 并**重写 Markdown**（离线可用）；③ 导出时自动内联（已本地化直接内联，远程图经代理取回） |
| 光标在已有图片上点图片按钮 → 编辑属性 | ✅ 光标所在行 ±1 行命中 `![…]()` / `![bg …]()` → 打开「编辑图片」并预填全部属性（背景/左右+占比/透明度/宽高/适配/模糊/灰度）→ 保存后**原位替换该行，不新增图片**；未命中仍是新建模式 |

## 2. 交付物

| 类别 | 内容 |
|---|---|
| Mermaid | `web/src/mermaid/**`（`hasMermaid/loadMermaid/renderMermaidInHtml/applyMermaidCacheSync/clearMermaidCache`、sha1 缓存、错误降级）、`scripts/build-mermaid-bundle.mjs`（IIFE + 体积预算检查）、`web/public/mermaid.browser.js`（构建产物，不进 git）、`docs/dev/mermaid.md` |
| 网络图片（服务端） | `server/src/remote_image.rs`（下载/SSRF 防护/缓存/重定向）、`server/src/routes/proxy.rs`（`GET /api/proxy/image`、`POST /api/decks/:id/localize-images`），挂载 `routes/mod.rs`；`docs/dev/server.md` §9 |
| 网络图片（前端） | `web/src/insert/remoteImages.ts`、`RemoteImagesBanner.vue`、ExportPanel 导出内联扩展；PreviewPane 同源代理替换 |
| 图片原位编辑 | `compose.ts`（`ParsedImage/parseImageAtLine/replaceImageAt`）、`ImageInsertDialog` 编辑模式、EditView 光标命中逻辑 |
| 集成 | `renderer.renderAsync`（sync → mermaid → assets dataURL，token 防竞态）、EditView、PreviewPane（`<base>` 修正）、EditorToolbar「◈ 图表」 |
| 验证 | `scripts/visual-e2e-m3.mjs`（Lead，21 项）；队友专项：`spike/mermaid/**`（渲染/打印/懒加载 28+9+13 项）、`spike/export/scripts/verify-m3-e2e.mjs`（22 项）、`spike/packaging/remote-image-test.mjs`（22 项） |
| 文档 | `docs/dev/{mermaid,server,export,frontend}.md` 增补；`docs/UI_CONTRACT_M3.md` |

## 3. 验收结果（真实 exe 12.38MB + 系统 Chrome 155）

| 验收项 | 结果 |
|---|---|
| **M3 集成 E2E** `node scripts/visual-e2e-m3.mjs` | **21/21 ✅** |
| M1 回归 `visual-e2e.mjs --embedded` | 13/13 ✅ |
| M2 回归 `visual-e2e-m2.mjs` | 26/26 ✅ |
| API 冒烟 `smoke.mjs` | 12/12 ✅ |
| Mermaid marp-core 真实渲染专项 | 28/28 ✅（2 张 SVG + 错误块保留代码、无 JS 错误/404/外网、16:9 不溢出） |
| Mermaid 打印 PDF 专项 | 13/13 ✅（3 页 960×540pt、186.5KB、5.3s、中文标签可提取、主体矢量） |
| Mermaid 懒加载 | 9/9 ✅（无图 deck 0 请求；有图恰好 1 次；重复不加载） |
| 网络图片服务端专项 | 22/22 ✅（代理 200/content-type/缓存命中上游不增/401/非图片/超限/ftp/302/循环/私有网络拒绝；localize 落盘+mapping+不改 md） |
| 图片编辑/网络图前端专项 | unit 18/18 + browser 17/17 + 真实 exe E2E 22/22 ✅ |
| 体积 | **12.38MB**（mermaid 5.01MB + marp-core 3.67MB 等内嵌资源；目标 ≤20MB） |
| 离线 / 错误 | 0 外网请求、0 JS 错误、0 资源 404；代理图床访问为本机假远程服务（测试专用） |

**M3 端到端 21 项覆盖**：无图表 deck 不加载 mermaid bundle → 主 deck 2 张 mermaid 渲染 SVG + 非法块降级提示 + bundle 恰好懒加载 1 次 → 网络图片经 `/api/proxy/image` 显示（naturalWidth=800）→ Banner 检测 1 张 → 一键下载：md 重写为 `assets/remote-*.png`、原 URL 消失、预览正常 → 光标定位图片行 → 「编辑图片」→ 宽度改 50% 保存 → **原位替换（图片行数仍为 1，生成 `w:640px`）** → 背景图 `![bg left:40%]` 光标编辑 → 右侧 60% 保存 → `![bg right:60%]` 原位替换 → 导出 PDF（7 页，与 deck 一致）→ 零外网/零 404/零 JS 错误。

**截图**（`spike/visual-m3/2026-10-20T14-30-49/`，本地保留不进 git）：
`01-mermaid-preview.png` mermaid 两种图 ｜ `02-remote-banner.png` 网络图片 Banner ｜ `03-after-localize.png` 本地化后 ｜ `04-image-edit-dialog.png` 图片原位编辑 ｜ `05-image-edited.png` 编辑生效 ｜ `06-bg-edit-dialog.png` 背景图编辑（左 40% 预填） ｜ `07-bg-edited.png` 背景图右 60% ｜ `08-export-done.png` PDF 导出。

## 4. 实现要点 / 踩坑

1. **Mermaid 体积与懒加载**：mermaid 12.2.0 全量 IIFE 5.01MB min / 1.43MB gzip（预算内）；`hasMermaid(html)` 才加载，页面内动态 `<script>` 注入 → 无图 deck 首屏零成本；`htmlLabels:false`（Chrome 下 PDF 标签文本仍可提取，且无 foreignObject 更稳）。
2. **首次渲染慢**：mermaid bundle 首次加载+初始化约 1.4–2.5s；EditView 先显示同步渲染（代码块）再替换为 SVG，避免白屏；二次渲染命中缓存。
3. **网络图片代理**：iframe 内 `<img>` 无法带 `X-MWB-Token` 头 → 仅 `/api/proxy/image` 允许 `?token=`（恒定时间比较），其余 API 仍强制 header；SSRF 防护（仅 http/https、DNS 后逐 IP 校验私有网段、3 跳重定向逐跳校验、15MB/10s 上限）。
4. **Windows 自带 curl**：本环境 crates.io 被失效代理阻断，服务端 HTTP 客户端改用 Windows 自带的 `curl.exe`（Win10 1809+/Win11 内置），零新增依赖、零体积增长；隔离在 `remote_image.rs::run_curl()`，网络恢复后可换 ureq 不影响接口。
5. **iframe `<base>` 坑**：原 `<base href="about:blank">` 会让根路径 `/api/proxy/image` 无法解析，改为 `location.origin`。
6. **百分比宽度**：marp-core 4.4 不支持 `![w:50%]`，编辑器按页宽换算 px（`w:640px`），仍是标准 Marp 语法。
7. **图片原位替换**：精确字符 range + ±1 行容差 + 代码围栏内不识别；未知修饰符（brightness/vertical 等）透传保留。

## 5. 已知限制

- Mermaid 首次加载 1.4–2.5s（之后缓存）；主题画廊缩略图的 mermaid 依赖主预览已渲染缓存，冷启动首屏可能先显示代码块。
- 未本地化的网络图片在**断网**导出时缺图（有可读提示）；预览需要联网才能加载远程图（或先点「下载到本地」）。
- 图片编辑目前覆盖 `![…]()` 与 `![bg …]()` 指令行；front-matter `backgroundImage` 通过属性面板编辑（不在本对话框）。
- mermaid 节点默认阴影在 PDF 中会被 Chrome 光栅化为小位图（非整页位图化），主体是矢量；如需纯矢量可后续统一关闭阴影。

## 6. 下一步建议（M4）

1. 新手模板/结构块（封面/目录/章节/数据页）、幻灯片新建/复制/删除。
2. 大纲拖拽排序、导出后"打开所在文件夹"、PNG 批量。
3. 历史快照回滚、空闲自动退出、首启引导。
4. 打 v0.1 发布包：图标/版本信息、便携模式、README、Release zip + SHA256；顺便把 mermaid 首次加载体验再优化（预加载/骨架）。

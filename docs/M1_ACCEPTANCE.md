# M1 验收报告 —— MarpWorkbench 骨架

> 日期：2026-10-20 ｜ 状态：**通过**（Lead 验收）｜ 对应计划：`docs/PROJECT_PLAN.md` §8 M1
> M1 目标：交付「双击 exe → 浏览器工作台 → 左编辑右预览 → 选主题 → 导出 PPTX/PDF」的可运行骨架。

---

## 1. 交付物

| 类别 | 内容 |
|---|---|
| 可执行文件 | `server/target/release/MarpWorkbench.exe`（**7.5 MB**，单文件、零运行时依赖、内嵌前端资源与 6 套主题） |
| 服务端 | Rust：`server/src/**`（axum + tokio + rust-embed；静态资源/token 鉴权/单实例/自动开浏览器/工作区 API/主题 API/设置/导出编排） |
| 前端 | Vue 3 + Vite + TypeScript：`web/src/**`（首页/编辑器/预览/设置；CodeMirror 6、marp-core 浏览器渲染、自动保存、主题下拉+画廊、导出面板） |
| 主题 | `themes/*.css`：6 套原创主题 + `themes/index.json`（MarpWorkbench 内嵌） |
| 导出 | `server/src/export/**`（无头 Chrome/Edge PDF、CDP 2x 原生截图、HTML 单文件）+ `web/src/export/**`（导出面板、pptxgenjs 组装） |
| 文档 | `docs/dev/server.md`、`frontend.md`、`themes.md`、`export.md`；`docs/API_CONTRACT.md`（已按实现修正） |
| 验证脚本 | `scripts/smoke.mjs`（API 集成冒烟）、`scripts/visual-e2e.mjs`（真实 exe + Chrome 视觉/交互/导出 E2E）、`web/scripts/verify-ui.mjs`（前端组自检 15 项）、`spike/export/scripts/e2e.mjs`（导出专项） |

## 2. 验收结果总览

| 验收项 | 结果 | 证据 |
|---|---|---|
| 构建一条命令出包 | ✅ `pnpm run build`（marp bundle → vite → cargo release） | 见 §3 |
| API 集成冒烟 | ✅ **12/12** | `node scripts/smoke.mjs`：启动/health/新建/保存/读回/409/themes/settings/**PDF 3 页 960×540pt**/capture 3 张 PNG/shutdown |
| 真实 UI + 端到端导出 | ✅ **13/13** | `node scripts/visual-e2e.mjs --embedded`：首页中文名/预览 4 页/**画廊 9 套且缩略图各异**/切换主题写回 front-matter/**真实导出 PPTX 2.8MB**/ZIP 头正确/无 JS 错误 |
| 导出专项（export-eng） | ✅ 全绿 | `spike/export/out/e2e-report.json`：PDF 3 页 83.8KB **2.4s**、中文可提取、无页眉页脚；capture 走 CDP 原生通道 3×**2560×1440** 7.1s；PPTX 解包校验 3 页/`sldSz 12192000×6858000`（13.333×7.5in）/3 条 notes/背景图 2560×1440；HTML 22.8KB 无外网子资源；路径穿越/过期 token 安全用例通过 |
| 前端组 UI 自检 | ✅ 15/15 | `web/scripts/verify-ui.mjs`（真实 release exe + Chrome；含"主题实际生效：预览背景变化且无回退 toast"） |
| 体积 | ✅ 7.5MB（目标 ≤20MB） | `server/target/release/MarpWorkbench.exe` |
| 离线 | ✅ 0 外网请求 | Chrome 请求拦截实测；默认 MathJax、KaTeX 字体与 emoji 已本地化 |
| 中文 | ✅ | 中文 deck 名/内容/路径；PDF 中文可提取；PPTX notes 中文正常 |

**关键截图**（本地 `spike/visual/2026-10-20T06-33-46/`，不进 git）：
`01-home.png` 首页 ｜ `02-editor.png` 左编辑右预览 ｜ `03b-gallery-all.png` 9 套主题画廊 ｜ `04-theme-tech-dark.png` 深色主题生效 ｜ `05-export-panel.png` 导出面板 ｜ `06-export-done.png` 导出完成。

## 3. 构建与运行（复现）

```powershell
pnpm --dir web install
pnpm --dir web approve-builds esbuild     # 首次（pnpm 12 需显式批准）
pnpm run build                            # marp bundle + web dist + cargo release
server\target\release\MarpWorkbench.exe   # 双击等价：起服务 + 自动开默认浏览器
```

验证：

```powershell
node scripts/smoke.mjs                   # API 冒烟（自动隔离数据目录、不弹浏览器）
node scripts/visual-e2e.mjs --embedded   # 真实 exe + Chrome 视觉/交互/PPTX 导出 E2E
node web/scripts/verify-ui.mjs           # 前端组 15 项 UI 自检（需先起服务）
```

## 4. 与计划 P0 的差距（M2/M3 待办）

M1 是"骨架 + 导出全链路"，**不是完整 P0**。已交付 vs 未交付：

| P0 项 | 状态 | 说明 / 下一步 |
|---|---|---|
| P0-1 启动与生命周期 | 🟡 大部分 | 已有：单实例、动态端口、自动开浏览器、`--no-open`/`--version`、`/api/shutdown`；缺：空闲自动退出、首启 3 步引导、托盘 |
| P0-2 工作区/自动保存/恢复 | 🟡 大部分 | 已有：工作区文件、新建/导入/重命名/删除（回收站）、自动保存 800ms+30s、最近文件、刷新恢复；缺：历史快照面板/回滚、崩溃恢复细节 |
| P0-3 左编辑+右预览 | ✅ | CodeMirror 6、16:9 预览、当前页同步、缩放/适应、`---` 分页线；实测 4 页渲染、零 JS 错误 |
| P0-4 主题画廊 | 🟡 大部分 | 已有：9 套（6 自制+3 内置）、真实 deck 缩略图、分类/搜索/收藏/最近、↑↓ 键盘、点一下全 deck 应用（实测深色生效）、撤销；缺：hover 大图预览打磨、收藏/最近持久化验收 |
| P0-5 导出中心 | 🟡 大部分 | 已有：PPTX（图片版，16:9/notes/实测解包）、PDF（960×540pt/中文/无页眉页脚）、HTML；缺：30 页大 deck 实测、"打开所在文件夹"、导出后动作配置 |
| P0-6 图片粘贴/拖拽 | ❌ 未做 | M3 |
| P0-7 front-matter 可视化面板 | ❌ 未做 | M2（当前直接改源码 front-matter） |
| P0-8 大纲/缩略图导航 | ❌ 未做 | M3 |
| P0-9 自定义主题导入（UI） | 🟡 服务端 API 已通（POST/PUT/DELETE /api/themes）；UI 导入/另存未做 | M2 |

## 5. 已知问题 / 风险

1. **PPTX 图片体积**：CDP 2x PNG 单页可达 1.4MB（渐变主题），>10 页自动改 JPEG q90（约 0.42s/页）；导出面板已按页数自动切换。
2. **依赖本机 Chrome/Edge**：Windows 10/11 自带 Edge 可兜底；两者都缺失时 UI 给可执行提示（安装或改用浏览器打印）。
3. **Edge 无头打印后不退出**：已按"PDF 落盘大小稳定 300ms 再 kill"处理，仍需在 M4 跨版本回归。
4. **未签名 exe**：首次运行可能有 SmartScreen 提示；M4 打版本信息/图标 + 发布说明（暂不做代码签名）。
5. **健康检查也要 token**：与初版契约不同，已更新契约；前端始终带 token，不影响使用。
6. **主题 CSS 语义坑**（已修）：`ThemeMeta.css` = "服务端是否内联 CSS"，前端不能据此跳过加载；M2 若要支持内联可再议。
7. **spike/ 与截图不进 git**：repo 只保留源码/文档/主题/验证脚本；实测产物按 `docs/dev/*.md` 的复现命令可重建。

## 6. M2 建议排期（下一步）

1. 主题系统补完（06 套 → 12 套；hover 大图、收藏持久化、自定义主题导入/另存 UI、主题包导出）。
2. front-matter 可视化面板 + 大纲/缩略图导航。
3. 图片粘贴/拖拽入库；模板库。
4. 30 页/100 页 deck 导出实测与性能回归；"打开所在文件夹"。
5. 打 v0.1 发布包：图标/版本信息、首启引导、便携模式、README、Release zip + SHA256。

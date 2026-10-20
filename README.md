# MarpWorkbench（Marp 工作台）

> 一个绿色便携的 Windows 单文件 exe：双击后在浏览器里打开 Marp 工作台——左边写 Markdown、右边实时预览、点一下换主题、一键导出 **PPTX / PDF / HTML**。
>
> 当前状态：**M1 骨架完成（2026-10-20 验收通过）**，下一步 M2 主题系统完善。验收报告：[docs/M1_ACCEPTANCE.md](docs/M1_ACCEPTANCE.md)。

## 为什么做它

Marp 很好用，但在 VS Code 里：换主题要改 front-matter + 手写 CSS + 改 settings.json + 自己装字体；没有"选之前先看"的主题画廊；导出入口深、图片路径常丢。本项目把 Marp 的"格式决策层"做成 GUI，产出的仍是**标准 Marp Markdown**（随时能拷回 VS Code / marp-cli），并保持**单文件、免安装、离线可用、体积小**。

## 形态

```
双击 MarpWorkbench.exe（7.5MB 单文件）
  → 本地服务 127.0.0.1:<随机端口>（无黑窗）
  → 自动打开默认浏览器 → 浏览器里的 Marp 工作台
  → 左编辑 / 右预览 / 主题画廊 / 一键导出 PPTX·PDF·HTML
```

- **运行时**：Rust（axum + tokio + rust-embed）单文件 exe，零运行时依赖（实测 7.5MB）
- **渲染**：`@marp-team/marp-core@4.4.0` 在浏览器端渲染（与 Marp 官方同源）
- **导出**：PDF 由本机 Chrome/Edge 无头打印（精确 1280×720 / 960×540pt，矢量可复制）；PPTX 为**逐页高清位图版**（CDP 原生截图 2x + pptxgenjs，16:9、演讲者备注写入 notes，与 `marp-cli --pptx` 同思路）；HTML 单文件离线可播
- **数据**：普通磁盘文件（默认 `文档\MarpWorkbench\`），不写注册表、无账号、离线可用、0 外网请求
- **主题**：内置 6 套原创主题 + Marp 原生 3 套；画廊用**当前 deck 真实内容**渲染缩略图，点一下全 deck 换装

## 快速开始（开发）

环境：Windows 10/11、Node ≥ 20、pnpm、Rust 1.95+、本机装有 Chrome 或 Edge（导出用）。

```powershell
# 1) 安装前端依赖（首次）
pnpm --dir web install
pnpm --dir web approve-builds esbuild     # pnpm 12 需显式批准 esbuild 安装脚本

# 2) 构建：marp 浏览器渲染包 + 前端 + Rust exe
pnpm run build
# 产物：server\target\release\MarpWorkbench.exe

# 3) 运行（双击等价）
server\target\release\MarpWorkbench.exe

# 开发模式
pnpm run dev:web      # 前端热更（无后端时自动 mock）
pnpm run dev:server   # 起 Rust 服务
```

验证：

```powershell
node scripts/smoke.mjs                   # API 集成冒烟（12 项，自动隔离数据目录）
node scripts/visual-e2e.mjs --embedded   # 真实 exe + Chrome：UI/主题/PPTX 导出 E2E（13 项）
```

## 目录

```
server/   Rust 本地服务（静态资源、工作区/主题 API、导出编排、生命周期）
web/      Vue 3 + Vite + CodeMirror 6 + marp-core（浏览器渲染）
themes/   内置 Marp 主题 CSS（6 套原创，M2 补到 12 套）
scripts/  构建/验证脚本（build-marp-browser、smoke、visual-e2e）
docs/     项目计划、接口契约、M1 验收报告、调研文档、开发说明
spike/    技术验证工程（不进发布包，产物本地保留）
```

## 文档

| 文档 | 内容 |
|---|---|
| [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md) | 项目计划 v1.2：产品定义、范围、架构、里程碑、风险、验收 |
| [docs/M1_ACCEPTANCE.md](docs/M1_ACCEPTANCE.md) | M1 验收报告：交付物、实测数据、与 P0 的差距、下一步 |
| [docs/API_CONTRACT.md](docs/API_CONTRACT.md) | 前后端接口契约与工程约定 |
| [docs/dev/](docs/dev/) | server / frontend / themes / export 开发说明 |
| [docs/research/](docs/research/) | Marp 技术栈、运行时选型、UX 调研（含实测数据） |

## 许可

（待定，计划 MIT。内置主题全部原创。）

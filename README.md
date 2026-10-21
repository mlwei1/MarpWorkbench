# MarpWorkbench（Marp 工作台）

> 一个绿色便携的 Windows 单文件 exe：双击后在浏览器里打开 Marp 工作台——左边写 Markdown、右边实时预览、点一下换主题、一键导出 **PPTX / PDF / HTML**。
>
> 当前状态：**M3.1 完成（2026-10-21 验收通过）**——修复"打字时预览乱滚"，新增**全屏播放（方向键翻页）**；此前 M3：Mermaid 图表 / 老 md 网络图片兼容 / 图片原位编辑；M2：12 套主题 / 属性面板 / 大纲 / 插入器。验收报告：[docs/M3_1_ACCEPTANCE.md](docs/M3_1_ACCEPTANCE.md)、[docs/M3_ACCEPTANCE.md](docs/M3_ACCEPTANCE.md)、[docs/M2_ACCEPTANCE.md](docs/M2_ACCEPTANCE.md)、[docs/M1_ACCEPTANCE.md](docs/M1_ACCEPTANCE.md)。

## 为什么做它

Marp 很好用，但在 VS Code 里：换主题要改 front-matter + 手写 CSS + 改 settings.json + 自己装字体；没有"选之前先看"的主题画廊；导出入口深、图片路径常丢。本项目把 Marp 的"格式决策层"做成 GUI，产出的仍是**标准 Marp Markdown**（随时能拷回 VS Code / marp-cli），并保持**单文件、免安装、离线可用、体积小**。M2 起进一步做到：**不懂 Markdown 的人也能点着用完**——属性面板点选、图片/表格插入器、大纲导航、主题画廊与主题编辑器。

## 形态

```
双击 MarpWorkbench.exe（12.4MB 单文件）
  → 本地服务 127.0.0.1:<随机端口>（无黑窗）
  → 自动打开默认浏览器 → 浏览器里的 Marp 工作台
  → 格式工具栏 + 左大纲/缩略图 + 编辑区 + 实时预览 + 右属性面板
  → 主题画廊（12 套）/ 图片与表格插入器 / 一键导出 PPTX·PDF·HTML
```

- **运行时**：Rust（axum + tokio + rust-embed）单文件 exe，零运行时依赖（实测 12.4MB，含 mermaid 离线包）
- **渲染**：`@marp-team/marp-core@4.4.0` 在浏览器端渲染（与 Marp 官方同源）；**Mermaid 图表**（12.2.0 本地打包，懒加载，离线下预览/导出为 SVG）
- **导出**：PDF 由本机 Chrome/Edge 无头打印（精确 1280×720 / 960×540pt，矢量可复制）；PPTX 为**逐页高清位图版**（CDP 原生截图 2x + pptxgenjs，16:9、演讲者备注写入 notes，与 `marp-cli --pptx` 同思路）；HTML 单文件离线可播
- **数据**：普通磁盘文件（默认 `文档\MarpWorkbench\`），不写注册表、无账号、离线可用、0 外网请求。**老 Markdown 里的网络图片**会自动经本地代理显示，并可一键下载到本地 `assets/` 重写路径
- **主题**：内置 12 套原创主题 + Marp 原生 3 套；画廊用**当前 deck 真实内容**渲染缩略图，点一下全 deck 换装；支持导入 `.css`、可视化编辑主题、另存为副本
- **易用性（M2/M3）**：格式工具栏、属性面板（尺寸/页码/页眉页脚/class/背景图）、图片插入器（普通图 / 背景图整页·左·右占比 / 透明度 / 模糊灰度，实时预览；**光标在已有图片上点图片按钮 = 原位编辑该图片**）、表格插入器、大纲树与幻灯片缩略图导航、图片粘贴/拖拽自动入库、Mermaid 图表按钮
- **演示（M3.1）**：预览工具栏「▶ 全屏播放」——黑底 16:9 单页、方向键/空格/PageUp/Down/Home/End 翻页、Esc 退出；预览改为稳定宿主文档原位更新，**打字时不再闪跳**

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
pnpm run verify:smoke    # API 集成冒烟（12 项，自动隔离数据目录）
pnpm run verify:visual   # M1 回归：真实 exe + Chrome：编辑/主题/PPTX 导出（13 项）
pnpm run verify:m2       # M2 验收：属性面板/大纲/缩略图/图片表格插入器/主题导入与编辑器（26 项）
pnpm run verify:m3       # M3 验收：Mermaid/网络图片本地化/图片原位编辑/含图 PDF 导出（21 项）
pnpm run verify:m3fix    # M3.1 验收：打字时预览不跳动 + 全屏播放方向键翻页（14 项）
```

## 目录

```
server/   Rust 本地服务（静态资源、工作区/主题 API、导出编排、生命周期）
web/      Vue 3 + Vite + CodeMirror 6 + marp-core（浏览器渲染）
themes/   内置 Marp 主题 CSS（12 套原创）
scripts/  构建/验证脚本（build-marp-browser、build-mermaid-bundle、smoke、visual-e2e*、fixtures）
docs/     项目计划、接口契约、M1/M2/M3/M3.1 验收报告、调研文档、开发说明
spike/    技术验证工程（不进发布包，产物本地保留）
```

## 文档

| 文档 | 内容 |
|---|---|
| [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md) | 项目计划 v1.5：产品定义、范围、架构、里程碑、风险、验收 |
| [docs/M3_1_ACCEPTANCE.md](docs/M3_1_ACCEPTANCE.md) | M3.1 验收报告：预览滚动修复 + 全屏播放 |
| [docs/M3_ACCEPTANCE.md](docs/M3_ACCEPTANCE.md) | M3 验收报告：Mermaid / 网络图片 / 图片原位编辑 |
| [docs/M2_ACCEPTANCE.md](docs/M2_ACCEPTANCE.md) | M2 验收报告：需求对照、交付物、实测数据、已知边界、下一步 |
| [docs/UI_CONTRACT_M3_FIX.md](docs/UI_CONTRACT_M3_FIX.md) | M3.1 契约（预览滚动 / 全屏播放） |
| [docs/UI_CONTRACT_M3.md](docs/UI_CONTRACT_M3.md) | M3 功能契约（Mermaid / 网络图片 / 图片编辑） |
| [docs/M1_ACCEPTANCE.md](docs/M1_ACCEPTANCE.md) | M1 验收报告：骨架交付物与实测数据 |
| [docs/UI_CONTRACT_M2.md](docs/UI_CONTRACT_M2.md) | M2 组件契约（属性面板/大纲/插入器/主题编辑器） |
| [docs/API_CONTRACT.md](docs/API_CONTRACT.md) | 前后端接口契约与工程约定 |
| [docs/dev/](docs/dev/) | server / frontend / themes / export / outline 开发说明 |
| [docs/research/](docs/research/) | Marp 技术栈、运行时选型、UX 调研（含实测数据） |

## 许可

（待定，计划 MIT。内置主题全部原创。）

# M5.0 验收报告 —— Mermaid 尺寸选项 + 示例库 + 图表原位编辑

> 日期：2026-11-23 ｜ 状态：**通过（Lead 验收）** ｜ 契约：`docs/UI_CONTRACT_M5_MERMAID.md`
> 用户需求原话：
> 1. "添加一个 mermaid 添加图大小设置的选项，现在的图太小了，如果难度太大的话就渲染的大一点。"
> 2. "添加 mermaid 图时，各个类型的图加示例，方便用户编辑。"

---

## 1. 需求对照

| 用户要求 | 实现 |
|---|---|
| 图太小 | **双重修复**：① 默认取消 mermaid 自然宽度上限，小图铺满内容宽度（2 节点图 360px → **1120px**）；② Marp 主题常用 flex 居中导致子项 shrink-to-fit，仅加 `max-width:100%` 仍只有 300px —— 修复为 wrapper `width:100%`，实测图宽 **1120/1280 = 88%** |
| 图大小选项 | 每张图可用代码块第一行指令控制：`%% mwb-size: auto\|s\|m\|l\|xl\|70%\|900px`；插入对话框提供下拉：自动/小/中/大/超大/自定义 %；指令保留在 Markdown 中可反复修改 |
| 各类型图加示例 | 工具栏「◈ 图表」打开**示例库对话框**：10 类图表（流程图/时序图/类图/状态图/ER/甘特/饼图/思维导图/时间线/用户旅程），每类带可直接改的中文示例 + 实时代码 + 预览 |
| 方便编辑 | 光标在已有图表代码块内 → 同一按钮打开**编辑模式**，预填代码与尺寸，保存后**原位替换**（不新增块、不重复尺寸指令） |

## 2. 交付物

| 类别 | 内容 |
|---|---|
| 尺寸引擎 | `web/src/mermaid/size.ts`（解析/序列化/选项）、`replace.ts`（`cleanupMermaidSvg(svg, size)` + wrapper 宽度修复）、`index.ts`（双路径应用尺寸 + `renderMermaidPreview`） |
| 示例库/对话框 | `web/src/insert/MermaidInsertDialog.vue`（10 类示例、代码编辑、实时预览、尺寸、编辑模式）、`mermaidBlock.ts`（光标定位代码块）、编辑器 `replaceRange`、EditView/工具栏集成 |
| 文档 | `docs/UI_CONTRACT_M5_MERMAID.md`、`docs/dev/mermaid.md`（尺寸引擎/实测）、`docs/dev/frontend.md`（对话框） |
| AI 文档（同时交付） | `docs/AI_WRITING_GUIDE.md`、`docs/AI_PROMPT.md`、`docs/M5_PLAN.md`（M5.1 接口计划） |
| 验收 | `scripts/verify-mermaid-ui.mjs`（17 项）；mermaid 专项：unit 23/23、render 28/28、size 18/18、print 23/23 |

## 3. 验收结果（真实 exe 12.43MB + Chrome 157）

| 验收项 | 结果 |
|---|---|
| **M5 集成 E2E** `node scripts/verify-mermaid-ui.mjs` | **17/17 ✅** |
| 10 类示例逐个渲染 | 10/10 均出 SVG、无错误提示 |
| 尺寸选项 | 时序图 xl 插入：Markdown 含 `%% mwb-size: xl`；预览 SVG `max-height:640px`；**实际宽度 1120px / 页面 1280px（88%）** |
| 原位编辑 | 光标进图表 → 标题「编辑 Mermaid 图表」+ 预填 xl；改自定义 70% 保存 → 仍 1 个代码块、1 条指令、`max-width:70%` |
| 默认放大 | 新 deck 默认 auto 插入：无尺寸指令、`max-width:100%`、实际图宽 1120/1280 |
| 回归 | M1 13/13、M2 26/26、M3 21/21、M3.1 14/14、M4 23/23、API 冒烟 12/12 全绿 |
| mermaid 专项 | unit 23/23、render 28/28、size 18/18、print 23/23 |
| 无 JS 错误 / 离线 | 0 JS 错误；mermaid 仍本地懒加载（5.01MB min，无图 deck 不加载） |

**实测数据（1280×720，内容宽 1123px）**：
- 2 节点流程图：旧 360px → 新 **1120px（+211%）**；4 节点 665 → 1120；
- 预设 s=60%/m=80%/l=100%/xl=100%（max-height 480/540/560/640）、70%=786px、900px=900px；
- PDF：尺寸 deck 9 页 960×540pt、xl 页文本/矢量正常（无裁切）。

**截图**（本地保留，不进 git）：`spike/visual-m5/2026-11-23T13-23-09/01-dialog.png`（10 类示例+实时预览）、`02-inserted.png`（xl 图插入后铺满）、`03-edit-dialog.png`、`04-edited.png`（70% 原位编辑）、`05-auto-inserted.png`（默认放大）。

## 4. 实现要点 / 踩坑

1. **"图太小"的真正根因有两层**：mermaid SVG 自带自然宽度（max-width:360px）是表层；Marp 主题 `section` 常为 `display:flex; align-items:center` 纵向布局，mermaid wrapper 作为子项被 shrink-to-fit 到内容宽度，**只把 SVG 改成 width:100% 仍只有 300px**（Lead E2E 实测）。最终 wrapper 必须 `width:100%`，SVG `width:100%; max-width:100%` 才真正铺满。
2. **尺寸指令用 mermaid 注释** `%% mwb-size:`：mermaid 忽略 `%%` 行，不需破坏 Markdown；渲染/预览/导出都读取同一指令。
3. **编辑对话框原位替换**：`findMermaidBlockAtLine`（±1 行、跳过未闭合/其它语言 fence）+ 编辑器 `replaceRange`（单次 dispatch，保留撤销）；插入时先清除旧尺寸指令，避免重复。
4. **自定义尺寸**：UI 只提供百分比（契约），外面写的 `px` 指令仍兼容渲染。

## 5. 已知限制

- `xl` + 同页大标题在某些主题会超出页面（实测溢出 86.4px，marp 不做整页缩放）；建议超大图用无标题页或用「大」（l）。
- 首次预览需懒加载 mermaid bundle（3–5s，有 loading 提示）；之后走缓存。
- 默认铺满宽度会让"本来很小的图"文字等比放大（矢量不糊）；想小一点可选「小/中/自定义 %」。
- 对话框尺寸 UI 仅百分比；`px` 指令需手写（渲染支持）。

## 6. 复现

```powershell
pnpm run build             # 0.3.0
pnpm run verify:mermaid-ui # 17 项
# mermaid 专项：
node spike/mermaid/run-unit-test.mjs && node spike/mermaid/run-render-test.mjs && node spike/mermaid/run-size-test.mjs && node spike/mermaid/run-print-test.mjs
```

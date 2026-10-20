# M2 验收报告 —— 让不懂 Markdown 的人也能用

> 日期：2026-10-20 ｜ 状态：**通过（Lead 验收）** ｜ 对应计划：`docs/PROJECT_PLAN.md` M2/M3、`docs/UI_CONTRACT_M2.md`
> 用户需求原话："主题补到 12 套 + 主题导入/编辑器 + front-matter 面板 + 大纲 + 图片粘贴，然后插入表格功能优化，主题的 class 选择优化，页眉页脚之类的属性优化，可以用手点，然后图片插入优化（包括使用 bg 功能，透明的功能，左置右置占比功能），反正就是能让一般不懂 MARKDOWN 的用户也能轻松使用。"

---

## 1. 需求对照（全部完成）

| 用户要求 | 实现 | 入口 |
|---|---|---|
| 主题补到 12 套 | ✅ 12 套原创主题（新增 创业橙/数据青/暗夜霓虹/暖纸/中国风水墨/自然绿） | 主题画廊 / 属性面板 |
| 主题导入 | ✅ 选择或拖拽 `.css` → 服务端保存 → 出现在「我的主题」 | 主题画廊「＋ 导入主题」 |
| 主题编辑器 | ✅ 名称 + CSS 行号编辑 + 当前 deck 实时预览 + `@theme` 校验 + 另存为副本 | 画廊「＋ 新建主题」/ 卡片 ⋯ 菜单 / 属性面板「编辑主题」 |
| front-matter 面板 | ✅ 主题 / 尺寸(16:9、4:3) / 页码 / 页眉 / 页脚 / 全局 class / 本页 class / 本页背景图 / 透明度 / 适配 | 右侧「属性」面板 |
| 大纲 | ✅ 标题层级树（H1–H6）+ 页码 + 当前页高亮 + 点击跳转 | 左侧「大纲」tab |
| 图片粘贴 | ✅ 编辑器内 Ctrl+V / 拖拽图片 → 自动上传 `assets/` → 插入（换算 px 宽度） | 编辑器 |
| 插入表格优化 | ✅ 12×12 网格选行列、单元格直接编辑、表头/首列加粗/对齐、Markdown 预览 | 工具栏「▦ 表格」 |
| 主题 class 选择优化 | ✅ 全局 class（lead/invert/center/自定义，多选）+ 本页 class（单选/自定义/清除） | 属性面板 |
| 页眉页脚等属性可手点 | ✅ 文本框 + 「仅本页单独设置」+ 清空；尺寸分段按钮；页码开关 + 本页三态 | 属性面板 |
| 图片插入优化：bg / 透明 / 左右占比 | ✅ 图片插入器：普通图片（宽度 25/50/75/100%）｜背景图整页/左侧/右侧（20–70% 占比滑杆）｜cover/contain/fit｜透明度 0–100%｜blur/灰度；对话框内**实时预览插入后效果**并显示将写入的 Marp 语法 | 工具栏「🖼 图片」/ 属性面板「选择背景图」 |
| 非 Markdown 用户友好 | ✅ 格式工具栏（标题/加粗/斜体/列表/引用/代码/公式/分页/撤销重做）+ 四区布局（大纲/编辑/预览/属性）+ 全部产出标准 Marp Markdown | 编辑器页面 |

## 2. 交付物

| 类别 | 内容 |
|---|---|
| 新增组件 | `web/src/inspector/PropertyInspector.vue`（属性面板）、`web/src/outline/{SlideNavigator,useOutline}`（大纲/缩略图）、`web/src/insert/{EditorToolbar,ImageInsertDialog,TableInsertDialog,compose,pasteDrop,upload}`（插入器/工具栏）、`web/src/themes/ThemeEditor.vue`（主题编辑器） |
| 改造 | `EditView.vue`（四区布局/折叠记忆/工具栏/对话框挂载/粘贴拖拽/资产解析）、`PreviewPane.vue`（资产预解析 dataURL，修复 404 与漏图）、`ThemeGallery.vue`（导入/新建/卡片菜单/我的徽标）、`frontmatter.ts`（通用 front-matter 与页内指令读写）、`api/index.ts`（资产上传/主题 CRUD） |
| 主题 | `themes/*.css` 共 12 套 + `index.json`（全部原创、零外链、系统字体；深色打印背景正确） |
| 验证脚本 | `scripts/visual-e2e-m2.mjs`（26 项 M2 验收）、`scripts/fixtures/*`（测试图片/主题 CSS）；队友脚本：`web/scripts/test-frontmatter.ts`、`spike/themes/{render-themes,print-check,api-smoke,editor-e2e}.mjs`、`spike/outline/**`、`spike/export/scripts/verify-{compose,m2-ui}.mjs` |
| 文档 | `docs/UI_CONTRACT_M2.md`、`docs/dev/{frontend,themes,export,outline}.md` 增补 |

## 3. 验收结果（真实 exe + 系统 Chrome，2026-10-20）

| 验收项 | 结果 |
|---|---|
| API 冒烟（含 PDF/PPTX 截图/退出） | **12/12** ✅（`node scripts/smoke.mjs`） |
| M1 回归（编辑/预览/主题切换/真实导出 PPTX） | **13/13** ✅（`node scripts/visual-e2e.mjs --embedded`） |
| **M2 验收 26 项** | **26/26** ✅（`node scripts/visual-e2e-m2.mjs`） |
| 主题渲染 12/12 + 无头打印 8 套 5 页 960×540pt | ✅（`spike/themes/`） |
| 前端组件自检（工具栏/大纲/属性/尺寸 viewBox/页眉/class/图片上传/表格/粘贴/折叠记忆/零外网） | **33/33** ✅ |
| 大纲/缩略图隔离 harness | **38/38** ✅（100 页：大纲 67–258ms、存活 iframe ≤13） |
| 主题导入/保存/删除 API + 编辑器 E2E | 10/10 + 8/8 ✅ |
| 图片插入语法验证（marp-core 渲染断言） | **15/15** ✅（`bg left:40%`、`opacity`、`blur`、`grayscale`、GFM 表格、页首插入不破坏指令） |
| 无外网请求 / 无 JS 错误 / 无 404 资源 | ✅ |

**M2 端到端 26 项覆盖**：exe 启动 → 中文 deck → 工具栏/左栏/右栏存在 → 大纲 5 个标题+点击跳页 → 缩略图 4 页+点击跳页 → 属性面板（4:3 生效且预览 viewBox 960×720、页码关闭、页眉写入、全局 class、本页 class、未知字段 `author` 保留）→ 图片插入器（上传→背景图左 40%→插入 → 生成 `![bg left:40%](assets/test-photo-1.png)`）→ 表格插入器（3×3 GFM）→ 主题画廊 15 套 → 导入外部 CSS 成功 → 主题编辑器打开且带 CSS/预览 → 零错误。

**截图**（`spike/visual-m2/2026-10-20T12-11-51/`，本地保留不进 git）：
`01-editor-m2.png` 四区布局 ｜ `02-outline.png` 大纲 ｜ `03-thumbnails.png` 缩略图 ｜ `04-inspector-applied.png` 属性生效 ｜ `05-inspector-bottom.png` 背景图/高级 ｜ `06-image-dialog-bg.png` 图片插入器（背景图左侧 40% + 实时预览） ｜ `07-table-dialog.png` 表格插入器 ｜ `08-gallery-15.png` 15 套主题 ｜ `09-gallery-imported.png` 导入主题 ｜ `10-theme-editor.png` 主题编辑器。

## 4. 本次集成阶段修复的问题

1. **自定义图片不显示/404**：Marp 背景图是 `<figure style="background-image:url('assets/x.png')">`，iframe 相对路径解析到 `/edit/assets/...`。修复：渲染后统一把 `assets/*` 预解析为 data URL（`web/src/marp/assets.ts`），主预览/大纲缩略图/画廊缩略图/主题编辑器预览四处共用；同时解决缩略图里看不到上传图的问题。
2. **主题 CSS 未注册导致预览回退 default**（M1 遗留）：`ThemeMeta.css` 语义误读 + 多行 `@theme` 注释正则过窄，已修复并用 15 套主题回归。
3. **百分比宽度不生效**：marp-core 4.4 不支持 `![w:50%]`，插入器按 1280 页宽换算为 `![w:640px]`（仍是标准 Marp 语法）。
4. **深色主题表格白条 / 代码尾行裁切**：12 套主题统一加 `tr/pre/subst` 兼容重置。
5. **主题导入静默失败**：`input.files` live FileList 先清空再读导致；已修。

## 5. 已知边界（不阻塞当前验收）

- 属性面板文本框为**失焦/回车生效**（避免逐键双向抖动）；侧栏宽度固定，未做拖拽调宽。
- 主题编辑器实时预览只渲染当前 deck 前 2 页（性能取舍）。
- 大纲暂不支持拖拽排序（P1）；缩略图对超大 deck 用虚拟滚动，最多 13 个存活 iframe。
- PPTX 仍是**图片版**（版式 100% 保真、不可逐字编辑），导出 UI 已明示。
- 服务端主题导入 JSON 字段 `file_name` 与前端 `fileName` 命名差异（功能不受影响，M3 统一）。

## 6. 下一步（M3 建议）

1. **新手模板/结构块**：封面、目录、章节、数据页、结尾页一键插入（非 Markdown 用户最需要的"从 0 到 1"）。
2. 大纲拖拽排序、幻灯片复制/删除/新建按钮（直接操作第 N 页）。
3. 导出后"打开所在文件夹"、PNG 批量、30/100 页 deck 性能回归。
4. 历史快照回滚、空闲自动退出、首启 3 步引导。
5. 发布 v0.1 安装包：图标/版本信息、便携模式、README、Release zip + SHA256。

# 大纲 + 幻灯片缩略图导航（M2 / task-11 · outline-eng）

> 交付物：`web/src/outline/SlideNavigator.vue`、`web/src/outline/useOutline.ts`、本文件、`spike/outline/**`（自测/截图，不进发布包）
> 唯一契约：`docs/UI_CONTRACT_M2.md` §2.1（props/emits 固定）；挂载由 frontend-core 在 `web/src/views/EditView.vue` 完成
> 状态：**已完成**。构建通过；隔离 harness 38/38、真实应用集成 13/13、`useOutline` 单测 46/46。

---

## 1. 契约（与 `docs/UI_CONTRACT_M2.md` §2.1 完全一致）

```ts
// web/src/outline/SlideNavigator.vue
props: {
  markdown: string      // 当前 Markdown 全文
  html: string          // renderer 渲染结果（含全部 <svg data-marpit-svg>）
  css: string           // 对应主题 CSS（含 marp-core 注入样式）
  pageCount: number     // 页数（渲染结果为准）
  currentPage: number   // 当前页，1-based
  width: number         // 1280（用于缩放计算）
  height: number        // 720
}
emits: {
  jump: [page: number, line?: number]
}
```

- 组件根节点 `aside.slide-navigator` **宽 100%、高 100%**，内部 tab/列表各自滚动；父级左栏给固定高度即可（EditView：`260px` 宽、`flex:1` 高）。
- `jump` 语义：
  - 大纲点击 → `jump(page, line)`，`line` 是标题所在源文件行号（1-based，含 front-matter 行），父组件直接 `setCursor(line)` 即可精确定位；
  - 缩略图点击 → `jump(page)`（不带 line），父组件用 `pageStartLine(md, page)` 等分页工具定位页首。
- tab 选择记忆在 `localStorage['mwb.slideNav.tab']`（刷新保持上次视图）。

---

## 2. 实现

### 2.1 大纲（`useOutline.ts` 解析 → 组件渲染）

解析规则（纯函数，独立于 `web/src/marp/frontmatter.ts`，未修改该文件）：

| 规则 | 说明 |
|---|---|
| front-matter | 仅文件开头 `---` 块识别；行号按真实文件行计算（含 front-matter 占用行） |
| 标题语法 | CommonMark ATX：`#` ~ `######`、最多 3 个前导空格、允许行尾闭合 `###`；`#######`/`    #` 不算；不支持 Setext（Marp 中 `---` 是分页线，二义） |
| 跳过 | 代码围栏（``` / ~~~，按开始字符+长度配对，未闭合则其后全部跳过）、HTML 注释块（Marp 备注里常出现 `#` 行）、4 空格缩进代码块 |
| 页码映射 | 复用/复制 `scanSlides` 语义：跳过 front-matter 与围栏内的 `---`；标题行 → 所在页；最后再按父组件传入的 `pageCount` 夹取，保证不越界（renderer 页数与本地扫描有差异时以渲染结果为准） |
| 展示文本 | 去掉行内 Markdown 标记（行内代码/链接/图片/粗斜体/删除线/HTML 标签/转义），空标题显示 `(无标题文本)` |
| 缩进 | 以文档内最小标题级别归一化：`indent = level - minLevel`（0–5），`paddingLeft = 10 + indent*14px`，同时用 `H1`–`H6` 小徽标 + 字号层次 |
| 当前页高亮 | 当前页的所有标题加 `.current`（主题色浅底）；`.active` 为「活动项」：默认 = 当前页最后一个标题；用户点击后 = 被点击的那一条（编辑 markdown 或切页后自动回退） |
| 空态 | 无内容 →「还没有内容」；有内容但无标题 →「没有找到标题」（附语法提示） |

大纲列表面板滚动的活动项用 `scrollIntoView({block:'nearest'})` 保持可见。

### 2.2 幻灯片缩略图（每页轻量 iframe + 虚拟滚动）

```
props.html ──DOMParser 拆页──► rawSlides[]（每页一个 <svg data-marpit-svg> 的 outerHTML）
                                   │
props.css ──► buildSlideDoc(slideHtml, css, width, height) ──► slideDocs[]（srcdoc 字符串）
                                   │
                可见页（虚拟窗口，~8–13 个）──► <iframe sandbox="" :srcdoc> + transform: scale()
```

- **样式隔离**：每张缩略图是独立 `iframe srcdoc`，`sandbox=""`（无 `allow-scripts`/`allow-same-origin`，主题 CSS/脚本无法触达主界面；主界面无任何 Marp DOM/CSS 泄漏，已断言）。
- **主题真实渲染**：srcdoc = 主题 CSS + 单页 SVG，画布固定 `width×height`（1280×720），组件用 `transform: scale(width/1280)` 缩放到面板宽度。点击/高亮由父级 `<button>` 承担（iframe `pointer-events:none`），**不需要 iframe 内脚本/postMessage**，比契约推荐的「隐藏 iframe + postMessage」少一层异步与注入面。
- **⚠️ 关键坑（已修）**：marp-core 的 CSS 选择器全部以 `div.marpit > svg > foreignObject > section` 作用域生成，拆页时若只取 `<svg>` 而丢掉外层 `<div class="marpit">`，主题样式完全不生效（缩略图变白底 16px 系统字体）。`buildSlideDoc` 会把单页 SVG 重新包进 `.marpit`，harness 有回归断言。
- **虚拟滚动**：外层 `.sn-slide-list` 只放一个按 `页数 × 行高` 计算高度的 spacer，按 `scrollTop/clientHeight` 计算可见窗口（上下各多渲染 3 行）；滚动用 `requestAnimationFrame` 节流。缩略图行高由面板宽度实时计算（`rowHeight = thumbHeight + 标签 18px + 间距 8px`）。
- **懒加载/销毁**：视口外的行直接不渲染 DOM（iframe 随之销毁）；切到「大纲」tab、父组件折叠左栏（`v-show` 使宿主尺寸为 0，组件用 `ResizeObserver` 检测并暂停渲染）、组件卸载（`v-if`）都会销毁全部 iframe。展开/切回时自动恢复并滚到当前页。
- **自动定位**：切成幻灯片 tab 时自动滚到当前页；父组件更新 `currentPage` 时若当前页在视口外则平滑滚动居中；在视口内则不动（不打断用户滚动）。
- **大 deck 防抖**：`html` 长度 < 600KB（绝大多数 deck）同步拆页；≥600KB 防抖 260ms 拆页，避免每次按键都解析大 DOM。
- 缩略图底部有页码标签；当前页用主题色描边 + 页码徽标高亮；空态「还没有幻灯片」。
- 额外 `defineExpose`（非契约，供自动化/父组件调试）：`getTab()/setTab()/scrollPageIntoView()/debugState()`。

### 2.3 文件清单

| 文件 | 说明 |
|---|---|
| `web/src/outline/SlideNavigator.vue` | 双 tab 组件（模板/逻辑/`<style scoped>`），单文件约 10.9KB（gzip 4.8KB），已由 `import.meta.glob` 懒加载（独立 chunk，不拖首屏） |
| `web/src/outline/useOutline.ts` | 标题解析 + 页码映射纯函数 + `useOutline()` 组合式函数；单测覆盖 46 项 |
| `docs/dev/outline.md` | 本文件 |
| `spike/outline/render-fixture.mjs` | 用真实 `marp-core@4.4.0`（与前端同版本）+ `themes/business-blue.css` 生成验收 fixture（8 页样例 + 100 页性能 deck） |
| `spike/outline/test-outline.mjs` | `useOutline` 纯函数单测（esbuild 打包 TS 后在 node 跑） |
| `spike/outline/run-harness.mjs` + `harness/**` | 真浏览器隔离验收：Vite dev + 真实 Vue 3 + Chrome；覆盖大纲/缩略图/虚拟滚动/空态/折叠/隔离/离线 |
| `spike/outline/verify-app.mjs` | **真实应用集成验收**：`web/dist` + mock API + Chrome，在真实 EditView 左栏里验证挂载与跳转 |
| `spike/outline/debug-thumb.mjs` | 调试辅助：把单页 srcdoc 还原为 1280×720 截图核对主题保真 |

---

## 3. 方案取舍（为什么不是「一个隐藏 iframe」）

| 方案 | 主题真实 | 样式隔离 | 100 页性能 | 复杂度 | 结论 |
|---|---|---|---|---|---|
| **每页轻量 iframe + 虚拟滚动（采用）** | ✅ 逐页独立文档，主题 CSS 完整生效 | ✅ iframe sandbox | ✅ 同时存活 iframe 恒 ≤ 13 | 中 | **采用** |
| 单个隐藏 iframe 注入整 deck + postMessage | ✅ | ✅ | ⚠️ 一个文档里 100 页 SVG 同时布局（等同于「全 deck 预览」），滚动与内存不可控；且单 iframe 无法同时展示多张缩略图 | 高（需 iframe 内脚本、postMessage、跨文档滚动） | 否 |
| 父页面直出 DOM + `transform:scale`（M1 主题画廊方案） | ✅ | ❌ 主题 CSS 注入父页面，会污染主 UI（`section`/`h1` 等全局选择器） | ✅ | 低 | 否（主界面是编辑+预览，绝不能污染） |
| 每页位图截图（html-to-image） | ❌ 渐变/代码高亮丢失（M1 已实测否决） | ✅ | ❌ 100 页截图秒级 | 中 | 否 |

**代价与量化**：每个 iframe 重复注入一次主题 CSS（business-blue 约 54KB），但同时只有视口附近的 ~8–13 个 iframe 存活，总解析量 < 1MB 且都在懒渲染时发生；换来主题保真 + 零全局污染。100 页实测见 §5。

---

## 4. 挂载说明

### 4.1 当前挂载（frontend-core 已集成，`web/src/views/EditView.vue`）

```vue
<!-- 左栏（240–320px，可折叠，localStorage 记忆） -->
<SlideNavigatorAsync
  v-if="SlideNavigatorAsync && preview"
  :markdown="content"
  :html="preview.html"
  :css="preview.css"
  :page-count="pageCount"
  :current-page="page"
  :width="preview.width"
  :height="preview.height"
  @jump="onJump"
/>
```

```ts
// 组件经 web/src/integrations/optionalComponents.ts 的 import.meta.glob 懒加载
function onJump(nextPage: number, line?: number): void {
  const p = Math.min(Math.max(1, nextPage), Math.max(1, pageCount.value))
  const targetLine = line ?? pageStartLine(content.value, p)   // frontmatter.ts（marp-tech）
  page.value = p
  editorRef.value?.setCursor(targetLine)
  editorRef.value?.scrollToLine(targetLine)
}
```

要点：
- 父组件必须传**渲染结果** `preview.html/css`（不是 markdown 直出），否则缩略图无法主题保真；渲染失败/尚未渲染时可传空字符串（组件显示空态）。
- 左栏容器需要显式高度（EditView 用 `flex:1; min-height:0`），组件按 100% 填充并内部滚动。
- 折叠左栏时无论父级用 `v-show` 还是 `v-if`，组件都会销毁 iframe；重新展开自动恢复到当前页。
- 组件不依赖全局样式类，只用 `main.css` 的 CSS 变量（`--mwb-*`）与默认色兜底；不需要在 `main.css` 里加任何布局样式。

### 4.2 父组件状态契约

- `currentPage` 建议由编辑器光标行推导（EditView 现有 `slideIndexAtLine`），点击大纲后光标会通过 `setCursor` 改变，从而自然同步；
- `pageCount` 用 renderer 结果（`comments.length`）；组件内部再按它夹取页码；
- 主题切换/属性面板修改 markdown 后，父组件重渲染 → `html/css` 变化 → 缩略图自动重建（`srcdoc` 字符串变化时才重载 iframe）。

---

## 5. 性能与验证数据（2026-10-20 实测）

环境：Windows，本机 Chrome（headless），真实 `marp-core@4.4.0` + `themes/business-blue.css`；fixture 见 `spike/outline/render-fixture.mjs`。

| 指标 | 实测 | 说明 |
|---|---|---|
| 100 页 deck 大纲就绪（挂载→101 条） | **67–258ms**（多次运行） | 渲染 101 个按钮，无虚拟化必要（列表本身很轻） |
| 100 页缩略图 iframe 数（顶部/中段/底部） | **10 / 13 / 9** | 虚拟窗口 + 上下 3 行 overscan，恒定有界 |
| 100 页缩略图列表 scrollHeight | 17,120px | 100 行 × 171px（260px 宽面板） |
| 快速滚动到中段后渲染页码 | 48–60（正确跟随） | 旧 iframe 销毁、新 iframe 懒建 |
| 单张缩略图 srcdoc 大小 | ≈56.7KB（其中主题 CSS ≈54.4KB） | 仅视口附近 ~10 张存活 |
| 切幻灯片 tab 自动定位当前页 | scrollTop 465（第 7 页可见） | 修掉了「首次切换 tab spacer 高度未刷新导致定位被 clamp」的 bug |
| 折叠左栏 `v-show` 后 iframe | **8 → 0** | ResizeObserver 检测宿主尺寸为 0 自动暂停渲染 |
| 展开左栏 | iframe 恢复，当前页仍高亮 | 自动 refresh + 定位 |
| 样式隔离 | 主界面 `.marpit`/`svg[data-marpit-svg]`/`section` 数量均为 0，body 背景/字体不变 | 全部 Marp DOM 只在 iframe 内 |
| 外网请求 / JS 错误 | 0 / 0 | 离线验收 |
| 构建产物 | `SlideNavigator-*.js` 10.9KB（gzip 4.8KB）+ CSS 6.2KB（gzip 1.4KB），懒加载独立 chunk | 不拖慢首屏 |

### 5.1 复现命令

```powershell
# 0) 一次性生成真实渲染 fixture（依赖 spike/marp/node_modules 的 marp-core 4.4.0，无需额外安装）
node spike/outline/render-fixture.mjs

# 1) useOutline 纯函数单测
node spike/outline/test-outline.mjs
#    → === useOutline 单测：46/46 通过 ===

# 2) 组件隔离验收（Vite dev + 真实 Vue3 + 本机 Chrome；约 30s）
node spike/outline/run-harness.mjs
#    → === SlideNavigator 浏览器验收：38/38 通过 ===
#    报告 spike/outline/out/report.json，截图 spike/outline/shots/01–06

# 3) 真实应用集成验收（先构建，再用 dist + mock API 起 vite preview）
pnpm --dir web build
node spike/outline/verify-app.mjs
#    → === 真实应用集成验收：13/13 通过 ===
#    截图 spike/outline/shots/07-app-outline.png / 07-app-slides.png

# 4) 类型检查
pnpm --dir web typecheck
```

### 5.2 验收项对照（契约 §5.3：大纲 + 缩略图）

| 验收项 | 结果 | 证据 |
|---|---|---|
| 大纲 ≥3 个标题按层级显示 | ✅ 15 条标题（H1/H2/H3 三级缩进），码块/注释中的假标题被跳过 | `run-harness` 第 1 组；`01-outline-sample.png` |
| 点击大纲跳转正确页/行 | ✅ `jump page=3 line=30`，编辑器光标落在对应标题行 | harness + `verify-app`（真实 EditView） |
| 缩略图数量 = 页数 | ✅ 8 页 deck 显示全部 8 张；100 页 deck 列表高度按 100 页计算、可见窗口渲染 | harness 第 2/3 组 |
| 缩略图主题真实渲染 | ✅ 每张 iframe srcdoc 含主题 CSS + `.marpit` 包装；截图可见 header/footer/页码/代码块配色 | `02-slides-sample.png`、`07-app-slides.png` |
| 缩略图点击跳转 + 当前页高亮 | ✅ 点击第 2 张 → 状态栏「第 2 / 3 页」；当前页描边高亮 | harness + `verify-app` |
| 100 页不卡、折叠销毁 iframe、空态 | ✅ iframe 恒 ≤13；折叠 8→0；两种空态提示 | harness 第 3/4/5 组 |
| 样式隔离 | ✅ 主界面无 Marp DOM/CSS 泄漏 | harness 第 6 组 |

截图（本地，git 忽略）：`spike/outline/shots/01-outline-sample.png` 大纲 ｜ `02-slides-sample.png` 缩略图 ｜ `03-slides-100-top.png` 100 页顶部 ｜ `04-slides-100-bottom.png` 100 页底部 ｜ `05-empty.png` 空态 ｜ `06-narrow-240.png` 240px 窄栏自适应 ｜ `07-app-outline.png`/`07-app-slides.png` 真实应用。

---

## 6. 已知限制 / 后续可做

1. **图片资产缩略图**：缩略图 iframe 与主预览 `PreviewPane` 行为一致，`assets/x.png` 这类相对路径按父文档 URL 解析；M2 验收不要求图片缩略图，若 M3 需要可在 srcdoc 中注入 `<base>` 或把图片 URL 预解析为 blob。未做。
2. **marp browser() helper**：缩略图是静态渲染（与 M1 主题画廊一致，主题保真已实测），不执行 `MarpCore.browser()` 运行时增强（auto-scaling 自定义元素等）；主题 CSS 层面的效果（含 `@size`/页脚/页码）全部生效。
3. **Setext 标题** 不识别（`标题\n===`）；Marp 场景下与 `---` 分页线二义，按契约只支持 `#`–`######`。
4. 同一页多个标题时，`currentPage` 只能推导「当前页最后一个标题」为活动项；点击后保留被点项高亮，编辑 markdown 后回退。
5. 超大 deck（html ≥600KB，约数百页）缩略图拆页防抖 260ms，首次切 tab 可能有短暂占位。
6. 大纲树暂不支持拖拽排序（P1，计划在 M3/M5）；暂未做大纲关键字搜索。
7. 空 deck 判定：`markdown` 为空 / `html` 为空 / `pageCount<=0` 三者任一 → 空态（避免显示 renderer 对空文档补的空白页）。

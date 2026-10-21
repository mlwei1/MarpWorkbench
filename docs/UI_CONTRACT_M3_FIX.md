# M3.1 体验修复契约：预览滚动稳定 + 全屏播放

> 状态：v1 ｜ 来源：用户反馈（2026-10-21）
> 1. **Bug**：在编辑区末尾写 Markdown，预览窗口每改一个字符就从最上方溜到最下方，非常影响体验。
> 2. **Feature**：预览窗口增加全屏播放，上下左右方向键切换页。

---

## 1. 预览滚动 Bug（PreviewPane）

### 1.1 根因（已定位，无需再查）

`web/src/preview/PreviewPane.vue`：
- `srcdoc` 是 computed，依赖 `resolvedHtml`；
- 每次内容变化 → 新 srcdoc → **iframe 整页重载** → 新文档 scrollTop=0；
- `onLoad` 里调用 `scrollToPage(props.page)` 且使用 `behavior:'smooth'`，同时 iframe CSS `html{scroll-behavior:smooth}`；
- 用户光标在最后一页时 `props.page` 是末页 → 每键入一个字符都会「重载到顶部 → 平滑滚到底部」；
- mermaid 异步渲染 / 资产解析会二次替换 html，再触发一轮。

### 1.2 修复方案（推荐 A；B 为兜底）

**A. 稳定宿主文档 + 原位更新（首选）**
1. iframe 的 `srcdoc` **只生成一次**（固定骨架：CSP/base/空 body + 可替换的 `<style id="mwb-theme-style">` 与内容容器 `<div id="mwb-root">`）。
2. 内容变化时父窗口直接操作同源 iframe（不导航、不 reload）：
   - 更新 `style#mwb-theme-style.textContent` 为最新 css；
   - 更新内容容器 `innerHTML`（marp html）；
   - 调用 `MarpCoreBundle.MarpCore.browser(doc.body)`（`loadMarpCore()` 已有）；
   - **恢复滚动位置**：记录当前可见 slide 索引 + 页内偏移（或 scrollTop 比例），更新后用 `scrollTop = ...` 立即恢复（禁止 smooth）。
3. 只有以下情况才主动滚动到目标页：**首次加载**、以及「用户跳页动作」导致 `props.page` 真的变化（大纲点击/缩略图点击/编辑器光标跳到别的页）。内容更新（同一页内打字）绝不滚动。
4. 异步二次更新（mermaid 渲染完成、资产解析完成）同样原位更新 + 保持滚动；用自增 token 丢弃过期结果。
5. `scrollToPage` 统一用 `behavior:'auto'`（或直接设置 scrollTop）；移除对自动滚动有影响的 `html{scroll-behavior:smooth}`。
6. 兜底：如果原位更新抛错 → 退回 srcdoc 重载，但必须在 reload 前隐藏 iframe、load 后先恢复滚动再显示，不得出现从顶部滑到底部的可见过程。

**B. 兜底（仅在 A 不可行时）**：保留 srcdoc 重载，但：
- iframe `visibility:hidden` 直到滚动恢复完成；
- 记录并恢复 scrollTop（按 slide 索引精确恢复）；
- 内容更新不调用 smooth；仅页变化才滚。

### 1.3 验收标准（Lead 自动化）

- 12 页 deck，光标放末尾，在编辑区连续键入 20+ 字符：
  - 采样预览 iframe `scrollY`：始终 > 最大可滚动高度 70%，**不出现接近 0 的瞬间**（允许 ≤ 3 次轻微抖动且幅度 < 20%）；最终停在末页附近。
  - 内容确实更新（字符数/预览 DOM 变化）。
- 点击大纲第 1 页 → 预览滚到第 1 页；点击第 5 页 → 滚到第 5 页（`behavior:auto` 即可）。
- 已有功能（图片 dataURL、远程图代理、mermaid、主题切换）不回归。

---

## 2. 全屏播放（FullscreenPlayer）

### 2.1 组件

新建 `web/src/preview/FullscreenPlayer.vue`：

```ts
props: {
  html: string        // 已解析好的预览 html（含 mermaid/资产 dataURL/远程代理）
  css: string
  page: number        // 起始页 1-based
  pageCount: number
  width: number       // 1280
  height: number      // 720
  title?: string
}
emits: { close: [] }
```

- 打开：`PreviewPane` 工具栏新增「▶ 全屏播放」按钮（`title`/`aria-label` 包含“全屏播放”），点击时从当前页开始播放。
- 全屏：优先 `container.requestFullscreen()`；被拒绝/不支持时退化为 `position:fixed; inset:0` 的覆盖层（功能等价）。
- 渲染：黑底、16:9 slide 居中铺满；页面用 marp 输出（`svg[data-marpit-svg]`），只显示当前页，其余隐藏；图片/主题/mermaid 与预览一致。
- 键盘：
  | 按键 | 动作 |
  |---|---|
  | →、↓、Space、PageDown、Enter | 下一页 |
  | ←、↑、PageUp、Backspace | 上一页 |
  | Home / End | 首页 / 末页 |
  | Esc | 退出全屏播放 |
  - `preventDefault` 防止浏览器滚动；退出后恢复 body 滚动、清理监听、退出 fullscreen。
- HUD：`当前页 / 总页数`、标题、右上角「退出」按钮；底部淡提示「← → 翻页 · Esc 退出」；鼠标移动时显示、静止 2s 淡出（可选）。
- 页面变化时用 `data-page` 属性（如 `[data-page="3"]`）便于测试与状态读取。

### 2.2 验收标准（Lead 自动化）

- 点击「全屏播放」→ 播放层出现（`.mwb-player` 可见），起始页 = 当前编辑页。
- 按 → / ↓ 各一次、再按 → → 页数按预期递增；按 ← 递减；Home/End 到首/尾页；HUD 文本同步。
- 按 Esc → 播放层消失、body 可滚动、编辑器内容不变。
- 全屏 API 在 headless 下可能被拒绝 → 覆盖层模式也必须通过以上断言（不要因为 fullscreen 失败而报错）。

---

## 3. 写范围（owner: frontend-core/marp-tech）

- `web/src/preview/**`（PreviewPane 重构、FullscreenPlayer 新增）
- `web/src/views/EditView.vue`（如需要传 pageCount/标题）
- `web/src/styles/main.css`、`docs/dev/frontend.md`
- 允许 `web/src/integrations/optionalComponents.ts`（如果新组件需 Async 包装）

不执行 git commit；不改 themes/insert/mermaid/server。完成后 build 通过并 send_message 给 Lead。

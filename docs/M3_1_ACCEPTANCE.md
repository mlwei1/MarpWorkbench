# M3.1 验收报告 —— 预览滚动修复 + 全屏播放

> 日期：2026-10-21 ｜ 状态：**通过（Lead 验收）** ｜ 契约：`docs/UI_CONTRACT_M3_FIX.md`
> 用户反馈：① 在编辑区末尾写 md，预览每改一个字符就从最上方溜到最下方；② 预览窗口要加全屏播放，上下左右键切换页。

---

## 1. 修复 / 新增内容

### A. 预览滚动跳动（Bug）

**根因**：`PreviewPane.vue` 的 `srcdoc` computed 依赖内容 → 每次内容变化 iframe 整页重载（scrollTop→0）→ `onLoad` 再用 `behavior:'smooth'` 滚到当前页，外加 `html{scroll-behavior:smooth}`，于是「重载到顶部 → 平滑滑到底部」在每次键入时重复；mermaid/资产二次更新还会再来一次。

**修复**：PreviewPane 重构为「稳定宿主文档 + 原位更新」：
- iframe 的 srcdoc 固定骨架，**只 load 一次**；内容变化时直接操作同源 iframe（更新 `style#mwb-theme-style` + `#mwb-root.innerHTML` + 重跑 marp browser helper）；
- 更新前记录「当前 slide 索引 + 页内偏移」，更新后**立即** `scrollTop` 恢复（`scrollBehavior=auto`，内容更新路径绝不 smooth）；
- 只有首次加载 / `props.page` 真变化（用户跳页）才滚动到目标页；mermaid/资产二次更新同样 preserve，双 token 防竞态；异常兜底「隐藏 → 恢复 → 显示」；
- 去掉 iframe 内平滑滚动对自动滚动的影响。

### B. 全屏播放（新功能）

`web/src/preview/FullscreenPlayer.vue`：
- 预览工具栏「▶ 全屏播放」（title/aria-label 含"全屏播放"），从当前编辑页开始；
- 黑底 16:9 单页居中铺满；优先 `requestFullscreen()`，被拒/不支持自动退化为 fixed 覆盖层；
- 键盘：→/↓/Space/PageDown/Enter 下一页，←/↑/PageUp/Backspace 上一页，Home/End 首/尾页，Esc 退出；
- HUD：标题、`当前页 / 总页数`、上一页/下一页/退出按钮；底部「← → 翻页 · Esc 退出」；`.mwb-player[data-page]` 便于测试；
- 打开时锁定 body 滚动，退出恢复；不改变编辑器当前页。

### C. 顺手修复（测试中发现）

- **Server SPA fallback bug**：`/edit/<deckId>` 深链接/刷新时，若 deck id 含点号（如 `M3.1-滚动-全屏`、`方案 v1.2`）会被误判为静态资源返回 404。已修 `server/src/routes/mod.rs`：前端路由前缀（`/`、`/edit/`、`/settings`）或路径末段无扩展名 → index.html；真实静态资源缺失仍 404。release exe 已重建。

## 2. 验收结果（真实 exe 12.39MB + Chrome 155）

| 验收项 | 结果 |
|---|---|
| **M3.1 集成 E2E** `node scripts/visual-e2e-m3fix.mjs` | **14/14 ✅** |
| M1 回归 `visual-e2e.mjs --embedded` | 13/13 ✅ |
| M2 回归 `visual-e2e-m2.mjs` | 26/26 ✅ |
| M3 回归 `visual-e2e-m3.mjs` | 21/21 ✅ |
| API 冒烟 `smoke.mjs` | 12/12 ✅ |
| 服务端专项 `server/scripts/smoke.ps1` | 42/42 ✅ |

**M3.1 E2E 关键数据**：
- 13 页 deck，光标移到末尾后：预览 `ratio=1.00`（在底部）；连续键入 35+ 字符采样 44 次：`min=1.00 / topReturns=0 / 波动=0.00` —— **不再出现从顶部滑到底部**。
- 大纲跳第 1 页 / 第 5 页：预览正常定位（`ratio≈0.09 / 0.44`）。
- 中段编辑（第 5 页内打字）：预览位置保持（before=0.44、采样 min=0.44 max=0.44）。
- 全屏播放：起始页 = 当前页；`→/↓/←/Home/End` 翻页断言全对（示例 `6/13 → 7 → 8 → 7 → 13 → 1`）；Esc 退出、body 恢复。
- 0 前端 JS 错误。

**截图**（`spike/visual-m3fix/2026-10-21T11-59-19/`，本地保留不进 git）：
`01-at-end.png` 末尾编辑时预览稳定在底部 ｜ `02-typing-stable.png` 连续打字 ｜ `03-player.png` 全屏播放（HUD/页码/提示） ｜ `04-player-keys.png` 方向键翻页。

## 3. 已知边界

- 全屏内翻页**不同步**编辑器当前页（按契约；退出后编辑器页面不变）。
- 首次加载时预览滚到 slide 上沿（保留 18px 留白）；mermaid 首载 1.4–2.5s 期间先显示代码块再换 SVG（原有行为）。
- 全屏播放使用当前预览的 html/css（含 mermaid/图片 dataURL），不落盘、不修改 Markdown。

## 4. 复现命令

```powershell
pnpm run build            # 如需重新打包（web/dist 变更后必须重建 exe）
pnpm run verify:m3fix     # M3.1 验收（14 项，真实 exe + Chrome）
node web/scripts/verify-ui-m3fix.mjs   # 前端组自测（可选）
```

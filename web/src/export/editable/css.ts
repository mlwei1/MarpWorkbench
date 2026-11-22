/**
 * 背景图层专用的 CSS 覆盖样式（可编辑 PPTX 的「底图」）。
 *
 * 目标：让服务端无头浏览器截出来的背景图里
 *   ① 所有会被重建为 PPT 文本的文字不可见（否则会和可编辑文本重影）；
 *   ② 文字的背景/边框/装饰（pre 代码块底色、inline code 底色、blockquote 底色、页码 ::after）保留；
 *   ③ 表格隐藏（会重建为 PPT 表格对象）；
 *   ④ Mermaid / 公式 SVG 等「只能当图片」的内容保留。
 *
 * ⚠️ 与契约 §2.1.5 的差异（已写进 docs/dev/editable-pptx.md「已知限制」）：
 * 契约示例使用 `color: transparent`，但这会让 `fill="currentColor"` 的 MathJax SVG 公式
 * 一起变透明（实测 marp-core mathjax 输出就是 currentColor SVG），且无法用 `revert` 救回
 * （color 是继承属性，revert 仍是父级的 transparent）。
 * 因此这里只使用 `-webkit-text-fill-color: transparent` 隐藏「文字填充」：
 *   - 普通 HTML 文本：在 Chrome/Edge（导出截图用的就是它们）里彻底不可见；
 *   - SVG 的 fill="currentColor" / mermaid 的 SVG 文本：走 `color` 而不是 fill-color，保持可见；
 *   - 页码 `section::after` 不在隐藏选择器里，保持可见；
 *   - 列表 marker 单独隐藏（PPT 里会重建项目符号）。
 * 主题若用 `background-clip: text` 之类渐变文字，(0,0,0,0) 的 color 会让测量侧跳过该块，
 * 属于已知近似差异。
 */

/** 会被重建为可编辑文本的元素选择器（背景里把这些元素的文字填充变透明） */
const TEXT_HIDE_SELECTORS = [
  'section h1',
  'section h2',
  'section h3',
  'section h4',
  'section h5',
  'section h6',
  'section p',
  'section li',
  'section blockquote',
  'section pre',
  'section marp-pre',
  'section code',
  'section td',
  'section th',
  'section figcaption',
  'section summary',
  'section span',
  'section header',
  'section footer',
  'section div',
  'section dl',
  'section dt',
  'section dd',
  'section caption',
  'section label',
  'section small',
  'section kbd',
  'section samp',
  'section var',
  'section time',
  'section mark',
  'section q',
  'section cite',
  'section abbr',
  'section address',
  'section aside',
  'section article',
  'section figcaption',
  'section section',
].join(',\n')

export const BACKGROUND_OVERRIDE_CSS = `/* ===== MarpWorkbench 可编辑 PPTX：背景图层覆盖样式（layout.ts 注入）===== */
${TEXT_HIDE_SELECTORS} {
  -webkit-text-fill-color: transparent !important;
  text-shadow: none !important;
  text-decoration-color: transparent !important;
}
/* 表格会重建为 PPT 表格对象：底图里隐藏整表（含边框/填充） */
section table {
  visibility: hidden !important;
}
/* 列表项目符号由 PowerPoint 重建（避免与主题 marker 重复） */
section li::marker {
  color: transparent !important;
  -webkit-text-fill-color: transparent !important;
}
/* Mermaid / 公式：只能当图片，恢复文字填充（HTML 标签型 mermaid 用 currentcolor 回到主题色） */
section .mwb-mermaid,
section .mwb-mermaid *,
section mjx-container,
section mjx-container *,
section .MathJax,
section svg text {
  -webkit-text-fill-color: currentcolor !important;
  color: inherit !important;
}
`

/** 把覆盖样式追加到主题 CSS 之后（顺序保证覆盖生效） */
export function buildBackgroundCss(css: string): string {
  const base = (css || '').trimEnd()
  return `${base}\n\n${BACKGROUND_OVERRIDE_CSS}`
}

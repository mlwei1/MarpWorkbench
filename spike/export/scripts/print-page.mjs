/**
 * 打印页 / 截图页模板（与 Rust server/src/export/print_page.rs 保持同一份规则）。
 *
 * 关键规则（来自 docs/research/desktop-packaging.md §1.4 实测）：
 * 1. `@page { size: <W>px <H>px; margin: 0 }` —— 缺了会退化成 Letter 612×792pt + 白边
 * 2. `print-color-adjust: exact` —— 深色主题/渐变背景必须打印
 * 3. 每页 `break-after: page`，最后一页 `auto` —— 否则多出空白页
 * 4. svg[data-marpit-svg]（marp-core 渲染产物）必须显式 1280×720 且 display:block
 * 5. 所有资源内联（html/css 由前端传入）；页面不加载任何外部资源
 */

export const DEFAULT_WIDTH = 1280
export const DEFAULT_HEIGHT = 720

/** 打印页规则（打印 & 截图共用） */
export function pageCss(width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT) {
  return `
@page { size: ${width}px ${height}px; margin: 0; }
html, body {
  margin: 0; padding: 0; background: #ffffff;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}
div.marpit { margin: 0; padding: 0; }
div.marpit > svg[data-marpit-svg] {
  display: block;
  width: ${width}px;
  height: ${height}px;
  margin: 0;
  padding: 0;
}
@media print {
  div.marpit > svg[data-marpit-svg] {
    break-after: page;
    page-break-after: always;
    break-inside: avoid;
    page-break-inside: avoid;
  }
  div.marpit > svg[data-marpit-svg]:last-child {
    break-after: auto;
    page-break-after: auto;
  }
}
`.trim()
}

/** 供 CDP 就绪探测：字体加载 + 两帧布局后置位 */
export function readyScript() {
  return `window.__MWB_READY__ = false;
(function () {
  function markReady() {
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { window.__MWB_READY__ = true; });
      });
    });
  }
  var fontsReady = (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve();
  fontsReady.then(function () { setTimeout(markReady, 120); }).catch(markReady);
})();`
}

/** 内联 marp-core.browser.js 并调用 browser()：启用 auto-scaling 等运行时能力。
 *  坑 1：bundle 内含 `<!--` 序列，直接内联会被 HTML 解析器当成注释吞掉后续脚本；
 *  坑 2：拆成两个 script 时，后续内联脚本在复杂页面上不稳定（实测未执行）；
 *  坑 3：data: 脚本执行时机晚于同位置内联脚本 → 就绪探测必须并入同一段 JS；
 *  → 把「bundle + 自动调用 browser() + 可选就绪探测」拼成一个 JS，base64 data: URL 加载。 */
export function helperScript(bundle, readyMarker = false) {
  const combined = `${bundle}
;(function () {
  try {
    var M = window.MarpCoreBundle && window.MarpCoreBundle.MarpCore;
    if (M && typeof M.browser === 'function') M.browser(document.body);
    window.__MWB_HELPER_APPLIED__ = true;
  } catch (e) {
    window.__MWB_HELPER_APPLIED__ = false;
    console.error('marp browser helper failed', e);
  }
})();${readyMarker ? '\n' + readyScript() : ''}`
  const b64 = Buffer.from(combined, 'utf8').toString('base64')
  return `<script src="data:text/javascript;base64,${b64}"></script>`
}

/**
 * 生成完整静态 HTML。
 * @param {{html:string, css:string, title?:string, width?:number, height?:number,
 *          readyMarker?:boolean, helperBundle?:string}} input
 */
export function buildPage(input) {
  const width = input.width || DEFAULT_WIDTH
  const height = input.height || DEFAULT_HEIGHT
  const title = escapeHtml(input.title || 'MarpWorkbench 导出')
  const helper = input.helperBundle ? helperScript(input.helperBundle, !!input.readyMarker) : ''
  const fallbackReady = input.readyMarker && !helper ? `<script>${readyScript()}<\/script>` : ''
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=${width}, height=${height}, initial-scale=1">
<title>${title}</title>
<link rel="icon" href="data:,">
<style>
${pageCss(width, height)}
${input.css || ''}
</style>
</head>
<body>
${input.html || ''}
${helper}
${fallbackReady}
</body>
</html>`
}

export function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

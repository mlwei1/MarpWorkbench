// 打印页构建（与 server/src/export/print_page.rs 的规则保持一致）：
//  - @page { size: <W>px <H>px; margin: 0 }
//  - print-color-adjust: exact
//  - 每个 svg[data-marpit-svg] 显式 width/height + break-after: page（最后一个 auto）
//  - 内联 marp browser helper（9.3KB，导出页 auto-scaling 用；来源 server/src/export/browser_helper.js）
// 用法（被 run-print-test.mjs 复用）：
//   import { buildPrintPage, pageCss } from './build-print-page.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..', '..')
const HELPER_PATH = path.join(REPO, 'server', 'src', 'export', 'browser_helper.js')

export function pageCss(width = 1280, height = 720) {
  return `@page { size: ${width}px ${height}px; margin: 0; }
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
}`
}

export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function buildPrintPage({ html, css = '', title = 'MarpWorkbench', width = 1280, height = 720, readyMarker = false, withHelper = true }) {
  const helper = withHelper && fs.existsSync(HELPER_PATH) ? `<script>${fs.readFileSync(HELPER_PATH, 'utf8')}</script>` : ''
  const ready = readyMarker
    ? `<script>
window.__MWB_READY__ = false;
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
})();
</script>`
    : ''
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=${width}, height=${height}, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="data:,">
<style>
${pageCss(width, height)}
${css}
</style>
</head>
<body>
${html}
${helper}
${ready}
</body>
</html>`
}

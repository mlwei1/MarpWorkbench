/**
 * 生成 `server/src/export/browser_helper.js`：把 @marp-team/marp-core 的浏览器 helper
 * （lib/browser.js，9.3KB 自执行 IIFE）加版权头后内嵌进 Rust 导出模块。
 *
 * 为什么需要它：marp-core 的 auto-scaling 是浏览器运行时能力（自定义元素 <marp-pre> 等）。
 * 静态打印页/截图页如果不加载 helper，内容密集页会被 section{overflow:hidden} 裁切，
 * 与前端预览不一致（spike/export/scripts/diag-fit.mjs 有实测对比）。
 *
 * 用法：node spike/export/scripts/vendor-helper.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const REPO = path.resolve(ROOT, '..', '..')

const src = path.join(REPO, 'web', 'node_modules', '@marp-team', 'marp-core', 'lib', 'browser.js')
const dest = path.join(REPO, 'server', 'src', 'export', 'browser_helper.js')

const pkg = JSON.parse(
  fs.readFileSync(path.join(REPO, 'web', 'node_modules', '@marp-team', 'marp-core', 'package.json'), 'utf8')
)
const body = fs.readFileSync(src, 'utf8')
if (body.includes('</script') || body.includes('<!--')) {
  throw new Error('helper 含 </script 或 <!--，内联进 HTML 会出问题，需要改为 data: URL 方案')
}

const header = `/*!
 * marp-core browser helper（用于导出页：注册 auto-scaling 自定义元素 <marp-pre> 等）
 *
 * 来源：@marp-team/marp-core@${pkg.version} / lib/browser.js（MIT License, Copyright (c) Marp team）
 * https://github.com/marp-team/marp-core
 *
 * 为什么单独内嵌这份 9.3KB 的 IIFE，而不是内嵌 3.85MB 的 marp-core.browser.js：
 *   导出页只需要"浏览器运行时 helper"（custom elements + auto-scaling），不需要 Marp 渲染器/MathJax。
 *   用完整 bundle 会让每个打印页/截图页多 5MB、CDP 就绪时间从 ~0.4s 涨到 ~1.1–4s。
 * 该 IIFE 加载时会自动对 document.currentScript 所在文档应用 helper（无需额外调用）。
 * 重新生成：node spike/export/scripts/vendor-helper.mjs
 */
`
fs.writeFileSync(dest, header + body + '\n')
console.log(JSON.stringify({ src, dest, version: pkg.version, bytes: fs.statSync(dest).size }, null, 2))

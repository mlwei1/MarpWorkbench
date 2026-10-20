/**
 * 构建 mermaid 浏览器 IIFE 包（MarpWorkbench M3-1 图表）
 *
 * 产物：web/public/mermaid.browser.js
 *   - esbuild IIFE，全局 window.MermaidBundle = { default: mermaid, mermaid }
 *   - 调用方式：await MermaidBundle.default.render(id, code) （契约 §1.2）
 *   - 完全离线：mermaid 及其全部依赖（d3/dagre/cytoscape/elk/katex/…）全部内联，无任何外链
 *
 * 用法：node scripts/build-mermaid-bundle.mjs
 *   （根 package.json 可挂 `build:mermaid`；构建顺序建议：build:mermaid → build:marp → web build）
 *
 * 体积预算（契约 §1.2）：单文件 min ≤ 6MB、gzip ≤ 1.6MB。超标 → 非 0 退出并提示降级方向。
 *
 * 说明：
 *  - mermaid 装在 web/ 工程（`pnpm --dir web add mermaid`），脚本通过 createRequire 从 web/ 解析 esbuild。
 *  - 同时构建一份未压缩版本用于体积对比（raw），但只写 minify 产物，避免 public 目录多一个无用大文件。
 */
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import zlib from 'node:zlib'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const webDir = path.join(repoRoot, 'web')
const requireFromWeb = createRequire(pathToFileURL(path.join(webDir, 'package.json')))
const esbuild = requireFromWeb('esbuild')

const mermaidPkg = requireFromWeb('mermaid/package.json')
const publicDir = path.join(webDir, 'public')
const outFile = path.join(publicDir, 'mermaid.browser.js')

const BUDGET_MIN_MB = 6
const BUDGET_GZIP_MB = 1.6

// 入口用 stdin 注入，避免在 web/ 下多一个仅构建用的入口文件；
// resolveDir 指向 web/，让 `import mermaid from 'mermaid'` 按 web/node_modules 解析。
const ENTRY = `import mermaid from 'mermaid'
export default mermaid
export { mermaid }
`

const SHARED = {
  stdin: {
    contents: ENTRY,
    resolveDir: webDir,
    sourcefile: 'mermaid-entry.js',
    loader: 'js',
  },
  bundle: true,
  format: 'iife',
  globalName: 'MermaidBundle',
  platform: 'browser',
  target: ['chrome110', 'edge110'],
  sourcemap: false,
  write: false,
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'none',
  logLevel: 'warning',
}

const log = (msg) => console.log(`[build-mermaid-bundle] ${msg}`)
const mb = (n) => (n / 1024 / 1024).toFixed(2)

async function buildOnce(minify) {
  const t0 = Date.now()
  const result = await esbuild.build({ ...SHARED, minify })
  const code = Buffer.from(result.outputFiles[0].contents)
  return { code, ms: Date.now() - t0 }
}

async function main() {
  fs.mkdirSync(publicDir, { recursive: true })
  log(`mermaid@${mermaidPkg.version}（esbuild ${requireFromWeb('esbuild/package.json').version}）`)

  // 1) 未压缩（raw，仅测量，不落盘）——给出 minify 收益
  const raw = await buildOnce(false)
  // 2) 实际产物（minify）
  const min = await buildOnce(true)
  const code = min.code

  fs.writeFileSync(outFile, code)

  const gzip = zlib.gzipSync(code, { level: 9 }).length
  const brotli = zlib.brotliCompressSync(code).length
  const rawGzip = zlib.gzipSync(raw.code, { level: 9 }).length

  log(`产物：${path.relative(repoRoot, outFile)}`)
  log(`  raw  ${mb(raw.code.length)} MB（gzip ${mb(rawGzip)} MB，${raw.ms} ms，仅测量）`)
  log(`  min  ${mb(code.length)} MB  ← 实际加载体积（${min.ms} ms）`)
  log(`  gzip ${mb(gzip)} MB / brotli ${mb(brotli)} MB（min 产物压缩后）`)
  log(`  预算：min ≤ ${BUDGET_MIN_MB} MB（${mb(code.length)} / ${BUDGET_MIN_MB}）、gzip ≤ ${BUDGET_GZIP_MB} MB（${mb(gzip)} / ${BUDGET_GZIP_MB}）`)

  // 3) 产物健壮性检查：全局名/API/无外网硬编码依赖（mermaid 包内可能有示例 URL 字符串，只查明显 CDN 引用）
  const text = code.toString('utf8')
  if (!text.includes('MermaidBundle')) throw new Error('产物中未发现 MermaidBundle 全局赋值，请检查入口/globalName')
  const cdnRefs = [/https?:\/\/cdn\.jsdelivr\.net\/[^"']*/g, /https?:\/\/unpkg\.com\/[^"']*/g, /https?:\/\/cdnjs\.cloudflare\.com\/[^"']*/g]
  for (const re of cdnRefs) {
    const hits = text.match(re) || []
    if (hits.length) log(`⚠ 产物中发现 ${hits.length} 处 CDN 字符串（需人工确认是否仅为示例/注释）：${[...new Set(hits)].slice(0, 3).join(', ')}`)
  }

  const overBudget = code.length > BUDGET_MIN_MB * 1024 * 1024 || gzip > BUDGET_GZIP_MB * 1024 * 1024
  if (overBudget) {
    console.error(
      `[build-mermaid-bundle] 体积超预算：min ${mb(code.length)} MB（≤${BUDGET_MIN_MB}）/ gzip ${mb(gzip)} MB（≤${BUDGET_GZIP_MB}）。\n` +
        `  降级方向：① 降至 mermaid v11/v10 稳定版；② 入口改为按需注册常见 diagram（flowchart/sequence/class/gantt/state/pie/er），\n` +
        `  排除 cytoscape/elk/wardley 等大依赖；③ 接受超预算并同步 Lead/契约调整。详见 docs/dev/mermaid.md。`
    )
    process.exit(1)
  }
  log('完成：体积在预算内。')
}

main().catch((err) => {
  console.error('[build-mermaid-bundle] 失败：', err)
  process.exit(1)
})

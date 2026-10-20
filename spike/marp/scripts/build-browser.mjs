// 用 esbuild 把 marp-core 打成浏览器 IIFE，并统计体积（raw/min/gzip/brotli）
import { build } from 'esbuild'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { gzipSync, brotliCompressSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

mkdirSync(new URL('../out/', import.meta.url), { recursive: true })

const base = {
  entryPoints: [fileURLToPath(new URL('./browser-entry.js', import.meta.url))],
  bundle: true,
  format: 'iife',
  globalName: 'MarpCoreBundle',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
}

const stats = (buf) => ({
  rawBytes: buf.length,
  gzipBytes: gzipSync(buf, { level: 9 }).length,
  brotliBytes: brotliCompressSync(buf).length,
})

const results = {}

// 1) 未压缩（便于观察体积构成）
let t = performance.now()
const dev = await build({ ...base, minify: false, write: false })
const devBuf = Buffer.from(dev.outputFiles[0].contents)
results.dev = { ...stats(devBuf), buildMs: +(performance.now() - t).toFixed(0) }
writeFileSync(new URL('../out/marp-core.browser.js', import.meta.url), devBuf)

// 2) 生产压缩（IIFE，浏览器直接 <script> 引入）
t = performance.now()
const min = await build({ ...base, minify: true, write: false })
const minBuf = Buffer.from(min.outputFiles[0].contents)
results.min = { ...stats(minBuf), buildMs: +(performance.now() - t).toFixed(0) }
writeFileSync(new URL('../out/marp-core.browser.min.js', import.meta.url), minBuf)

// 3) 只打包 browser helper
const helper = await build({
  ...base,
  entryPoints: [fileURLToPath(new URL('./browser-helper-entry.js', import.meta.url))],
  minify: true,
  write: false,
})
const helperBuf = Buffer.from(helper.outputFiles[0].contents)
results.helper = stats(helperBuf)

// 4) 第三方浏览器库体积参考
const libs = {
  'html-to-image': 'node_modules/html-to-image/dist/html-to-image.js',
  'html2canvas': 'node_modules/html2canvas/dist/html2canvas.min.js',
  'pptxgenjs': 'node_modules/pptxgenjs/dist/pptxgen.bundle.js',
}
results.libs = {}
for (const [name, file] of Object.entries(libs)) {
  try {
    const buf = readFileSync(new URL(`../${file}`, import.meta.url))
    results.libs[name] = stats(buf)
  } catch (e) {
    results.libs[name] = { error: String(e) }
  }
}

// 5) KaTeX 字体（离线内嵌必须）
const fontsDir = new URL('../node_modules/katex/dist/fonts/', import.meta.url)
try {
  const files = readdirSync(fontsDir).filter((f) => f.endsWith('.woff2'))
  let total = 0
  for (const f of files) total += statSync(new URL(f, fontsDir)).size
  results.katexFonts = { woff2Files: files.length, woff2Bytes: total }
} catch (e) {
  results.katexFonts = { error: String(e) }
}

writeFileSync(
  new URL('../out/browser-bundle-report.json', import.meta.url),
  JSON.stringify(results, null, 2),
)
console.log(JSON.stringify(results, null, 2))

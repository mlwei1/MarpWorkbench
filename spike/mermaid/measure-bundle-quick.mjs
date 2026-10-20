// 快速体积测量：esbuild 打包 mermaid（IIFE，minify），输出 raw/gzip/brotli
// 用法：node spike/mermaid/measure-bundle-quick.mjs [版本/入口说明]
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import zlib from 'node:zlib'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const webDir = path.join(repoRoot, 'web')
const requireFromWeb = createRequire(pathToFileURL(path.join(webDir, 'package.json')))
const esbuild = requireFromWeb('esbuild')

const t0 = Date.now()
const result = await esbuild.build({
  stdin: {
    contents: "import mermaid from 'mermaid';\nexport default mermaid;",
    resolveDir: webDir,
    sourcefile: 'mermaid-entry.js',
    loader: 'js',
  },
  bundle: true,
  format: 'iife',
  globalName: 'MermaidBundle',
  platform: 'browser',
  target: ['chrome110', 'edge110'],
  minify: true,
  sourcemap: false,
  write: false,
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
})
const code = Buffer.from(result.outputFiles[0].contents)
const gzip = zlib.gzipSync(code, { level: 9 }).length
const br = zlib.brotliCompressSync(code).length
const mb = (n) => (n / 1024 / 1024).toFixed(2)
console.log(`mermaid esbuild IIFE: ${mb(code.length)} MB min / ${mb(gzip)} MB gzip / ${mb(br)} MB br (${Date.now() - t0} ms)`)

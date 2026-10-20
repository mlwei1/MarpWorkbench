/**
 * 构建 marp-core 浏览器 IIFE 包（MarpWorkbench 前端渲染唯一来源）
 *
 * 产物：
 *   web/public/marp-core.browser.js   —— 全局 window.MarpCoreBundle.MarpCore = { Marp, browser }
 *   web/public/katex/fonts/*.woff2    —— 本地 KaTeX 字体（离线：用户 deck 显式 math: katex 时使用）
 *
 * 用法：node scripts/build-marp-browser.mjs   （根 package.json: pnpm run build:marp）
 *
 * 说明：esbuild 从 web/node_modules 解析（依赖装在 web 工程里），
 *      因此脚本本身不依赖根目录 node_modules。
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

const publicDir = path.join(webDir, 'public')
const entryFile = path.join(webDir, 'build', 'marp-browser-entry.js')
const outFile = path.join(publicDir, 'marp-core.browser.js')

function log(msg) {
  console.log(`[build-marp-browser] ${msg}`)
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

async function main() {
  ensureDir(publicDir)
  if (!fs.existsSync(entryFile)) throw new Error(`入口文件不存在: ${entryFile}`)

  const t0 = Date.now()
  const result = await esbuild.build({
    entryPoints: [entryFile],
    bundle: true,
    format: 'iife',
    globalName: '__MarpCoreModule',
    platform: 'browser',
    target: ['chrome110', 'edge110'],
    minify: true,
    sourcemap: false,
    write: false,
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'warning',
  })
  const code = Buffer.from(result.outputFiles[0].contents)
  ensureDir(path.dirname(outFile))
  fs.writeFileSync(outFile, code)

  const gzip = zlib.gzipSync(code, { level: 9 }).length
  const brotli = zlib.brotliCompressSync(code).length
  log(`marp-core.browser.js  ${(code.length / 1024 / 1024).toFixed(2)} MB min / ${(gzip / 1024 / 1024).toFixed(2)} MB gzip / ${(brotli / 1024).toFixed(0)} KB br  (${Date.now() - t0} ms)`)

  // 离线：本地化 KaTeX 字体（20 个 woff2，约 260KB）；用户 deck 显式 math: katex 时使用 /katex/fonts/
  // 注意：katex 是 marp-core 的嵌套依赖，pnpm 严格模式下需从 marp-core 处解析
  const requireFromMarpCore = createRequire(requireFromWeb.resolve('@marp-team/marp-core/package.json'))
  const katexPkg = path.dirname(requireFromMarpCore.resolve('katex/package.json'))
  const srcFonts = path.join(katexPkg, 'dist', 'fonts')
  const dstFonts = path.join(publicDir, 'katex', 'fonts')
  ensureDir(dstFonts)
  let copied = 0
  let bytes = 0
  for (const name of fs.readdirSync(srcFonts)) {
    if (!name.endsWith('.woff2')) continue
    fs.copyFileSync(path.join(srcFonts, name), path.join(dstFonts, name))
    copied += 1
    bytes += fs.statSync(path.join(dstFonts, name)).size
  }
  log(`KaTeX 字体本地化：${copied} 个 woff2，共 ${(bytes / 1024).toFixed(0)} KB → web/public/katex/fonts/`)

  const expectGlobal = 'window.MarpCoreBundle.MarpCore'
  if (!code.toString('utf8').includes('MarpCoreBundle')) {
    throw new Error(`产物中未发现 MarpCoreBundle 全局赋值，请检查 ${entryFile}`)
  }
  log(`全局约定：${expectGlobal} = { Marp, browser }`)
  log('完成。')
}

main().catch((err) => {
  console.error('[build-marp-browser] 失败：', err)
  process.exit(1)
})

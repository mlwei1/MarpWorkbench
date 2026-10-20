// 把 web/src/mermaid/index.ts 打包成浏览器 IIFE（全局 MwbMermaid），供 spike 页面在真实 Chrome 里测真实模块代码
// 用法：node spike/mermaid/scripts/build-test-module.mjs
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..', '..', '..')
const webDir = path.join(REPO, 'web')
const requireFromWeb = createRequire(pathToFileURL(path.join(webDir, 'package.json')))
const esbuild = requireFromWeb('esbuild')

const outDir = path.join(REPO, 'spike', 'mermaid', 'out')
fs.mkdirSync(outDir, { recursive: true })
const outFile = path.join(outDir, 'mermaid-module.js')

const result = await esbuild.build({
  entryPoints: [path.join(webDir, 'src', 'mermaid', 'index.ts')],
  bundle: true,
  format: 'iife',
  globalName: 'MwbMermaid',
  platform: 'browser',
  target: ['chrome110', 'edge110'],
  minify: false,
  sourcemap: false,
  write: false,
  define: { 'process.env.NODE_ENV': '"development"' },
  logLevel: 'warning',
})
const code = Buffer.from(result.outputFiles[0].contents)
fs.writeFileSync(outFile, code)
console.log(`[build-test-module] ${(code.length / 1024).toFixed(1)} KB → ${path.relative(REPO, outFile)}`)

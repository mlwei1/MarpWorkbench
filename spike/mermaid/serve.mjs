// 静态 HTTP 服务（mermaid spike 自测用）：
//  - /mermaid.browser.js  → web/public/mermaid.browser.js（构建产物，全局 MermaidBundle）
//  - /marp-core.browser.js→ web/public/marp-core.browser.js（真实渲染链路）
//  - /out/*               → spike/mermaid/out/*（模块测试包、打印页）
//  - /page/*              → spike/mermaid/page/*（测试页面）
//  - /_health            → 200 ok（供启动探测）
// 用法：node spike/mermaid/serve.mjs（PORT 环境变量可选，默认 18771）
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..', '..')
const WEB_PUBLIC = path.join(REPO, 'web', 'public')

const ROUTES = [
  { prefix: '/out/', dir: path.join(HERE, 'out') },
  { prefix: '/page/', dir: path.join(HERE, 'page') },
]
const STATIC = {
  '/mermaid.browser.js': path.join(WEB_PUBLIC, 'mermaid.browser.js'),
  '/marp-core.browser.js': path.join(WEB_PUBLIC, 'marp-core.browser.js'),
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

export function startServer(port = Number(process.env.PORT || 18771)) {
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      if (url.pathname === '/_health') {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('ok')
        return
      }
      let file = STATIC[url.pathname]
      if (!file) {
        for (const route of ROUTES) {
          if (url.pathname.startsWith(route.prefix)) {
            const rel = decodeURIComponent(url.pathname.slice(route.prefix.length))
            file = path.normalize(path.join(route.dir, rel))
            if (!file.startsWith(route.dir)) file = null
            break
          }
        }
      }
      if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('not found: ' + url.pathname)
        return
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' })
      fs.createReadStream(file).pipe(res)
    } catch (err) {
      res.writeHead(500)
      res.end(String(err))
    }
  })
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` }))
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { url } = await startServer()
  console.log(`[serve] LISTENING ${url}/`)
}

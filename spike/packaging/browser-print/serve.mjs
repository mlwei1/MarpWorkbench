// 静态 HTTP 服务：供 headless 打印实测使用（模拟便携 exe 内置服务器）
// 用法：node browser-print/serve.mjs   （PORT 环境变量可选，默认 18765）
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SLIDES = path.join(__dirname, '..', 'slides')
const PORT = Number(process.env.PORT || 18765)
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' }

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const rel = url.pathname === '/' ? '/deck.html' : decodeURIComponent(url.pathname)
  const file = path.normalize(path.join(SLIDES, rel))
  if (!file.startsWith(SLIDES) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
}).listen(PORT, '127.0.0.1', () => {
  console.log(`LISTENING http://127.0.0.1:${PORT}/`)
})

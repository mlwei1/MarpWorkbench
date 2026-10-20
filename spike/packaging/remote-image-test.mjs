#!/usr/bin/env node
/**
 * M3 网络图片代理 + 一键本地化 自测脚本（server-core / task-14）
 *
 * 用法：
 *   node spike/packaging/remote-image-test.mjs                 # 用默认 release exe
 *   node spike/packaging/remote-image-test.mjs --exe server/target/debug/MarpWorkbench.exe
 *
 * 覆盖：
 *   1) 本地假“远程”图片服务（127.0.0.1）→ exe 以 MWB_PROXY_ALLOW_PRIVATE=1 启动（仅测试）
 *   2) /api/proxy/image：200 + 正确 content-type、缓存命中（上游计数不增长）、
 *      无/错 token 401、非图片 400、超 15MB 400、ftp 400、302 跟随、重定向循环 502、404
 *   3) 私有网络拦截：不带 MWB_PROXY_ALLOW_PRIVATE 的实例访问 127.0.0.1 → 400
 *   4) POST /api/decks/:id/localize-images：mapping/failed/落盘/不改 markdown/51 张 400
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const argValue = (name, dflt) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const exe = resolve(argValue('--exe', 'server/target/release/MarpWorkbench.exe'))
if (!existsSync(exe)) {
  console.error(`[m3] 未找到 exe: ${exe}（先 cargo build --release）`)
  process.exit(1)
}

// 1x1 透明 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

// ---------------- 本地假“远程”图片服务 ----------------
const hits = new Map()
const hit = (p) => {
  hits.set(p, (hits.get(p) || 0) + 1)
}
const imageServer = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const p = url.pathname
  hit(p)
  if (p === '/good.png' || p === '/good2.png') {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PNG.length })
    res.end(PNG)
  } else if (p === '/notimage') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('this is not an image')
  } else if (p === '/big.png') {
    const size = 16 * 1024 * 1024
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': size })
    // 分块发送，避免一次性大 Buffer
    const chunk = Buffer.alloc(64 * 1024, 1)
    let sent = 0
    const write = () => {
      while (sent < size) {
        sent += chunk.length
        if (!res.write(chunk)) {
          res.once('drain', write)
          return
        }
      }
      res.end()
    }
    write()
  } else if (p === '/redirect') {
    res.writeHead(302, { Location: '/good.png' })
    res.end()
  } else if (p === '/loop') {
    res.writeHead(302, { Location: '/loop' })
    res.end()
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('not found')
  }
})
await new Promise((r) => imageServer.listen(0, '127.0.0.1', r))
const imgBase = `http://127.0.0.1:${imageServer.address().port}`

// ---------------- 启动 exe ----------------
const children = []
const dataDirs = []
async function startExe({ allowPrivate }) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mwb-m3-'))
  dataDirs.push(dataDir)
  const env = {
    ...process.env,
    MWB_DATA_DIR: dataDir,
    MWB_NO_OPEN: '1',
    MWB_PORT: '0',
    ...(allowPrivate ? { MWB_PROXY_ALLOW_PRIVATE: '1' } : {}),
  }
  const child = spawn(exe, ['--no-open'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  let stdout = ''
  child.stdout.on('data', (d) => (stdout += d.toString()))
  const started = Date.now()
  while (Date.now() - started < 30000) {
    const mUrl = stdout.match(/MWB_LISTEN_URL=(\S+)/)
    const mTok = stdout.match(/MWB_TOKEN=(\S+)/)
    if (mUrl && mTok) return { child, dataDir, base: mUrl[1], token: mTok[1] }
    await sleep(100)
  }
  throw new Error(`exe 启动超时；stdout=${stdout.slice(-500)}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
  return ok
}
async function api(inst, path, opts = {}) {
  const res = await fetch(`${inst.base}/api${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'X-MWB-Token': inst.token,
      ...(opts.headers || {}),
    },
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* ignore */
  }
  return { status: res.status, json, text, headers: res.headers }
}
const proxyUrl = (inst, url) =>
  `${inst.base}/api/proxy/image?url=${encodeURIComponent(url)}&token=${encodeURIComponent(inst.token)}`
const sha256 = (text) => createHash('sha256').update(text).digest('hex')

try {
  const instA = await startExe({ allowPrivate: true })
  check('exe 启动（MWB_PROXY_ALLOW_PRIVATE=1）', true, instA.base)

  // ---------- 代理：正常 + content-type ----------
  const goodUrl = `${imgBase}/good.png`
  let res = await fetch(proxyUrl(instA, goodUrl))
  let body = Buffer.from(await res.arrayBuffer())
  check(
    '代理图片 200 + image/png',
    res.status === 200 && (res.headers.get('content-type') || '').startsWith('image/png') && body.equals(PNG),
    `status=${res.status} bytes=${body.length}`
  )
  check('缓存响应头 Cache-Control', (res.headers.get('cache-control') || '').includes('max-age=86400'))

  // ---------- 缓存命中：上游请求计数不增长 ----------
  const before = hits.get('/good.png') || 0
  await sleep(50)
  res = await fetch(proxyUrl(instA, goodUrl))
  await res.arrayBuffer()
  const after = hits.get('/good.png') || 0
  check('同 URL 第二次命中缓存（上游未再次请求）', after === before, `hits ${before} -> ${after}`)
  const hash = sha256(goodUrl)
  const cacheDir = join(tmpdir(), 'MarpWorkbench', 'imgcache')
  const cached = existsSync(cacheDir) ? readdirSync(cacheDir).filter((f) => f.startsWith(hash)) : []
  check('缓存文件 <sha256>.<ext> 落盘', cached.length === 1 && cached[0].endsWith('.png'), cached.join(','))

  // ---------- 鉴权 ----------
  res = await fetch(`${instA.base}/api/proxy/image?url=${encodeURIComponent(goodUrl)}`)
  check('代理无 token → 401', res.status === 401, `status=${res.status}`)
  res = await fetch(`${instA.base}/api/proxy/image?url=${encodeURIComponent(goodUrl)}&token=deadbeef`)
  check('代理错误 token → 401', res.status === 401, `status=${res.status}`)

  // ---------- 非图片 / 超大 / 非法协议 / 404 ----------
  res = await fetch(proxyUrl(instA, `${imgBase}/notimage`))
  let json = await res.json().catch(() => null)
  check('非图片 content-type → 400', res.status === 400 && /图片类型/.test(json?.error?.message || ''), `status=${res.status} msg=${json?.error?.message}`)

  res = await fetch(proxyUrl(instA, `${imgBase}/big.png`))
  json = await res.json().catch(() => null)
  check('超过 15MB → 400', res.status === 400 && /15MB/.test(json?.error?.message || ''), `status=${res.status} msg=${json?.error?.message}`)

  res = await fetch(proxyUrl(instA, 'ftp://example.com/a.png'))
  json = await res.json().catch(() => null)
  check('ftp 协议 → 400', res.status === 400 && /http/.test(json?.error?.message || ''), `status=${res.status} msg=${json?.error?.message}`)

  res = await fetch(proxyUrl(instA, `${imgBase}/404.png`))
  json = await res.json().catch(() => null)
  check('上游 404 → 404', res.status === 404, `status=${res.status} msg=${json?.error?.message}`)

  // ---------- 重定向 ----------
  const beforeRedirect = hits.get('/good.png') || 0
  res = await fetch(proxyUrl(instA, `${imgBase}/redirect`))
  body = Buffer.from(await res.arrayBuffer())
  check('302 跟随 → 200 图片', res.status === 200 && body.equals(PNG), `status=${res.status}`)
  check('重定向目标确实被请求', (hits.get('/good.png') || 0) > beforeRedirect)

  res = await fetch(proxyUrl(instA, `${imgBase}/loop`))
  json = await res.json().catch(() => null)
  check('重定向循环 → 502 可读错误', res.status === 502 && /重定向/.test(json?.error?.message || ''), `status=${res.status} msg=${json?.error?.message}`)

  // ---------- 私有网络拦截（实例 B 未开测试开关）----------
  const instB = await startExe({ allowPrivate: false })
  check('exe 启动（未开 MWB_PROXY_ALLOW_PRIVATE）', true, instB.base)
  res = await fetch(proxyUrl(instB, goodUrl))
  json = await res.json().catch(() => null)
  check(
    '默认拒绝本机/内网图片地址 → 400',
    res.status === 400 && /内网|本机/.test(json?.error?.message || ''),
    `status=${res.status} msg=${json?.error?.message}`
  )

  // ---------- 一键本地化 ----------
  const created = await api(instA, '/decks', {
    method: 'POST',
    body: JSON.stringify({ name: 'M3网络图片测试', template: 'blank' }),
  })
  const deckId = created.json?.id
  check('创建测试 deck', created.status === 200 && !!deckId, deckId)
  const encId = encodeURIComponent(deckId)
  const beforeDeck = await api(instA, `/decks/${encId}`)

  const good2Url = `${imgBase}/good2.png`
  const localize = await api(instA, `/decks/${encId}/localize-images`, {
    method: 'POST',
    body: JSON.stringify({ urls: [goodUrl, good2Url, `${imgBase}/notimage`, `${imgBase}/404.png`] }),
  })
  const mapping = localize.json?.mapping || {}
  const failed = localize.json?.failed || []
  const mappedEntries = Object.entries(mapping)
  check(
    'localize 返回 mapping(2) + failed(2)',
    localize.status === 200 && mappedEntries.length === 2 && failed.length === 2,
    `mapping=${mappedEntries.length} failed=${failed.length}`
  )
  const assetsDir = join(instA.dataDir, deckId, 'assets')
  const files = existsSync(assetsDir) ? readdirSync(assetsDir) : []
  check(
    '图片落盘为 assets/remote-<hash8>.<ext>',
    mappedEntries.length === 2 &&
      mappedEntries.every(([url, path]) => {
        const name = String(path).replace(/^assets\//, '')
        return name.startsWith('remote-') && name.endsWith('.png') && files.includes(name) && sha256(url).slice(0, 8) === name.slice(7, 15)
      }),
    files.join(',')
  )
  check('失败项含可读 reason', failed.every((f) => typeof f.reason === 'string' && f.reason.length > 0), JSON.stringify(failed))
  const afterDeck = await api(instA, `/decks/${encId}`)
  check('不修改 markdown（deck 内容/rev 未变）', afterDeck.json?.rev === beforeDeck.json?.rev)

  const tooMany = await api(instA, `/decks/${encId}/localize-images`, {
    method: 'POST',
    body: JSON.stringify({ urls: Array.from({ length: 51 }, (_, i) => `${imgBase}/good.png?i=${i}`) }),
  })
  check('localize 超过 50 张 → 400', tooMany.status === 400, `status=${tooMany.status}`)

  // ---------- 关闭 ----------
  for (const inst of [instA, instB]) {
    await api(inst, '/shutdown', { method: 'POST' }).catch(() => null)
  }
  await sleep(500)
} catch (e) {
  check('自测脚本执行', false, String(e?.stack || e))
} finally {
  for (const child of children) {
    try {
      child.kill()
    } catch {
      /* ignore */
    }
  }
  imageServer.close()
  for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true })
}

const failedChecks = results.filter((r) => !r.ok)
console.log(`\n[remote-image-test] ${results.length - failedChecks.length}/${results.length} 通过`)
if (failedChecks.length) process.exit(1)

/**
 * M3 真实 exe 端到端验收（owner: export-eng）：
 *   1) 启动本地「假远程」图片服务器（127.0.0.1，exe 以 MWB_PROXY_ALLOW_PRIVATE=1 启动）
 *   2) 真实 release exe（临时数据目录）→ 建 deck（含 http(s) 图片 markdown）
 *   3) 服务端契约：/api/proxy/image（200/缓存/非法 URL/非图片）、/api/decks/:id/localize-images（映射+落盘）
 *   4) 真实浏览器（exe 服务页面）：Banner 检测 → 预览代理 URL → 点「下载到本地」→ markdown 替换
 *   5) 真实 UI 图片原位编辑：光标放到 ![bg left:40%] 行 → 工具栏图片按钮 → 「编辑图片」→ 改右侧 60% →
 *      保存 → markdown 原位替换（无新增行）
 *
 * 前置：release exe 需包含最新 server（proxy/localize）与 web/dist（M3 前端）。
 *       脚本会检查 exe 时间戳，过旧则自动 cargo build --release（可能等 cargo 锁）。
 * 用法：node spike/export/scripts/verify-m3-e2e.mjs
 * 产物：spike/export/out/m3-e2e-report.json + m3-e2e-banner.png / m3-e2e-edit.png
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const REPO = path.resolve(ROOT, '..', '..')
const outDir = path.join(ROOT, 'out')
fs.mkdirSync(outDir, { recursive: true })
const EXE = path.join(REPO, 'server', 'target', 'release', 'MarpWorkbench.exe')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + String(detail).slice(0, 260) : ''}`)
  return ok
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 1x1 透明 PNG
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

function ensureFreshExe() {
  if (!fs.existsSync(EXE)) return false
  // 并行开发期 Lead/队友的 web/dist 会频繁重建，可显式跳过自动重建：
  //   $env:MWB_SKIP_BUILD='1'; node ...（使用当前 exe 验证即可）
  if (process.env.MWB_SKIP_BUILD === '1') return true
  const t = (p) => {
    try {
      return fs.statSync(p).mtimeMs
    } catch {
      return 0
    }
  }
  const exeT = t(EXE)
  const srcT = Math.max(t(path.join(REPO, 'server', 'src', 'routes', 'proxy.rs')), t(path.join(REPO, 'server', 'src', 'routes', 'mod.rs')), t(path.join(REPO, 'web', 'dist', 'index.html')))
  if (exeT >= srcT) return true
  console.log(`[m3-e2e] exe 过旧（exe=${new Date(exeT).toISOString()} src=${new Date(srcT).toISOString()}），cargo build --release…`)
  const res = spawnSync('cargo', ['build', '--release', '--manifest-path', path.join(REPO, 'server', 'Cargo.toml')], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 12 * 60 * 1000
  })
  if (res.status !== 0) {
    console.error('[m3-e2e] cargo build 失败：', (res.stderr || res.stdout || '').slice(-1500))
    return false
  }
  return fs.existsSync(EXE)
}

// ---------------- 本地假「远程」图片服务 ----------------
function startImageServer() {
  const payloads = new Map([
    ['/a.png', { type: 'image/png', body: PNG_1PX }],
    ['/b.png', { type: 'image/png', body: PNG_1PX }],
    ['/note.txt', { type: 'text/plain', body: Buffer.from('not an image') }]
  ])
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      if (url.pathname === '/redirect.png') {
        res.writeHead(302, { Location: '/a.png' })
        res.end()
        return
      }
      const item = payloads.get(url.pathname)
      if (!item) {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('not found')
        return
      }
      res.writeHead(200, { 'Content-Type': item.type, 'Content-Length': item.body.length })
      res.end(item.body)
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

async function waitListen(child, timeoutMs = 40000) {
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => (stdout += d.toString()))
  child.stderr.on('data', (d) => (stderr += d.toString()))
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const mUrl = stdout.match(/MWB_LISTEN_URL=(\S+)/)
    const mTok = stdout.match(/MWB_TOKEN=(\S+)/)
    if (mUrl && mTok) return { base: mUrl[1].replace(/\/$/, ''), token: mTok[1], stdout, stderr }
    await sleep(120)
  }
  throw new Error(`等待服务启动超时 stdout=${stdout.slice(-500)} stderr=${stderr.slice(-500)}`)
}

async function api(base, token, route, init = {}) {
  const headers = { 'Content-Type': 'application/json', ...(init.headers || {}) }
  if (token) headers['X-MWB-Token'] = token
  const res = await fetch(base + '/api' + route, { ...init, headers })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* ignore */
  }
  return { status: res.status, json, text, headers: res.headers }
}

async function download(base, token, url) {
  const res = await fetch(base + url, { headers: token ? { 'X-MWB-Token': token } : {} })
  const buf = Buffer.from(await res.arrayBuffer())
  return { status: res.status, buf, contentType: res.headers.get('content-type') || '' }
}

let imageServer = null
let child = null
let dataDir = null
let browser = null
const imgUrls = {}

try {
  if (!ensureFreshExe()) throw new Error('release exe 不可用')
  const img = await startImageServer()
  imageServer = img.server
  const imgBase = `http://127.0.0.1:${img.port}`
  imgUrls.a = `${imgBase}/a.png`
  imgUrls.b = `${imgBase}/b.png`
  check('本地假远程图片服务启动', true, `127.0.0.1:${img.port}`)

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mwb-m3-e2e-'))
  child = spawn(EXE, [], {
    env: { ...process.env, MWB_DATA_DIR: dataDir, MWB_NO_OPEN: '1', MWB_PROXY_ALLOW_PRIVATE: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const { base, token } = await waitListen(child)
  check('真实 exe 启动', true, base)

  // ---------------- 服务端契约：proxy ----------------
  const p1 = await download(base, '', `/api/proxy/image?url=${encodeURIComponent(imgUrls.a)}&token=${token}`)
  check(
    'proxy：GET 远程图片 200 + image/png + 字节正确',
    p1.status === 200 && p1.contentType.includes('image/png') && p1.buf.equals(PNG_1PX),
    `status=${p1.status} type=${p1.contentType} bytes=${p1.buf.length}`
  )
  const t0 = Date.now()
  const p2 = await download(base, '', `/api/proxy/image?url=${encodeURIComponent(imgUrls.a)}&token=${token}`)
  const cachedMs = Date.now() - t0
  check('proxy：二次请求命中缓存（仍 200）', p2.status === 200 && p2.buf.equals(PNG_1PX), `cachedMs=${cachedMs}`)

  const pRedirect = await download(base, '', `/api/proxy/image?url=${encodeURIComponent(`${imgBase}/redirect.png`)}&token=${token}`)
  check('proxy：跟随 302 重定向（≤3 跳）', pRedirect.status === 200 && pRedirect.buf.equals(PNG_1PX), `status=${pRedirect.status}`)

  const pBadScheme = await download(base, '', `/api/proxy/image?url=${encodeURIComponent('file:///C:/Windows/win.ini')}&token=${token}`)
  check('proxy：拒绝 file:// 等非 http(s)', pBadScheme.status === 400, `status=${pBadScheme.status}`)

  const pNonImage = await download(base, '', `/api/proxy/image?url=${encodeURIComponent(`${imgBase}/note.txt`)}&token=${token}`)
  check('proxy：拒绝非图片 content-type', pNonImage.status >= 400 && pNonImage.status < 500, `status=${pNonImage.status}`)

  const pBadToken = await download(base, '', `/api/proxy/image?url=${encodeURIComponent(imgUrls.a)}&token=deadbeef`)
  check('proxy：错误 token 被拒', pBadToken.status === 401 || pBadToken.status === 403, `status=${pBadToken.status}`)

  // ---------------- 建 deck（含网络图片） ----------------
  const created = await api(base, token, '/decks', {
    method: 'POST',
    body: JSON.stringify({ name: 'M3 网络图片与编辑', template: 'blank' })
  })
  const deckId = created.json?.id
  check('创建 deck', created.status === 200 && !!deckId, deckId)
  const md = [
    '---',
    'marp: true',
    'theme: business-blue',
    'paginate: true',
    '---',
    '# 网络图片页',
    '',
    '这是正文',
    '',
    `![](http://127.0.0.1:${img.port}/a.png)`,
    '',
    `![bg left:40%](http://127.0.0.1:${img.port}/b.png)`,
    '',
    '---',
    '',
    '# 第二页',
    ''
  ].join('\n')
  const saved = await api(base, token, `/decks/${encodeURIComponent(deckId)}`, {
    method: 'PUT',
    body: JSON.stringify({ content: md })
  })
  check('保存含网络图片的 deck', saved.status === 200, `status=${saved.status}`)

  // ---------------- localize-images ----------------
  const loc = await api(base, token, `/decks/${encodeURIComponent(deckId)}/localize-images`, {
    method: 'POST',
    body: JSON.stringify({ urls: [imgUrls.a, imgUrls.b] })
  })
  const mapping = loc.json?.mapping || {}
  const failed = loc.json?.failed || []
  check(
    'localize：返回 url→assets/remote-* 映射（无失败）',
    loc.status === 200 && !!mapping[imgUrls.a] && !!mapping[imgUrls.b] && failed.length === 0,
    JSON.stringify(mapping)
  )
  const assetPath = mapping[imgUrls.a] || ''
  const assetFile = assetPath.replace(/^assets\//, '')
  const assetDl = await download(base, token, `/api/decks/${encodeURIComponent(deckId)}/assets/${encodeURIComponent(assetFile)}`)
  check(
    'localize：资产落盘且可读取（image/png 字节一致）',
    assetDl.status === 200 && assetDl.buf.equals(PNG_1PX),
    `path=${assetPath} bytes=${assetDl.buf.length}`
  )
  const deckAfterLoc = await api(base, token, `/decks/${encodeURIComponent(deckId)}`)
  check('localize：不修改 markdown（只下载）', deckAfterLoc.json?.content?.includes(imgUrls.a), '')

  // ---------------- 真实浏览器（exe 服务页面） ----------------
  const puppeteer = (await import('puppeteer-core')).default
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--disable-gpu', '--no-first-run', '--window-size=1500,950'],
    defaultViewport: { width: 1500, height: 950 }
  })
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)))
  await page.goto(`${base}/?token=${encodeURIComponent(token)}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.goto(`${base}/edit/${encodeURIComponent(deckId)}`, { waitUntil: 'networkidle2', timeout: 120000 })
  await page.waitForSelector('.cm-editor', { timeout: 60000 })
  await sleep(1500)

  // Banner：检测到 2 张网络图片
  await page.waitForSelector('.mwb-remote-banner', { timeout: 30000 }).catch(() => null)
  const bannerText = await page
    .$eval('.mwb-remote-banner', (el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
    .catch(() => '')
  check('UI：Banner 检测到 2 张网络图片', /检测到 2 张网络图片/.test(bannerText), bannerText.slice(0, 140))
  await page.screenshot({ path: path.join(outDir, 'm3-e2e-banner.png') })

  // 预览：网络图片已替换为代理 URL（marp-tech 集成）
  let previewProxied = false
  let previewInfo = ''
  for (let i = 0; i < 40; i++) {
    previewInfo = await page.evaluate(() => {
      const frame = document.querySelector('.preview-pane iframe, iframe.preview-frame')
      const doc = frame?.contentDocument
      if (!doc) return 'no-frame'
      const html = doc.documentElement?.innerHTML || ''
      return `${html.includes('/api/proxy/image?') ? 'proxied' : 'not-proxied'} imgs=${doc.querySelectorAll('img').length}`
    })
    if (previewInfo.startsWith('proxied')) {
      previewProxied = true
      break
    }
    await sleep(300)
  }
  check('UI：预览把网络图片换成代理 URL（同源）', previewProxied, previewInfo)

  // 点「下载到本地」→ 真实 localize → markdown 替换
  await page.evaluate(() => {
    const host = document.querySelector('.remote-banner-host') || document
    const btn = [...host.querySelectorAll('button')].find((b) => (b.textContent || '').includes('下载到本地'))
    btn?.click()
  })
  let localizedMd = ''
  for (let i = 0; i < 50; i++) {
    await sleep(300)
    const cur = await api(base, token, `/decks/${encodeURIComponent(deckId)}`)
    const content = cur.json?.content || ''
    if (/assets\/remote-/.test(content) && !content.includes(imgUrls.a)) {
      localizedMd = content
      break
    }
  }
  check(
    'UI：一键本地化 → markdown 替换为 assets/remote-*（保存成功）',
    /assets\/remote-/.test(localizedMd) && !localizedMd.includes(imgUrls.a),
    JSON.stringify(localizedMd.split('\n').filter((l) => l.includes('![')))
  )
  const bannerGone = await page
    .$$eval('.mwb-remote-banner', (els) => els.length)
    .catch(() => 0)
  check('UI：本地化完成后 Banner 消失', bannerGone === 0, `banners=${bannerGone}`)

  // ---------------- 图片原位编辑（真实 UI） ----------------
  // 等编辑器内容更新，把光标放到 ![bg ...] 行
  let lineClicked = false
  for (let i = 0; i < 40; i++) {
    lineClicked = await page.evaluate(() => {
      const lines = [...document.querySelectorAll('.cm-line')]
      const target = lines.find((el) => (el.textContent || '').includes('![bg left:40%'))
      if (!target) return false
      target.scrollIntoView({ block: 'center' })
      const rect = target.getBoundingClientRect()
      const x = rect.left + 20
      const y = rect.top + rect.height / 2
      const opts = { bubbles: true, clientX: x, clientY: y }
      target.dispatchEvent(new MouseEvent('mousedown', opts))
      target.dispatchEvent(new MouseEvent('mouseup', opts))
      target.dispatchEvent(new MouseEvent('click', opts))
      return true
    })
    if (lineClicked) break
    await sleep(300)
  }
  check('UI：找到背景图行并点击（光标定位）', lineClicked)
  await sleep(500)

  await page.click('button[title*="插入图片"]')
  await page.waitForSelector('.insert-panel', { timeout: 30000 })
  await sleep(900)
  const editTitle = await page.$eval('.insert-panel .modal-head h2', (el) => (el.textContent || '').trim())
  const editSnippet = await page.$eval('.insert-panel .snippet', (el) => (el.textContent || '').trim())
  check(
    'UI：光标在图片行 → 打开「编辑图片」且预填原语法',
    editTitle === '编辑图片' && /!\[bg left:40%/.test(editSnippet),
    JSON.stringify({ editTitle, editSnippet })
  )
  await page.screenshot({ path: path.join(outDir, 'm3-e2e-edit.png') })

  // 改右侧 60%
  await page.evaluate(() => {
    const panel = document.querySelector('.insert-panel')
    const rightBtn = [...panel.querySelectorAll('.seg-btn')].find((b) => (b.textContent || '').trim() === '右侧')
    rightBtn?.click()
    const labels = [...panel.querySelectorAll('label.field')]
    const ratioLabel = labels.find((l) => (l.textContent || '').includes('占比'))
    const input = ratioLabel?.querySelector('input[type="range"]')
    if (input) {
      input.value = '60'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
  })
  await sleep(400)
  const newSnippet = await page.$eval('.insert-panel .snippet', (el) => (el.textContent || '').trim())
  check('UI：编辑改为右侧 60%', /!\[bg right:60%/.test(newSnippet), newSnippet)
  await page.click('.insert-panel .btn-primary')
  await sleep(600)

  let editedMd = ''
  for (let i = 0; i < 40; i++) {
    await sleep(300)
    const cur = await api(base, token, `/decks/${encodeURIComponent(deckId)}`)
    const content = cur.json?.content || ''
    if (/!\[bg right:60%/.test(content)) {
      editedMd = content
      break
    }
  }
  const bgLines = editedMd.split('\n').filter((l) => l.includes('![') && l.includes('bg'))
  check(
    'UI：保存后原位替换（`![bg right:60%]`，无新增图片行）',
    /!\[bg right:60%/.test(editedMd) && !editedMd.includes('bg left:40%') && bgLines.length === 1,
    JSON.stringify(bgLines)
  )
  check('UI：无页面 JS 错误', pageErrors.length === 0, pageErrors.join(' ; '))

  // 退出
  await api(base, token, '/shutdown', { method: 'POST' }).catch(() => null)
  await sleep(800)
} catch (err) {
  check('M3 E2E 执行', false, String(err?.stack || err))
} finally {
  try {
    await browser?.close()
  } catch {
    /* ignore */
  }
  try {
    imageServer?.close()
  } catch {
    /* ignore */
  }
  try {
    child?.kill()
  } catch {
    /* ignore */
  }
  if (dataDir) {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
  const failed = checks.filter((c) => !c.ok)
  fs.writeFileSync(path.join(outDir, 'm3-e2e-report.json'), JSON.stringify({ ok: failed.length === 0, checks }, null, 2))
  console.log(`\n[m3-e2e] ${checks.length - failed.length}/${checks.length} 通过`)
  if (failed.length) process.exit(1)
}

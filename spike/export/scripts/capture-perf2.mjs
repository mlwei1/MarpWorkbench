/**
 * CDP 截图性能对比 2：并发截图 + JPEG/PNG 编码代价。
 * 目标：评估「30 页 PPTX ≤30s」预算的可达路径。
 */
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const outDir = path.join(ROOT, 'out')
const inputFile = path.join(outDir, 'capture.html')
const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const killTree = (pid) => {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {}
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString())
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? p.reject(new Error(p.method + ': ' + msg.error.message)) : p.resolve(msg.result)
      }
    })
  }
  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(method + ' 超时'))
        }
      }, 60000)
    })
  }
}

const report = { variants: {} }
const profileDir = path.join(outDir, `profile-perf2-${Date.now().toString(36)}`)
fs.mkdirSync(profileDir, { recursive: true })
const child = spawn(
  chromePath,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    `--user-data-dir=${profileDir}`,
    '--disable-extensions',
    '--disable-sync',
    '--disable-background-networking',
    '--mute-audio',
    '--allow-file-access-from-files',
    '--hide-scrollbars',
    '--window-size=1280,720',
    pathToFileURL(inputFile).href
  ],
  { stdio: ['ignore', 'ignore', 'ignore'] }
)
let exited = false
child.on('exit', () => (exited = true))
try {
  const portFile = path.join(profileDir, 'DevToolsActivePort')
  let port = 0
  for (let i = 0; i < 400; i++) {
    if (fs.existsSync(portFile)) {
      const c = fs.readFileSync(portFile, 'utf8').split(/\r?\n/)
      if (/^\d+$/.test((c[0] || '').trim())) {
        port = Number(c[0].trim())
        break
      }
    }
    await sleep(50)
  }
  let target = null
  for (let i = 0; i < 300; i++) {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())
    target = list.find((t) => t.type === 'page' && /^file:/.test(t.url || '')) || list.find((t) => t.type === 'page')
    if (target?.webSocketDebuggerUrl) break
    await sleep(50)
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', () => rej(new Error('ws error')), { once: true })
    setTimeout(() => rej(new Error('ws timeout')), 10000)
  })
  const cdp = new Cdp(ws)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false })
  await cdp.send('Page.navigate', { url: pathToFileURL(inputFile).href })
  for (let i = 0; i < 400; i++) {
    const r = await cdp.send('Runtime.evaluate', { expression: 'window.__MWB_READY__ === true', returnByValue: true })
    if (r?.result?.value === true) break
    await sleep(50)
  }
  const rectsRes = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify([...document.querySelectorAll('div.marpit > svg[data-marpit-svg]')].map(s=>{const b=s.getBoundingClientRect();return {x:b.left+scrollX,y:b.top+scrollY,width:b.width,height:b.height}}))`,
    returnByValue: true
  })
  const rects = JSON.parse(rectsRes.result.value)

  async function measure(key, paramsFactory, concurrency) {
    // 预热一次（字体/栅格缓存），不计入
    await cdp.send('Page.captureScreenshot', paramsFactory(rects[0]))
    const t = Date.now()
    const per = []
    for (let i = 0; i < rects.length; i += concurrency) {
      const batch = []
      for (let j = i; j < Math.min(i + concurrency, rects.length); j++) {
        const t0 = Date.now()
        batch.push(
          cdp.send('Page.captureScreenshot', paramsFactory(rects[j])).then((res) => {
            const buf = Buffer.from(res.data, 'base64')
            per.push({ page: j + 1, ms: Date.now() - t0, bytes: buf.length })
          })
        )
      }
      await Promise.all(batch)
    }
    per.sort((a, b) => a.page - b.page)
    report.variants[key] = { totalMs: Date.now() - t, perPage: per }
  }

  const clip = (r, scale) => ({
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: true,
    clip: { x: r.x, y: r.y, width: r.width, height: r.height, scale }
  })

  await measure('A_seq_png', (r) => clip(r, 2), 1)
  await measure('E_par3_png', (r) => clip(r, 2), 3)
  await measure('F_par3_png_fast', (r) => ({ ...clip(r, 2), optimizeForSpeed: true }), 3)
  await measure(
    'G_par3_jpeg',
    (r) => ({
      format: 'jpeg',
      quality: 90,
      fromSurface: true,
      captureBeyondViewport: true,
      clip: { x: r.x, y: r.y, width: r.width, height: r.height, scale: 2 }
    }),
    3
  )
  report.ok = true
} catch (e) {
  report.error = String(e && e.message ? e.message : e)
} finally {
  if (!exited) killTree(child.pid)
  await sleep(500)
  try {
    fs.rmSync(profileDir, { recursive: true, force: true })
  } catch {}
}
fs.writeFileSync(path.join(outDir, 'capture-perf2.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))

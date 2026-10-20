/**
 * CDP 截图性能对比：找出满足「30 页 PPTX ≤30s」预算的截图方式。
 *
 * 变体：
 *  A. clip + captureBeyondViewport:true + scale:2（capture-cdp.mjs 当前做法）
 *  B. Emulation 设 deviceScaleFactor=2 + 逐页 scroll + 视口截图（无 clip）
 *  C. B + optimizeForSpeed:true
 *  D. B 但 format=jpeg quality=90（体积/速度参考，非默认）
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

function killTree(pid) {
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
        msg.error ? p.reject(new Error(`${p.method}: ${msg.error.message}`)) : p.resolve(msg.result)
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
          reject(new Error(`${method} 超时`))
        }
      }, 30000)
    })
  }
}
const pngSize = (b) => ({ w: b.readUInt32BE(16), h: b.readUInt32BE(20) })

const report = { variants: {} }
const tAll = Date.now()
const profileDir = path.join(outDir, `profile-perf-${Date.now().toString(36)}`)
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
  if (!port) throw new Error('DevToolsActivePort 未就绪')
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

  const waitReady = async () => {
    for (let i = 0; i < 400; i++) {
      const r = await cdp.send('Runtime.evaluate', { expression: 'window.__MWB_READY__ === true', returnByValue: true })
      if (r?.result?.value === true) return true
      await sleep(50)
    }
    throw new Error('ready timeout')
  }
  const getRects = async () => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: `JSON.stringify([...document.querySelectorAll('div.marpit > svg[data-marpit-svg]')].map(s=>{const b=s.getBoundingClientRect();return {x:b.left+scrollX,y:b.top+scrollY,width:b.width,height:b.height}}))`,
      returnByValue: true
    })
    return JSON.parse(r.result.value)
  }

  // 变体 A：clip + captureBeyondViewport + scale:2
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false })
  await cdp.send('Page.navigate', { url: pathToFileURL(inputFile).href })
  await waitReady()
  let rects = await getRects()
  {
    const t = Date.now()
    const per = []
    for (let i = 0; i < rects.length; i++) {
      const t0 = Date.now()
      const res = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: true,
        clip: { x: rects[i].x, y: rects[i].y, width: rects[i].width, height: rects[i].height, scale: 2 }
      })
      const buf = Buffer.from(res.data, 'base64')
      fs.writeFileSync(path.join(outDir, `perfA-slide-${i + 1}.png`), buf)
      per.push({ ms: Date.now() - t0, bytes: buf.length, ...pngSize(buf) })
    }
    report.variants.A = { totalMs: Date.now() - t, perPage: per }
  }

  // 变体 B/C：deviceScaleFactor=2 + 逐页 scroll + 视口截图
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 2, mobile: false })
  await cdp.send('Runtime.evaluate', { expression: 'window.scrollTo(0,0)' })
  await sleep(100)
  for (const variant of [
    { key: 'B', params: { format: 'png', fromSurface: true } },
    { key: 'C', params: { format: 'png', fromSurface: true, optimizeForSpeed: true } },
    { key: 'D', params: { format: 'jpeg', quality: 90, fromSurface: true } }
  ]) {
    const t = Date.now()
    const per = []
    for (let i = 0; i < rects.length; i++) {
      await cdp.send('Runtime.evaluate', { expression: `window.scrollTo(0, ${rects[i].y})` })
      await sleep(60)
      const t0 = Date.now()
      const res = await cdp.send('Page.captureScreenshot', variant.params)
      const buf = Buffer.from(res.data, 'base64')
      const ext = variant.key === 'D' ? 'jpg' : 'png'
      fs.writeFileSync(path.join(outDir, `perf${variant.key}-slide-${i + 1}.${ext}`), buf)
      per.push({ ms: Date.now() - t0, bytes: buf.length, ...pngSize(buf) })
    }
    report.variants[variant.key] = { totalMs: Date.now() - t, perPage: per }
  }

  ws.close()
  report.ok = true
  report.totalMs = Date.now() - tAll
} catch (e) {
  report.error = String(e && e.message ? e.message : e)
} finally {
  if (!exited) killTree(child.pid)
  await sleep(500)
  try {
    fs.rmSync(profileDir, { recursive: true, force: true })
  } catch {}
}
fs.writeFileSync(path.join(outDir, 'capture-perf.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))

/**
 * CDP 原生截图（PPTX/PNG 主通道）原始协议验证脚本。
 * 目的：在 Rust（tungstenite）实现前，用同一套 CDP 命令序列验证可行性/质量/耗时。
 *
 * 复现：node scripts/capture-cdp.mjs [--in=out/capture.html] [--scale=2]
 * 产物：out/cdp-slide-N.png（2560×1440）+ out/cdp-report.json
 *
 * CDP 步骤（Rust 实现逐条对应）：
 *   1. 启动 Chrome：--headless=new --remote-debugging-port=0 --user-data-dir=<tmp>
 *   2. 读 <user-data-dir>/DevToolsActivePort（第 1 行端口）
 *   3. HTTP GET http://127.0.0.1:<port>/json/list → page target 的 webSocketDebuggerUrl
 *   4. WebSocket 连接，发 Page.enable / Emulation.setDeviceMetricsOverride
 *   5. Page.navigate(file://...) → 轮询 Runtime.evaluate(window.__MWB_READY__)
 *   6. Runtime.evaluate 取每页 svg 的 document 坐标与尺寸
 *   7. 逐页 Page.captureScreenshot { clip:{x,y,width,height,scale}, captureBeyondViewport:true }
 */
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const outDir = path.join(ROOT, 'out')
fs.mkdirSync(outDir, { recursive: true })

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const inputFile = path.resolve(arg('in', path.join(outDir, 'capture.html')))
const scale = Number(arg('scale', '2'))
const chromePath = arg('chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
const timeoutMs = Number(arg('timeout', '30000'))
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
    this.events = []
    ws.addEventListener('message', (ev) => {
      let msg
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString())
      } catch {
        return
      }
      if (msg.id) {
        const p = this.pending.get(msg.id)
        if (p) {
          this.pending.delete(msg.id)
          msg.error ? p.reject(new Error(`${p.method}: ${msg.error.message}`)) : p.resolve(msg.result)
        }
      } else {
        this.events.push(msg)
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
      }, 15000)
    })
  }
}

function pngSize(buf) {
  // PNG IHDR: width 16..20, height 20..24 (big endian)
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
}

const report = { ok: false, inputFile, scale, steps: {} }
const t0 = Date.now()
const profileDir = path.join(outDir, `profile-cdp-${Date.now().toString(36)}`)
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
  { stdio: ['ignore', 'pipe', 'pipe'] }
)
let stderr = ''
child.stderr.on('data', (d) => (stderr += d.toString().slice(0, 2000)))
let exited = false
child.on('exit', () => (exited = true))

try {
  // 1) DevToolsActivePort
  const portFile = path.join(profileDir, 'DevToolsActivePort')
  const tWait = Date.now()
  while (Date.now() - tWait < 20000) {
    if (fs.existsSync(portFile)) {
      const content = fs.readFileSync(portFile, 'utf8').split(/\r?\n/)
      if (content[0] && /^\d+$/.test(content[0].trim())) {
        report.steps.devToolsActivePortMs = Date.now() - tWait
        report.steps.port = Number(content[0].trim())
        break
      }
    }
    if (exited) throw new Error(`Chrome 启动即退出: ${stderr.slice(0, 500)}`)
    await sleep(50)
  }
  if (!report.steps.port) throw new Error('DevToolsActivePort 未就绪')
  const port = report.steps.port

  // 2) /json/list 找 page target
  const tList = Date.now()
  let target = null
  while (Date.now() - tList < 15000) {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())
    target = list.find((t) => t.type === 'page' && /^file:/.test(t.url || '')) || list.find((t) => t.type === 'page')
    if (target?.webSocketDebuggerUrl) break
    await sleep(50)
  }
  if (!target?.webSocketDebuggerUrl) throw new Error('/json/list 未找到 page target')
  report.steps.targetUrl = target.url
  report.steps.targetMs = Date.now() - tList

  // 3) WebSocket 连接
  const tWs = Date.now()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', (e) => reject(new Error(`WebSocket 连接失败: ${e.message || 'error'}`)), {
      once: true
    })
    setTimeout(() => reject(new Error('WebSocket 连接超时')), 10000)
  })
  const cdp = new Cdp(ws)
  report.steps.wsConnectMs = Date.now() - tWs

  const tCmd = Date.now()
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false
  })
  report.steps.pageEnableMs = Date.now() - tCmd

  // 4) navigate + 等 __MWB_READY__
  const tNav = Date.now()
  await cdp.send('Page.navigate', { url: pathToFileURL(inputFile).href })
  let ready = false
  let readyAttempts = 0
  while (Date.now() - tNav < timeoutMs) {
    readyAttempts++
    try {
      const r = await cdp.send('Runtime.evaluate', {
        expression: 'window.__MWB_READY__ === true',
        returnByValue: true
      })
      if (r?.result?.value === true) {
        ready = true
        break
      }
    } catch {}
    await sleep(50)
  }
  report.steps.navigateAndReadyMs = Date.now() - tNav
  report.steps.readyAttempts = readyAttempts
  if (!ready) throw new Error('等待 window.__MWB_READY__ 超时')

  // 5) 取每页 svg 的 document 坐标/尺寸
  const rectsRes = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify([...document.querySelectorAll('div.marpit > svg[data-marpit-svg]')].map(function(s){
      var r = s.getBoundingClientRect();
      return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
    }))`,
    returnByValue: true
  })
  const rects = JSON.parse(rectsRes.result.value)
  report.slides = rects.length
  report.rects = rects.map((r) => ({
    x: +r.x.toFixed(2),
    y: +r.y.toFixed(2),
    width: +r.width.toFixed(2),
    height: +r.height.toFixed(2)
  }))

  // 6) 逐页截图
  const images = []
  const tCap = Date.now()
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]
    const tl = Date.now()
    const res = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: true,
      clip: {
        x: r.x,
        y: r.y,
        width: r.width || 1280,
        height: r.height || 720,
        scale
      }
    })
    const buf = Buffer.from(res.data, 'base64')
    const file = path.join(outDir, `cdp-slide-${i + 1}.png`)
    fs.writeFileSync(file, buf)
    const size = pngSize(buf)
    images.push({
      index: i,
      file: path.relative(ROOT, file),
      bytes: buf.length,
      w: size.w,
      h: size.h,
      ms: Date.now() - tl
    })
  }
  report.steps.captureTotalMs = Date.now() - tCap
  report.images = images

  ws.close()
  report.ok = true
  report.totalMs = Date.now() - t0
} catch (err) {
  report.error = String(err && err.message ? err.message : err)
  report.stderr = stderr.slice(0, 1500)
} finally {
  if (!exited) killTree(child.pid)
  await new Promise((r) => {
    if (exited) r()
    else {
      child.on('exit', r)
      setTimeout(r, 3000)
    }
  })
  try {
    fs.rmSync(profileDir, { recursive: true, force: true })
  } catch {}
}

fs.writeFileSync(path.join(outDir, 'cdp-report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
if (!report.ok) process.exit(1)

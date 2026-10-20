#!/usr/bin/env node
/**
 * M3 验收（Lead）：真实 exe（内嵌资源）+ 系统 Chrome + puppeteer-core。
 *
 * 覆盖：
 *  1) Mermaid：```mermaid 代码块渲染为 SVG（2 张图）、错误块保留代码并提示、无图 deck 不加载 graph bundle
 *  2) 网络图片：老 md 里的 http(s) 图片 → 预览走同源代理显示；Banner 一键下载到本地并重写 Markdown
 *  3) 图片原位编辑：光标停在已有图片行 → 图片按钮进入「编辑图片」→ 修改属性 → 原位替换（不新增行）
 *  4) 导出：含 mermaid 图的 deck 导出 PDF（页数正确，说明 mermaid 已进入导出产物）
 *  5) 零外网请求 / 无 JS 错误
 *
 * 用法：node scripts/visual-e2e-m3.mjs [--keep]
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve('.')
const args = process.argv.slice(2)
const keep = args.includes('--keep')
const require = createRequire(join(ROOT, 'spike/marp/package.json'))
const puppeteer = require('puppeteer-core')

const exe = join(ROOT, 'server/target/release/MarpWorkbench.exe')
const chrome = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p))
if (!existsSync(exe) || !chrome) {
  console.error(`缺少 exe(${exe}) 或 Chrome/Edge`)
  process.exit(1)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const shotDir = join(ROOT, 'spike/visual-m3', stamp)
mkdirSync(shotDir, { recursive: true })
const dataDir = mkdtempSync(join(tmpdir(), 'mwb-m3-'))

// ---- 假“远程图床”：127.0.0.1 上的一张 png（exe 以 MWB_PROXY_ALLOW_PRIVATE=1 启动） ----
const photo = readFileSync(join(ROOT, 'scripts/fixtures/test-photo.png'))
let upstreamHits = 0
const imgServer = createServer((req, res) => {
  if (req.url?.split('?')[0] === '/photo.png') {
    upstreamHits++
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': photo.length })
    res.end(photo)
  } else {
    res.writeHead(404).end('not found')
  }
})
await new Promise((r) => imgServer.listen(0, '127.0.0.1', r))
const imgPort = imgServer.address().port
const remoteUrl = `http://127.0.0.1:${imgPort}/photo.png`

const child = spawn(exe, [], {
  env: { ...process.env, MWB_DATA_DIR: dataDir, MWB_NO_OPEN: '1', MWB_PROXY_ALLOW_PRIVATE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let out = ''
child.stdout.on('data', (d) => (out += d))
child.stderr.on('data', (d) => (out += d))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const log = (...a) => console.log(...a)
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
  return ok
}

async function waitBase() {
  for (let i = 0; i < 400; i++) {
    const mUrl = out.match(/MWB_LISTEN_URL=(\S+)/)
    const mTok = out.match(/MWB_TOKEN=(\S+)/)
    if (mUrl && mTok) return { base: mUrl[1], token: mTok[1] }
    await sleep(100)
  }
  throw new Error('服务启动超时: ' + out.slice(-900))
}

const SIMPLE_MD = ['---', 'marp: true', 'theme: minimal-gray', 'size: 16:9', '---', '', '# 无图表 deck', '', '这是普通内容，不需要 mermaid。'].join('\n')

const MAIN_MD = [
  '---',
  'marp: true',
  'theme: business-blue',
  'paginate: true',
  'size: 16:9',
  '---',
  '',
  '# M3 功能验证',
  '',
  '## 图表 / 网络图片 / 图片编辑',
  '',
  '---',
  '',
  '## Mermaid 流程图',
  '',
  '```mermaid',
  'graph LR',
  '  A[开始] --> B{判断}',
  '  B -->|是| C[完成]',
  '  B -->|否| D[重试]',
  '```',
  '',
  '---',
  '',
  '## Mermaid 时序图',
  '',
  '```mermaid',
  'sequenceDiagram',
  '  用户->>编辑器: 写 mermaid',
  '  编辑器->>预览: SVG 渲染',
  '```',
  '',
  '---',
  '',
  '## 网络图片（老 md 写法）',
  '',
  `![网络图片](${remoteUrl})`,
  '',
  '---',
  '',
  '## 错误图表（应保留代码块）',
  '',
  '```mermaid',
  'this is not a valid mermaid diagram',
  '```',
  '',
  '---',
  '',
  '## 普通页',
  '',
  '- 内容一',
  '- 内容二',
].join('\n')

let browser
try {
  const { base, token } = await waitBase()
  check('exe 启动（含 mermaid bundle / proxy 路由）', true, base)

  const api = async (path, init = {}) => {
    const res = await fetch(`${base}/api${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', 'X-MWB-Token': token, ...(init.headers || {}) },
    })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* ignore */
    }
    return { status: res.status, json, text }
  }
  const createDeck = async (name, content) => {
    const c = await api('/decks', { method: 'POST', body: JSON.stringify({ name, template: 'blank' }) })
    const id = c.json?.id
    await api(`/decks/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ content }) })
    return id
  }
  const getMd = async (id) => (await api(`/decks/${encodeURIComponent(id)}`)).json?.content || ''

  const simpleId = await createDeck('M3-无图表-deck', SIMPLE_MD)
  const mainId = await createDeck('M3-验收-演示', MAIN_MD)
  check('创建测试 deck（无图表 / 主 deck）', !!simpleId && !!mainId, `${simpleId} / ${mainId}`)

  browser = await puppeteer.launch({
    executablePath: chrome,
    headless: 'new',
    args: ['--window-size=1680,1050', '--force-device-scale-factor=1', '--hide-scrollbars'],
  })

  const newTrackedPage = async () => {
    const page = await browser.newPage()
    await page.setViewport({ width: 1680, height: 1050 })
    const state = { errors: [], external: [], requests: [], mermaidLoaded: 0, resource404: [] }
    page.on('pageerror', (e) => state.errors.push(String(e)))
    page.on('console', (m) => {
      if (m.type() === 'error') state.errors.push(m.text())
    })
    page.on('request', (req) => {
      const u = req.url()
      state.requests.push(u)
      if (u.includes('mermaid.browser.js')) state.mermaidLoaded++
      if (!/^(https?:)\/\/(127\.0\.0\.1|localhost)/.test(u) && !u.startsWith('data:') && !u.startsWith('blob:')) {
        state.external.push(u)
      }
    })
    page.on('response', (res) => {
      if (res.status() === 404) state.resource404.push(res.url())
    })
    return { page, state }
  }

  const clickButtonByText = async (page, text, scope = 'body') =>
    page.evaluate(
      ({ text, scope }) => {
        const root = document.querySelector(scope) || document.body
        const el = [...root.querySelectorAll('button, a')].find((b) => b.textContent.trim() === text || b.textContent.includes(text))
        if (!el) return false
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        return true
      },
      { text, scope },
    )

  /** 点 CodeMirror 里包含指定文字的某一行（返回是否成功） */
  const clickEditorLine = async (page, needle) => {
    const rect = await page.evaluate((needle) => {
      const lines = [...document.querySelectorAll('.cm-line')]
      const line = lines.find((l) => l.textContent.includes(needle))
      if (!line) return null
      line.scrollIntoView({ block: 'center' })
      const r = line.getBoundingClientRect()
      return { x: r.x + Math.min(160, r.width / 2), y: r.y + r.height / 2 }
    }, needle)
    if (!rect) return false
    await page.mouse.click(rect.x, rect.y)
    await sleep(350)
    return true
  }

  // ======================= 1. 无图表 deck 不加载 mermaid =======================
  const p1 = await newTrackedPage()
  await p1.page.goto(`${base}/edit/${encodeURIComponent(simpleId)}?token=${token}`, { waitUntil: 'networkidle2', timeout: 60000 })
  await p1.page.waitForFunction(() => document.querySelectorAll('iframe.preview-frame, .preview-frame').length > 0, { timeout: 30000 }).catch(() => {})
  await sleep(3500)
  check('无图表 deck：不加载 mermaid.browser.js', p1.state.mermaidLoaded === 0, `requests=${p1.state.requests.filter((u) => u.includes('mermaid')).length}`)
  await p1.page.close()

  // ======================= 2. Mermaid 渲染 + 错误块 + 懒加载 =======================
  const { page, state } = await newTrackedPage()
  await page.goto(`${base}/edit/${encodeURIComponent(mainId)}?token=${token}`, { waitUntil: 'networkidle2', timeout: 60000 })
  await page.waitForFunction(() => document.querySelectorAll('iframe.preview-frame').length > 0, { timeout: 30000 })

  const previewFrame = async () => {
    for (const f of page.frames()) {
      if (f === page.mainFrame()) continue
      return f
    }
    return null
  }
  let mermaidInfo = { blocks: 0, errors: 0, imgs: [] }
  for (let i = 0; i < 60; i++) {
    await sleep(500)
    const frame = await previewFrame()
    if (!frame) continue
    mermaidInfo = await frame.evaluate(() => ({
      blocks: document.querySelectorAll('.mwb-mermaid svg').length,
      errors: document.querySelectorAll('.mwb-mermaid-error').length,
      imgs: [...document.querySelectorAll('img')].map((i) => ({ src: i.src, w: i.naturalWidth })),
    })).catch(() => mermaidInfo)
    if (mermaidInfo.blocks >= 2 && mermaidInfo.errors >= 1) break
  }
  check('Mermaid：2 张图渲染为 SVG', mermaidInfo.blocks >= 2, `blocks=${mermaidInfo.blocks}`)
  check('Mermaid：非法语法保留代码块 + 错误提示', mermaidInfo.errors >= 1, `errors=${mermaidInfo.errors}`)
  check('Mermaid：bundle 懒加载恰好触发', state.mermaidLoaded >= 1 && state.mermaidLoaded <= 3, `loads=${state.mermaidLoaded}`)

  // ======================= 3. 网络图片：代理显示 =======================
  const proxyImg = mermaidInfo.imgs.find((i) => i.src.includes('/api/proxy/image') && i.w > 0)
  check('网络图片：预览经同源代理显示', !!proxyImg, proxyImg ? `${Math.round(proxyImg.w)}px ${proxyImg.src.slice(0, 60)}…` : '')
  await page.screenshot({ path: join(shotDir, '01-mermaid-preview.png') })

  // ======================= 4. 网络图片：Banner 一键本地化 =======================
  await page.waitForSelector('.mwb-remote-banner', { timeout: 20000 }).catch(() => {})
  const bannerText = await page.evaluate(() => document.querySelector('.mwb-remote-banner')?.innerText || '')
  check('网络图片：Banner 提示检测到网络图片', /网络图片/.test(bannerText), bannerText.replace(/\n/g, ' ').slice(0, 60))
  await page.screenshot({ path: join(shotDir, '02-remote-banner.png') })
  const clickedDownload = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.mwb-remote-banner button')].find((b) => b.textContent.includes('下载到本地'))
    if (!btn) return false
    btn.click()
    return true
  })
  await sleep(1200)
  let mdAfterLocalize = ''
  for (let i = 0; i < 30; i++) {
    await sleep(500)
    mdAfterLocalize = await getMd(mainId)
    if (/assets\/remote-[^)\s]+/.test(mdAfterLocalize) && !mdAfterLocalize.includes(imgPort + '/photo.png')) break
  }
  check(
    '网络图片：一键下载并重写 Markdown',
    clickedDownload && /assets\/remote-[^)\s]+/.test(mdAfterLocalize),
    mdAfterLocalize.match(/assets\/remote-[^)\s]+/)?.[0] || '',
  )
  check('网络图片：原始 URL 已被替换', !mdAfterLocalize.includes(`${imgPort}/photo.png`))
  // 等待 Banner 消失 + 本地图正常显示
  let localImgOk = false
  for (let i = 0; i < 20; i++) {
    await sleep(500)
    const frame = await previewFrame()
    if (!frame) continue
    const info = await frame.evaluate(() => ({
      banner: !!document.querySelector('.mwb-remote-banner'),
      imgs: [...document.querySelectorAll('img')].map((i) => ({ src: i.src, w: i.naturalWidth })),
    })).catch(() => null)
    if (info && info.imgs.some((i) => i.w > 0)) {
      localImgOk = true
      break
    }
  }
  check('网络图片：本地化后预览正常', localImgOk)
  await page.screenshot({ path: join(shotDir, '03-after-localize.png') })

  // ======================= 5. 图片原位编辑（普通图） =======================
  const clickImgLine = await clickEditorLine(page, 'assets/remote-')
  const openImgDialog = await clickButtonByText(page, '🖼 图片')
  await page.waitForSelector('.modal-panel', { timeout: 15000 })
  await sleep(1200)
  const editInfo = await page.evaluate(() => {
    const dialog = [...document.querySelectorAll('.modal-panel')].find((d) => d.textContent.includes('图片'))
    if (!dialog) return null
    return { title: dialog.querySelector('h2')?.textContent || '', text: dialog.innerText.slice(0, 120) }
  })
  check('图片原位编辑：光标在图片行 → 打开「编辑图片」', clickImgLine && openImgDialog && /编辑图片/.test(editInfo?.title || ''), editInfo?.title || '')
  await page.screenshot({ path: join(shotDir, '04-image-edit-dialog.png') })
  // 改宽度为 50% 后保存
  const changedWidth = await page.evaluate(() => {
    const dialog = [...document.querySelectorAll('.modal-panel')].find((d) => d.textContent.includes('编辑图片') || d.textContent.includes('保存修改'))
    if (!dialog) return false
    const selects = [...dialog.querySelectorAll('select')]
    // 宽度 select：选项含 “原图”/“50%”
    const widthSel = selects.find((s) => [...s.options].some((o) => o.textContent.includes('原图')))
    if (!widthSel) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
    setter.call(widthSel, '50')
    widthSel.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })
  await sleep(600)
  const saveImg = await page.evaluate(() => {
    const dialog = [...document.querySelectorAll('.modal-panel')].find((d) => d.textContent.includes('保存修改'))
    const btn = dialog && [...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === '保存修改')
    if (!btn) return false
    btn.click()
    return true
  })
  await sleep(2500)
  const mdAfterImgEdit = await getMd(mainId)
  const imageLines = mdAfterImgEdit.split(/\r?\n/).filter((l) => /!\[[^\]]*\]\([^)]*\)/.test(l))
  const imgLine = imageLines.find((l) => l.includes('assets/remote-')) || ''
  check('图片原位编辑：保存后原位替换（行数不变、宽度生效）', changedWidth && saveImg && imageLines.length === 1 && /w:\d+px/.test(imgLine), `${imageLines.length} 行：${imgLine.trim()}`)
  await page.screenshot({ path: join(shotDir, '05-image-edited.png') })

  // ======================= 6. 图片原位编辑（背景图左右占比） =======================
  const assetPath = (mdAfterImgEdit.match(/!\[[^\]]*\]\((assets\/[^)\s]+)\)/) || [])[1]
  const mdWithBg = [
    mdAfterImgEdit,
    '',
    '---',
    '',
    '## 背景图页',
    '',
    `![bg left:40%](${assetPath})`,
    '',
    '- 左侧背景，右侧文字',
    '',
  ].join('\n')
  await api(`/decks/${encodeURIComponent(mainId)}`, { method: 'PUT', body: JSON.stringify({ content: mdWithBg }) })
  await page.goto(`${base}/edit/${encodeURIComponent(mainId)}?token=${token}`, { waitUntil: 'networkidle2', timeout: 60000 })
  await page.waitForFunction(() => document.querySelectorAll('iframe.preview-frame').length > 0, { timeout: 30000 })
  await sleep(3000)
  // 跳到背景图页（点击大纲里“背景图页”或直接点缩略图）
  await page.evaluate(() => {
    const items = [...document.querySelectorAll('.sn-outline-item')]
    const target = items.find((el) => el.textContent.includes('背景图页'))
    if (target) target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await sleep(1200)
  const clickBgLine = await clickEditorLine(page, '![bg')
  const openBgDialog = await clickButtonByText(page, '🖼 图片')
  await page.waitForSelector('.modal-panel', { timeout: 15000 })
  await sleep(1200)
  const bgDialogInfo = await page.evaluate(() => {
    const dialog = [...document.querySelectorAll('.modal-panel')].find((d) => d.textContent.includes('保存修改'))
    if (!dialog) return null
    const ranges = [...dialog.querySelectorAll('input[type=range]')].map((r) => r.value)
    const segActive = [...dialog.querySelectorAll('button')].filter((b) => b.className.includes('active')).map((b) => b.textContent.trim())
    return { title: dialog.querySelector('h2')?.textContent || '', ranges, segActive }
  })
  check('背景图编辑：打开编辑模式且预填 左 40%', clickBgLine && openBgDialog && /编辑图片/.test(bgDialogInfo?.title || '') && (bgDialogInfo?.segActive || []).some((t) => t.includes('背景')), JSON.stringify(bgDialogInfo))
  await page.screenshot({ path: join(shotDir, '06-bg-edit-dialog.png') })
  // 改为右侧 60%
  const switchRight = await page.evaluate(() => {
    const dialog = [...document.querySelectorAll('.modal-panel')].find((d) => d.textContent.includes('保存修改'))
    if (!dialog) return false
    const btn = [...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === '右侧')
    if (!btn) return false
    btn.click()
    return true
  })
  await sleep(500)
  const setRatio = await page.evaluate(() => {
    const dialog = [...document.querySelectorAll('.modal-panel')].find((d) => d.textContent.includes('保存修改'))
    if (!dialog) return false
    const range = [...dialog.querySelectorAll('input[type=range]')].find((r) => (r.closest('label') || r.parentElement)?.textContent.includes('占比'))
    if (!range) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(range, '60')
    range.dispatchEvent(new Event('input', { bubbles: true }))
    range.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })
  await sleep(600)
  const saveBg = await page.evaluate(() => {
    const dialog = [...document.querySelectorAll('.modal-panel')].find((d) => d.textContent.includes('保存修改'))
    const btn = dialog && [...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === '保存修改')
    if (!btn) return false
    btn.click()
    return true
  })
  await sleep(2500)
  const mdAfterBg = await getMd(mainId)
  const bgLines = mdAfterBg.split(/\r?\n/).filter((l) => /!\[bg/.test(l))
  check('背景图编辑：右侧 60% 原位替换', switchRight && setRatio && saveBg && bgLines.some((l) => /!\[bg right:60%\]/.test(l)) && bgLines.length === 1, bgLines.join(' | ').trim())
  await page.screenshot({ path: join(shotDir, '07-bg-edited.png') })

  // ======================= 7. 导出 PDF（含 mermaid） =======================
  const downloadDir = join(shotDir, 'downloads')
  mkdirSync(downloadDir, { recursive: true })
  const cdp = await page.createCDPSession()
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir })
  await clickButtonByText(page, '导出')
  await page.waitForSelector('.modal-panel', { timeout: 15000 })
  await sleep(800)
  await page.evaluate(() => {
    const dialog = [...document.querySelectorAll('.modal-panel')].find((d) => d.textContent.includes('导出'))
    const pdf = dialog && [...dialog.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('PDF'))
    if (pdf) pdf.click()
  })
  await sleep(500)
  const exportClicked = await page.evaluate(() => {
    const dialog = [...document.querySelectorAll('.modal-panel')].find((d) => d.textContent.includes('导出'))
    const btn = dialog && [...dialog.querySelectorAll('button')].find((b) => /^导出 PDF$/.test(b.textContent.trim()) || /^导出 PPTX$/.test(b.textContent.trim()))
    if (!btn) return false
    btn.click()
    return true
  })
  let pdfFile = null
  for (let i = 0; i < 90; i++) {
    await sleep(1000)
    const files = readdirSync(downloadDir).filter((f) => f.toLowerCase().endsWith('.pdf'))
    if (files.length) {
      const p = join(downloadDir, files[0])
      if (statSync(p).size > 20000) {
        pdfFile = p
        break
      }
    }
  }
  let pdfPages = 0
  if (pdfFile) {
    const buf = readFileSync(pdfFile)
    const text = buf.toString('latin1')
    pdfPages = (text.match(/\/Type\s*\/Page[^s]/g) || []).length
  }
  // 页数 = front-matter 2 条 --- + (页数-1) 条分页线 → 总 --- 行数 - 1
  const expectedPages = (mdAfterBg.match(/^---$/gm) || []).length - 1
  check('导出 PDF：含 mermaid 的 deck 导出成功', exportClicked && !!pdfFile, pdfFile ? `${pdfFile.split('\\').pop()} ${(statSync(pdfFile).size / 1024).toFixed(0)}KB` : '')
  check('导出 PDF：页数与 deck 一致', pdfPages === expectedPages, `pdf=${pdfPages} expect=${expectedPages}`)
  await page.screenshot({ path: join(shotDir, '08-export-done.png') })

  // ======================= 8. 错误/外网 =======================
  const jsErrors = state.errors.filter((e) => !/Failed to load resource/.test(e))
  check('无前端 JS 错误', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '))
  check('无 404 资源', state.resource404.length === 0, state.resource404.slice(0, 4).join(' | '))
  check('零外网请求', state.external.length === 0, state.external.slice(0, 4).join(' | '))
  check('代理图床被访问（本地假远程）', upstreamHits >= 1, `hits=${upstreamHits}`)

  log(`\n截图目录: ${shotDir}`)
  log(`数据目录: ${dataDir}`)
} catch (e) {
  check('M3 E2E 执行', false, String(e?.stack || e))
} finally {
  if (browser) await browser.close().catch(() => {})
  child.kill()
  imgServer.close()
  if (!keep) {
    /* 截图/数据目录保留在本地便于排查（gitignore） */
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n[M3-E2E] ${results.length - failed.length}/${results.length} 通过`)
  process.exit(failed.length ? 1 : 0)
}
